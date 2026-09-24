/**
 * Configuration validation, argument bounds, presentation, the result bound
 * below the fixed framing, and the load-settled diagnostic of the Grok X
 * search tools.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import type { Message as LogMessage } from '@shres-code/cordis'
import { CallId } from '@shres-code/shres-code-llm'
import type { ToolRunContext } from '@shres-code/shres-code-tools'
import {
  boundGrokXResult,
  GROK_X_TOOL_SPECS,
  grokXToolDefinitions,
  parseGrokXArgument,
  renderGrokXResult,
  resolveConfig,
} from '../src/index.ts'
import * as ToolGrokXSearch from '../src/index.ts'

const config = { model: 'grok-4.6', timeoutMs: 180_000, maxOutputTokens: 2048, maxResultChars: 20_000 }
const [keyword, , , thread] = GROK_X_TOOL_SPECS

describe('resolveConfig', () => {
  it('accepts the defaults and rejects each invalid field', () => {
    expect(resolveConfig(config)).toEqual(config)
    expect(() => resolveConfig({ ...config, model: '  ' })).toThrow(/model must be a non-empty string/)
    expect(() => resolveConfig({ ...config, maxOutputTokens: 1.5 })).toThrow(/maxOutputTokens must be a positive integer/)
    expect(() => resolveConfig({ ...config, timeoutMs: 0 })).toThrow(/timeoutMs must be a positive integer/)
    expect(() => resolveConfig({ ...config, timeoutMs: 2_147_483_648 })).toThrow(/timeoutMs must not exceed/)
    expect(() => resolveConfig({ ...config, maxResultChars: 999 })).toThrow(/maxResultChars must be at least 1000/)
  })
})

describe('parseGrokXArgument', () => {
  it('trims a valid argument and rejects empty, oversized, and malformed ones', () => {
    expect(parseGrokXArgument(keyword!, '  grok  ')).toBe('grok')
    expect(parseGrokXArgument(thread!, ' https://x.com/xai/status/7 ')).toBe('https://x.com/xai/status/7')
    expect(() => parseGrokXArgument(keyword!, '   ')).toThrow(/query must be a non-empty string/)
    expect(() => parseGrokXArgument(keyword!, 'q'.repeat(501))).toThrow(/query must be at most 500 characters/)
    expect(() => parseGrokXArgument(thread!, 'https://x.com/xai')).toThrow(/post must be an https/)
  })
})

describe('tool definitions', () => {
  const lifetime = new AbortController().signal
  const definitions = grokXToolDefinitions(new Context(), { config, lifetime, isEnabled: () => true })

  it('presents a pending call as a generic search card titled by the argument', () => {
    expect(definitions[0]?.presentCall?.({ query: 'from:xai' })).toEqual({
      card: 'generic', title: 'x_keyword_search: from:xai', kind: 'search', rawInput: 'from:xai',
    })
    expect(definitions[3]?.presentCall?.({})).toBeUndefined()
    expect(definitions.every(definition => definition.isConcurrencySafe?.({ query: 'q', post: '1' }) === true)).toBe(true)
  })

  it('refuses a call whose argument is missing before any request', async () => {
    const exec = { callId: CallId('c'), signal: lifetime } as unknown as ToolRunContext
    await expect(definitions[1]!.execute({}, exec)).rejects.toThrow(/missing required property "query"/)
  })
})

describe('boundGrokXResult below the fixed framing', () => {
  it('leaves out every operation and the answer when even the framing exceeds the cap', () => {
    const bounded = boundGrokXResult({
      answer: 'long answer',
      operations: [{ name: 'x_keyword_search', count: 3 }, { name: 'x_user_search', count: 1 }],
      omittedOperations: 0,
      truncated: false,
    }, 100)
    expect(bounded).toMatchObject({ operations: [], omittedOperations: 4, answer: '', truncated: true })
    expect(renderGrokXResult(bounded)).toContain('X operations Grok ran: 4 more not listed.')
  })
})

describe('load-settled diagnostic', () => {
  async function bootWithLoader(registerNamespace: boolean) {
    const ctx = new Context()
    const settled = Promise.withResolvers<undefined>()
    const logged: LogMessage[] = []
    ctx.logger.exporter({ levels: { default: 5 }, export: (message) => { logged.push(message) } })
    ctx.provide('loader', { await: () => settled.promise })
    ctx.provide('tools', { register: () => () => {} })
    ctx.provide('llm', {})
    ctx.provide('settings', { get: () => registerNamespace ? { enabled: true, hostedXSearch: true, agentXTools: false } : undefined })
    const fiber = ctx.plugin(ToolGrokXSearch)
    await fiber
    const warnings = (): string[] => logged
      .filter(message => message.type === 'warn')
      .map(message => String(message.args[0]))
    return { settle: () => { settled.resolve(undefined) }, fiber, warnings }
  }

  it('warns once when the grok-session namespace is still missing after loading settled', async () => {
    const { settle, warnings } = await bootWithLoader(false)
    settle()
    await vi.waitFor(() => { expect(warnings()).toHaveLength(1) })
    expect(warnings()[0]).toContain('llm-grok-session settings section is not registered')
  })

  it('stays silent when the namespace is registered or the plugin already unloaded', async () => {
    const registered = await bootWithLoader(true)
    registered.settle()
    const unloaded = await bootWithLoader(false)
    await unloaded.fiber.dispose()
    unloaded.settle()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(registered.warnings()).toEqual([])
    expect(unloaded.warnings()).toEqual([])
  })
})
