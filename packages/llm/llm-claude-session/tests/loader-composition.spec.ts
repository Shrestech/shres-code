/**
 * Real-composition guard: LlmRuntime and a configured `llm-claude-session` row
 * boot from a test-only cordis.yml through the actual Loader + Include path, the
 * route serves one OAuth turn against a loopback Anthropic Messages stand-in,
 * the outgoing request carries the pinned wire constants, and disposal withdraws
 * the provider. A hand-mounted `ctx.plugin` cannot catch Loader export-shape
 * failures, which is why the shipped posture is booted here.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import LlmRuntime, { BlockAssembler, ReasoningEffortId, userAgent } from '@shres-code/shres-code-llm'
import type { GenerateOptions, StreamChunk } from '@shres-code/shres-code-llm'
import * as LlmClaudeSession from '../src/index.ts'
import { accessToken, mockAnthropic, writeCredentialsDocument } from './helpers.ts'

/** The one system block pi-ai prepends under an OAuth token. */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

let root: string | undefined
let context: Context | undefined
let upstream: Awaited<ReturnType<typeof mockAnthropic>> | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await upstream?.close()
  upstream = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Drive one streamed turn through the production assembler, keeping the raw chunks. */
async function assemble(
  request: Omit<GenerateOptions, 'provider'>,
): Promise<{ text: string; chunks: StreamChunk[] }> {
  const chunks: StreamChunk[] = []
  const assembler = new BlockAssembler()
  for await (const chunk of context!.llm.stream({ provider: 'claude-session', ...request })) {
    chunks.push(chunk)
    assembler.push(chunk)
  }
  const message = assembler.message({ kind: 'model', provider: 'claude-session', model: request.model })
  return {
    text: message.content.filter(block => block.type === 'text').map(block => block.text).join(''),
    chunks,
  }
}

/** Boot the shipped posture from a test cordis.yml through Loader + Include. */
async function boot(): Promise<Context> {
  upstream = await mockAnthropic()
  const authPath = await writeCredentialsDocument({ accessToken: accessToken('composition') })
  root = await mkdtemp(join(tmpdir(), 'claude-session-composition-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: llm-claude-session',
    "  name: '@shres-code/shres-code-llm-claude-session'",
    '  config:',
    `    authPath: ${JSON.stringify(authPath)}`,
    '    useKeychain: false',
    `    baseURL: ${JSON.stringify(upstream.url)}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@shres-code/shres-code-llm-claude-session', LlmClaudeSession],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return ctx
}

describe('llm-claude-session real composition', () => {
  it('boots the configured route from cordis.yml and serves one OAuth turn', async () => {
    const ctx = await boot()
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['claude-session'])

    const turn = await assemble({
      model: 'claude-opus-5',
      messages: [],
      reasoningEffort: ReasoningEffortId('xhigh'),
    })
    expect(turn.text).toBe('hello')
    expect(turn.chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'mulling it over' })

    const request = upstream!.requests[0]!
    expect(request.method).toBe('POST')
    expect(request.path).toBe('/v1/messages')
    expect(request.headers.authorization).toBe(`Bearer ${accessToken('composition')}`)
    expect(request.headers['anthropic-beta']).toBe('claude-code-20250219,oauth-2025-04-20')
    expect(request.headers['x-app']).toBe('cli')
    // pi-ai pins `user-agent: claude-cli/2.1.75` in its OAuth default headers,
    // but the shared pi-ai adapter merges Harness attribution later-wins through
    // pi-ai's options headers, so the pinned CLI identity is replaced before the
    // request leaves. The seam's expected `toBe('claude-cli/2.1.75')` fails on
    // that merge; the shipped value is pinned here.
    expect(request.headers['user-agent']).toBe(userAgent())

    // The identity block pi-ai prepends under an OAuth token, verbatim.
    const system = request.body['system'] as { type: string; text: string }[]
    expect(system[0]?.text).toBe(CLAUDE_CODE_IDENTITY)
    // A requested effort drives the adaptive format plus its wire effort.
    expect(request.body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(request.body['output_config']).toEqual({ effort: 'xhigh' })
  })

  it('refuses the off effort the subscription models reject', async () => {
    const ctx = await boot()
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['claude-session'])
    // Live 5.x models answer 400 for thinking.type disabled, so the level is
    // not offered and the refusal is a finish chunk before any request leaves.
    const turn = await assemble({
      model: 'claude-opus-5',
      messages: [],
      reasoningEffort: ReasoningEffortId('off'),
    })
    expect(turn.chunks).toContainEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: 'UNSUPPORTED_REASONING_EFFORT',
          message: 'provider "claude-session" model "claude-opus-5" does not support reasoning effort "off"',
        },
      },
    })
    expect(upstream!.requests).toHaveLength(0)
  })

  it('disposal withdraws the provider', async () => {
    const ctx = await boot()
    const llm = ctx.llm
    expect(llm.listProviders().map(provider => provider.id)).toEqual(['claude-session'])
    await ctx.fiber.dispose()
    expect(llm.listProviders()).toEqual([])
    context = undefined
  })
})
