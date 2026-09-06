import { describe, expect, it } from 'vitest'
import { resolveRoute, SHIPPED_MODELS } from '../src/config.ts'

describe('resolveRoute headers', () => {
  it('ships the catalog with image input admitted on both models', () => {
    for (const model of SHIPPED_MODELS) {
      expect(model.input).toContain('image')
    }
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
