/**
 * Prompt-cache retention: the section field and its schema refusal, the
 * resolved pi-ai profile, the lifetime the route declares on its model
 * metadata, and the cache control each retention puts on the wire.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage } from '@shres-code/shres-code-llm'
import { resolveProfiles } from '@shres-code/shres-code-llm-pi-ai'
import * as LlmClaudeSession from '../src/index.ts'
import {
  CLAUDE_SESSION_PROVIDER_ID,
  Config,
  DEFAULT_CACHE_RETENTION,
  PROMPT_CACHE_TTL_MS,
  resolveRoute,
} from '../src/index.ts'
import type { ClaudeSessionCacheRetention, Config as ClaudeSessionConfig } from '../src/index.ts'
import { mockAnthropic, writeCredentialsDocument } from './helpers.ts'

let upstream: Awaited<ReturnType<typeof mockAnthropic>> | undefined
let ctx: Context | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  await ctx?.fiber.dispose()
  ctx = undefined
  await upstream?.close()
  upstream = undefined
})

/** Boot the real plugin over a temp credential document and a loopback stand-in. */
async function boot(config: ClaudeSessionConfig = {}): Promise<Context> {
  const authPath = await writeCredentialsDocument()
  upstream = await mockAnthropic()
  const context = new Context()
  ctx = context
  await context.plugin(LlmRuntime)
  await context.plugin(LlmClaudeSession, { ...config, authPath, useKeychain: false, baseURL: upstream.url })
  return context
}

/** The retention pi-ai's profile resolution carries for the route's section. */
function profileRetention(config: ClaudeSessionConfig): unknown {
  return resolveProfiles({ [CLAUDE_SESSION_PROVIDER_ID]: resolveRoute(config) }).get(CLAUDE_SESSION_PROVIDER_ID)?.cacheRetention
}

/**
 * Every `cache_control` value in one recorded request body.
 * @param value - the parsed body or any value inside it.
 * @returns the cache-control objects in document order.
 */
function cacheControls(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(cacheControls)
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, inner]) => key === 'cache_control' ? [inner] : cacheControls(inner))
}

/** Send one system-prompted user turn and return the body the stand-in recorded. */
async function sentBody(context: Context): Promise<Record<string, unknown>> {
  const assembler = new BlockAssembler()
  for await (const chunk of context.llm.stream({
    provider: CLAUDE_SESSION_PROVIDER_ID,
    model: 'claude-opus-5-5',
    system: 'Answer tersely.',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })],
  })) {
    assembler.push(chunk)
  }
  expect(assembler.finish).toEqual({ kind: 'stop' })
  return upstream!.requests.at(-1)!.body
}

describe('cacheRetention configuration', () => {
  it('resolves cacheRetention short by default', () => {
    expect(DEFAULT_CACHE_RETENTION).toBe('short')
    // The schema leaves an absent field absent; the route resolution decides it.
    expect(Config({})).not.toHaveProperty('cacheRetention')
    expect(resolveRoute({}).cacheRetention).toBe('short')
    expect(profileRetention({})).toBe('short')
  })

  it('forwards cacheRetention long into the pi-ai profile', () => {
    expect(resolveRoute({ cacheRetention: 'long' }).cacheRetention).toBe('long')
    expect(profileRetention({ cacheRetention: 'long' })).toBe('long')
    expect(profileRetention({ cacheRetention: 'none' })).toBe('none')
  })

  it('rejects an unknown cacheRetention by name', async () => {
    expect(() => Config({ cacheRetention: 'forever' as never }))
      .toThrow('$.cacheRetention expected "none" | "short" | "long" but got "forever"')
    // A plugin mount validates its entry through the same schema.
    const context = new Context()
    ctx = context
    await context.plugin(LlmRuntime)
    await expect(context.plugin(LlmClaudeSession, { cacheRetention: 'forever' as never }))
      .rejects.toThrow(/\$\.cacheRetention expected "none" \| "short" \| "long"/)
    expect(context.llm.listProviders()).toEqual([])
  })

  it.each([
    [undefined, 300_000],
    ['short', 300_000],
    ['long', 3_600_000],
    ['none', 0],
  ] as const)('declares promptCacheTtlMs matching cacheRetention (%s: %s)', async (cacheRetention, ttl) => {
    const context = await boot(cacheRetention === undefined ? {} : { cacheRetention })
    const models = await context.llm.listModels(CLAUDE_SESSION_PROVIDER_ID)
    expect(models.map(model => model.promptCacheTtlMs)).toEqual([ttl, ttl, ttl])
    await expect(context.llm.resolveModelInfo(CLAUDE_SESSION_PROVIDER_ID, 'claude-sonnet-5'))
      .resolves.toMatchObject({ promptCacheTtlMs: ttl })
  })

  it('maps each retention to Anthropic\'s documented lifetime', () => {
    const table: Record<ClaudeSessionCacheRetention, number> = { none: 0, short: 300_000, long: 3_600_000 }
    expect(PROMPT_CACHE_TTL_MS).toEqual(table)
  })
})

describe('cache control on the wire', () => {
  it('asks for the one-hour cache on every breakpoint when cacheRetention is long', async () => {
    const body = await sentBody(await boot({ cacheRetention: 'long' }))
    const controls = cacheControls(body)
    expect(controls.length).toBeGreaterThan(0)
    // The stand-in listens on 127.0.0.1: pi-ai gates the one-hour TTL on the
    // model, not on an api.anthropic.com base URL.
    for (const control of controls) expect(control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('keeps the five-minute cache by default even when PI_CACHE_RETENTION asks for long', async () => {
    vi.stubEnv('PI_CACHE_RETENTION', 'long')
    const body = await sentBody(await boot())
    const controls = cacheControls(body)
    expect(controls.length).toBeGreaterThan(0)
    for (const control of controls) expect(control).toEqual({ type: 'ephemeral' })
  })

  it('sends no cache control when cacheRetention is none', async () => {
    const body = await sentBody(await boot({ cacheRetention: 'none' }))
    expect(cacheControls(body)).toEqual([])
  })
})
