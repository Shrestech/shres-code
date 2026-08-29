/**
 * Real-API e2e for one wiki librarian cycle. Key-gated — skips entirely
 * without $DEEPSEEK_API_KEY (see vitest.e2e.config.ts).
 */

import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { createUserMessage } from '@shres-code/shres-code-llm'
import * as LlmDeepSeek from '@shres-code/shres-code-llm-deepseek'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import FileWikiService from '@shres-code/shres-code-wiki-filesystem'
import * as WikiLibrarian from '../src/index.ts'

const FLASH = 'deepseek-v4-flash'
const PROVIDER = 'deepseek-official'

let ctx: Context | undefined
let seat: { dispose(): Promise<unknown> } | undefined
let wikiRoot: string | undefined

afterEach(async () => {
  await seat?.dispose()
  seat = undefined
  await ctx?.fiber.dispose()
  ctx = undefined
  if (wikiRoot !== undefined) await rm(wikiRoot, { recursive: true, force: true })
  wikiRoot = undefined
})

/**
 * Wiki-relative markdown files that are knowledge pages or log shards.
 * Generated `index.md` is not a page or a log shard.
 * @param root - materialized wiki directory.
 * @returns posix-relative paths of non-empty page or log files.
 */
async function materialWikiFiles(root: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(root, { recursive: true })
  } catch {
    // The wiki directory is created on the first write; an empty cycle leaves none.
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const rel = entry.split(sep).join('/')
    if (rel === 'index.md') continue
    const info = await stat(join(root, entry))
    if (info.isFile() && info.size > 0) found.push(rel)
  }
  return found
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('wiki-librarian cycle e2e (real API)', () => {
  it('files a page or log shard after one bound cycle and logs the request first', async () => {
    wikiRoot = await mkdtemp(join(tmpdir(), 'wiki-librarian-e2e-'))
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, { thinking: 'disabled' })
    await ctx.plugin(FileWikiService, { root: wikiRoot, watch: false })
    const librarianConfig = {
      provider: PROVIDER,
      model: FLASH,
      timeoutMs: 90_000,
      maxOutputTokens: 512,
    }
    seat = await ctx.plugin(WikiLibrarian, librarianConfig)
    const session = ctx.sessions.create(SessionId('wiki-librarian-e2e'))
    session.append('user/message', createUserMessage({
      content: [{
        type: 'text',
        text: 'drainQueue deadlocked under load. Root cause: nested lock on the same mutex. Fix: release the outer lock before the nested call.',
      }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{
        type: 'text',
        text: 'Record that deadlock pattern as durable project knowledge.',
      }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    let requestBeforeDispatch = false
    ctx.on('llm/stream', (options, next) => {
      requestBeforeDispatch = session.events.some(event => event.type === 'wiki/librarian-request')
      expect(options.purpose).toBe('wiki-summarize')
      expect(options.provider).toBe(PROVIDER)
      expect(options.model).toBe(FLASH)
      return next()
    })

    const result = await WikiLibrarian.runLibrarianCycle(
      ctx,
      session,
      WikiLibrarian.resolveLibrarianConfig(librarianConfig),
      'wiki-summarize',
    )

    expect(requestBeforeDispatch).toBe(true)
    const request = session.events.find(event => event.type === 'wiki/librarian-request')
    expect(request?.type).toBe('wiki/librarian-request')
    if (request?.type === 'wiki/librarian-request') {
      expect(request.data.route).toEqual({ provider: PROVIDER, model: FLASH })
      expect(request.data.purpose).toBe('wiki-summarize')
    }
    const files = await materialWikiFiles(wikiRoot)
    expect(files.length, `cycle ${result.kind}: ${result.detail}`).toBeGreaterThan(0)
  }, 120_000)
})
