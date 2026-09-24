/**
 * Live probe: does the Claude subscription route honour the one-hour prompt
 * cache? Two fresh prefixes are written concurrently, one with
 * `cacheRetention: 'long'` and one with `'short'` as the negative control,
 * then read again after an idle gap longer than the five-minute TTL.
 * Passing means the one-hour prefix is still readable and the five-minute one
 * has expired.
 *
 * Opt-in because it waits more than six minutes and spends subscription quota:
 * it runs only with `SHRES_E2E_CLAUDE_CACHE_TTL=1` and a readable Claude Code
 * login, and self-skips otherwise. Run it alone:
 *
 *     SHRES_E2E_CLAUDE_CACHE_TTL=1 pnpm exec vitest run --config vitest.e2e.config.ts \
 *       packages/llm/llm-claude-session/tests/cache-retention.e2e.ts
 *
 * The harness usage chunk carries only total cache reads and writes, so the
 * probe tees each `/v1/messages` response through a test-scoped fetch wrapper
 * and reads the raw `message_start` usage for the one-hour and five-minute
 * write split. The Anthropic SDK resolves the global `fetch` when pi-ai builds
 * each request's client, which is what lets the wrapper see the response.
 */

import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage, ReasoningEffortId } from '@shres-code/shres-code-llm'
import * as LlmClaudeSession from '../src/index.ts'
import { ClaudeSessionManager, resolveCredentialSpec } from '../src/index.ts'
import type { ClaudeSessionCacheRetention } from '../src/index.ts'

/** Idle gap between the write and the read: past the five-minute TTL with margin. */
const IDLE_MS = 6.5 * 60_000

/** Cheapest shipped model; the probe measures the cache, not the answer. */
const MODEL = 'claude-sonnet-5'

const OPTED_IN = process.env.SHRES_E2E_CLAUDE_CACHE_TTL === '1'
const HAS_LOGIN = OPTED_IN
  && await new ClaudeSessionManager(resolveCredentialSpec({})).current().then(() => true, () => false)

/** One response's raw `message_start` cache usage. */
interface RawUsage {
  cacheRead: number
  cacheWrite: number
  /** `cache_creation.ephemeral_1h_input_tokens`; absent when the response omits the breakdown. */
  write1h?: number
  /** `cache_creation.ephemeral_5m_input_tokens`; absent when the response omits the breakdown. */
  write5m?: number
}

/**
 * Read one SSE body to its end and return the usage of its `message_start` event.
 * @param body - the teed response body.
 * @returns the raw usage, or undefined when no `message_start` arrived.
 */
async function messageStartUsage(body: ReadableStream<Uint8Array>): Promise<RawUsage | undefined> {
  const text = await new Response(body).text()
  for (const frame of text.split('\n\n')) {
    const data = frame.split('\n').find(line => line.startsWith('data: '))
    if (data === undefined) continue
    const event = JSON.parse(data.slice('data: '.length)) as { type?: string; message?: { usage?: Record<string, unknown> } }
    if (event.type !== 'message_start') continue
    const usage = event.message?.usage ?? {}
    const creation = usage.cache_creation as { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } | undefined
    return {
      cacheRead: Number(usage.cache_read_input_tokens ?? 0),
      cacheWrite: Number(usage.cache_creation_input_tokens ?? 0),
      ...creation?.ephemeral_1h_input_tokens === undefined ? {} : { write1h: creation.ephemeral_1h_input_tokens },
      ...creation?.ephemeral_5m_input_tokens === undefined ? {} : { write5m: creation.ephemeral_5m_input_tokens },
    }
  }
  return undefined
}

/**
 * A system prompt far above the minimum cacheable length, opened by a marker
 * unique to this run, so an earlier probe's cache on the same account cannot
 * answer for it and the fetch wrapper can tell the two routes' requests apart.
 * @param marker - the unique opening line.
 * @returns the system prompt.
 */
function uniquePrefix(marker: string): string {
  const lines = [`${marker} Reply with the single word OK.`]
  for (let index = 0; index < 600; index += 1) {
    lines.push(`Reference entry ${String(index).padStart(4, '0')}: record ${index} maps to value ${(index * 7919) % 10_007}.`)
  }
  return lines.join('\n')
}

const contexts: Context[] = []

afterAll(async () => {
  await Promise.all(contexts.map(context => context.fiber.dispose()))
})

/**
 * Mount the real route with one retention over the signed-in login.
 * @param cacheRetention - the retention every request of this context asks for.
 * @returns the mounted context.
 */
async function mount(cacheRetention: ClaudeSessionCacheRetention): Promise<Context> {
  const context = new Context()
  contexts.push(context)
  await context.plugin(LlmRuntime)
  await context.plugin(LlmClaudeSession, { cacheRetention })
  return context
}

describe.skipIf(!HAS_LOGIN)('llm-claude-session prompt-cache retention (live, opt-in)', () => {
  it('keeps a one-hour prefix readable past the five-minute TTL', { timeout: IDLE_MS + 4 * 60_000, retry: 0 }, async () => {
    const markers = { long: `Cache probe long ${randomUUID()}.`, short: `Cache probe short ${randomUUID()}.` }
    const original = globalThis.fetch
    const taken = new Map<'long' | 'short', Array<Promise<RawUsage | undefined>>>([['long', []], ['short', []]])
    // The two routes run concurrently and the stream is lazy, so each
    // response is attributed by the unique marker its own request body carries.
    globalThis.fetch = async (input, init) => {
      const response = await original(input, init)
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const body = typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : ''
      const label = body.includes(markers.long) ? 'long' : body.includes(markers.short) ? 'short' : undefined
      if (label === undefined || new URL(url).pathname !== '/v1/messages' || response.body === null) return response
      const [mine, theirs] = response.body.tee()
      taken.get(label)!.push(messageStartUsage(mine))
      return new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers })
    }
    try {
      const prefixes = { long: uniquePrefix(markers.long), short: uniquePrefix(markers.short) }
      const routes = { long: await mount('long'), short: await mount('short') }
      /** One identical turn on a labelled route, awaited to completion. */
      const ask = async (label: 'long' | 'short'): Promise<void> => {
        const assembler = new BlockAssembler()
        for await (const chunk of routes[label].llm.stream({
          provider: 'claude-session',
          model: MODEL,
          reasoningEffort: ReasoningEffortId('low'),
          maxTokens: 512,
          system: prefixes[label],
          messages: [createUserMessage({ content: [{ type: 'text', text: 'Ready?' }], source: { kind: 'plugin', plugin: 'cache-probe' } })],
        })) {
          assembler.push(chunk)
        }
        expect(assembler.finish).toEqual({ kind: 'stop' })
      }
      const usage = async (label: 'long' | 'short', index: number): Promise<RawUsage> => {
        const found = await taken.get(label)![index]
        if (found === undefined) throw new Error(`no message_start usage was observed for the ${label} request ${index}`)
        return found
      }

      await Promise.all([ask('long'), ask('short')])
      const [longWrite, shortWrite] = await Promise.all([usage('long', 0), usage('short', 0)])
      // A fresh prefix writes and reads nothing; the write lands in the asked-for tier.
      expect(longWrite.cacheRead).toBe(0)
      expect(longWrite.cacheWrite).toBeGreaterThan(0)
      expect(longWrite.write1h).toBe(longWrite.cacheWrite)
      expect(longWrite.write5m ?? 0).toBe(0)
      expect(shortWrite.cacheRead).toBe(0)
      expect(shortWrite.write5m).toBe(shortWrite.cacheWrite)
      expect(shortWrite.write1h ?? 0).toBe(0)

      await sleep(IDLE_MS)

      await Promise.all([ask('long'), ask('short')])
      const [longRead, shortRead] = await Promise.all([usage('long', 1), usage('short', 1)])
      console.info(`claude-session cache probe ${new Date().toISOString()}: long ${JSON.stringify({ write: longWrite, read: longRead })}; short ${JSON.stringify({ write: shortWrite, read: shortRead })}`)
      // The one-hour prefix survived the gap; the five-minute control expired.
      expect(longRead.cacheRead).toBeGreaterThanOrEqual(longWrite.cacheWrite)
      expect(shortRead.cacheRead).toBe(0)
    } finally {
      globalThis.fetch = original
    }
  })
})
