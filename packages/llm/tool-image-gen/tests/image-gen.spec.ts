/**
 * image_gen tool behavior: disabled-by-default (tool absent), enabled happy
 * path that resolves the shared Grok credential, calls the Imagine API through
 * an injected fetch, and writes the deterministic workspace file, an auth
 * failure that surfaces as a tool error without exposing the token, and unit
 * coverage for the argument validation and presentation helpers.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import { CallId } from '@shres-code/shres-code-llm'
import GrokCredential from '@shres-code/shres-code-grok-credential'
import * as ToolImageGen from '../src/index.ts'

const ENTRY_KEY = 'https://auth.x.ai::test-client'

/** A far-future access token so the manager never refreshes over the network. */
function farFutureToken(): string {
  const enc = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const exp = Math.floor((Date.now() + 6 * 3600_000) / 1000)
  return [enc({ alg: 'ES256', typ: 'at+jwt' }), enc({ exp }), 'signature'].join('.')
}

interface AuthDoc { path: string; token: string }

/** Write an owner-only auth document and return its path and the token it holds. */
async function writeAuth(): Promise<AuthDoc> {
  const dir = await mkdtemp(join(tmpdir(), 'tool-image-gen-'))
  const token = farFutureToken()
  const path = join(dir, 'auth.json')
  await writeFile(path, JSON.stringify({ [ENTRY_KEY]: { key: token, refresh_token: 'r', expires_at: new Date(Date.now() + 6 * 3600_000).toISOString(), oidc_client_id: 'test-client' } }), { mode: 0o600 })
  return { path, token }
}

interface GenerationRequest {
  url: string
  auth: string
  body: { model: string; prompt: string; aspect_ratio: string }
}

/** A generation-response fetch stub that records requests. */
function generationFetch(): { fetch: typeof fetch; requests: GenerationRequest[] } {
  const requests: GenerationRequest[] = []
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as GenerationRequest['body']) : { model: '', prompt: '', aspect_ratio: '' }
    requests.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      auth: new Headers(init?.headers).get('authorization') ?? '',
      body,
    })
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetch: fetchImpl, requests }
}

/** A fetch stub that rejects the subscription credential. */
function authFailureFetch(): typeof fetch {
  return async () => new Response(JSON.stringify({ error: { message: 'unauthorized' } }), { status: 401 })
}

describe('image_gen tool', () => {
  const dirs: string[] = []
  let fiber: { dispose(): unknown } | undefined

  afterEach(async () => {
    await fiber?.dispose()
    fiber = undefined
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'tool-image-gen-out-'))
    dirs.push(dir)
    return dir
  }

  async function baseContext(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(GrokCredential)
    return ctx
  }

  const newSignal = (): AbortSignal => new AbortController().signal
  const call = (ctx: Context, id: string, args: unknown) => ctx.tools.execute({ signal: newSignal(), callId: CallId(id), name: 'image_gen', arguments: args })

  it('does not register the tool when disabled by default', async () => {
    const ctx = await baseContext()
    fiber = await ctx.plugin(ToolImageGen, {})
    expect(ctx.tools.get('image_gen')).toBeUndefined()
  })

  it('registers the tool when enabled', async () => {
    const ctx = await baseContext()
    fiber = await ctx.plugin(ToolImageGen, { enabled: true, authPath: (await writeAuth()).path })
    expect(ctx.tools.get('image_gen')).toBeDefined()
  })

  it('resolves the session credential, generates, and writes the deterministic file', async () => {
    const ctx = await baseContext()
    const auth = await writeAuth()
    const outDir = await tempDir()
    const gen = generationFetch()
    ToolImageGen.applyImageGenTool(
      ctx,
      ToolImageGen.resolveConfig({ enabled: true, authPath: auth.path, outputDirectory: outDir }),
      gen.fetch,
    )

    const result = await call(ctx, 'call-1', { prompt: 'a red cat', aspect_ratio: '16:9' })

    expect(result.isError).toBe(false)
    expect(existsSync(join(outDir, 'image-1.jpg'))).toBe(true)
    expect(await readFile(join(outDir, 'image-1.jpg'))).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    expect(gen.requests).toHaveLength(1)
    expect(gen.requests[0]!.url).toBe('https://api.x.ai/v1/images/generations')
    expect(gen.requests[0]!.auth).toBe('Bearer ' + auth.token)
    expect(gen.requests[0]!.body).toMatchObject({ model: 'grok-imagine-image-quality', prompt: 'a red cat', aspect_ratio: '16:9' })
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('Saved generated image to')
    expect(text).toContain(join(outDir, 'image-1.jpg'))
  })

  it('surfaces an auth failure without exposing the token', async () => {
    const ctx = await baseContext()
    const auth = await writeAuth()
    const outDir = await tempDir()
    ToolImageGen.applyImageGenTool(
      ctx,
      ToolImageGen.resolveConfig({ enabled: true, authPath: auth.path, outputDirectory: outDir }),
      authFailureFetch(),
    )

    const result = await call(ctx, 'call-1', { prompt: 'a cat' })

    expect(result.isError).toBe(true)
    const message = 'error' in result ? result.error.message : JSON.stringify(result.content)
    expect(message).toContain('401')
    expect(message).not.toContain(auth.token)
  })
})

describe('image_gen helpers', () => {
  it('parseImageGenArgs trims a prompt and defaults the aspect ratio to auto', () => {
    expect(ToolImageGen.parseImageGenArgs({ prompt: '  a cat  ' })).toEqual({ prompt: 'a cat', aspectRatio: 'auto' })
  })

  it('parseImageGenArgs rejects a blank prompt', () => {
    expect(() => ToolImageGen.parseImageGenArgs({ prompt: '   ' })).toThrow(/prompt must be a non-empty string/u)
  })

  it('parseImageGenArgs rejects an unknown aspect ratio', () => {
    expect(() => ToolImageGen.parseImageGenArgs({ prompt: 'a cat', aspect_ratio: 'square' })).toThrow(/unknown aspect_ratio/u)
  })

  it('presentImageGenCall returns a generic card', () => {
    expect(ToolImageGen.presentImageGenCall({ prompt: 'a cat' })).toEqual({ card: 'generic', title: 'Generate image', kind: 'other', rawInput: 'a cat' })
  })

  it('presentImageGenResult distinguishes success from failure', () => {
    expect(ToolImageGen.presentImageGenResult({ prompt: 'a cat' }, { content: [], isError: false })).toEqual({ card: 'generic', title: 'Image generated' })
    expect(ToolImageGen.presentImageGenResult({ prompt: 'a cat' }, { content: [], isError: true })).toEqual({ card: 'generic', title: 'Image generation failed' })
  })

  it('formatImageGenOutput covers the attachment branches', () => {
    expect(ToolImageGen.formatImageGenOutput({ filePath: '/x/image-1.jpg', attachmentId: null, mediaType: 'image/jpeg', aspectRatio: 'auto', model: 'm' })).toBe('Saved generated image to /x/image-1.jpg.')
    expect(ToolImageGen.formatImageGenOutput({ filePath: '/x/image-1.jpg', attachmentId: 'att-1', mediaType: 'image/jpeg', aspectRatio: 'auto', model: 'm' })).toBe('Saved generated image to /x/image-1.jpg (attachment att-1).')
  })
})
