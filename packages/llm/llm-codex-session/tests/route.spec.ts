import { describe, expect, it } from 'vitest'
import { resolveRoute, SHIPPED_MODELS } from '../src/config.ts'

describe('resolveRoute headers', () => {
  it('ships the catalog with image input admitted on both models', () => {
    for (const model of SHIPPED_MODELS) {
      expect(model.input).toContain('image')
    }
  })

  it('names the observed lower-bound window for the model production exercised', () => {
    const astra = resolveRoute({}, 'account-7').models?.find(model => model.id === 'gpt-6-astra')
    expect(astra?.contextWindow).toBe(311_000)
  })

  it('leaves an unbounded model on the adapter fallback window', () => {
    const luna = resolveRoute({}, 'account-7').models?.find(model => model.id === 'gpt-5.6-luna')
    expect(luna?.contextWindow).toBeUndefined()
  })

  it('sends the backend header set the subscription wire requires', () => {
    const route = resolveRoute({}, 'account-7')
    expect(route.headers?.['chatgpt-account-id']).toBe('account-7')
    expect(route.headers?.['originator']).toBe('codex_cli_rs')
    expect(route.headers?.['openai-beta']).toBe('responses=experimental')
  })

  it('keeps an empty account id listable so the login failure stays a request error', () => {
    const route = resolveRoute({}, '')
    expect(route.headers?.['chatgpt-account-id']).toBe('')
  })

  it('advertises the efforts the backend accepts, refusing none it does not', () => {
    const route = resolveRoute({}, 'account-7')
    const efforts = route.models?.[0]?.reasoningEfforts ?? {}
    expect(Object.keys(efforts)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('cache-count reporting', () => {
  it('declares reported cache counts for the ChatGPT Responses backend', () => {
    expect(resolveRoute({}, 'account-7').cacheUsage).toBe('reported')
  })
})
