import { describe, expect, it } from 'vitest'
import { Config as Section } from '../src/index.ts'
import { DEFAULT_CLI_VERSION, resolveRoute, SHIPPED_MODELS } from '../src/config.ts'

describe('resolveRoute headers', () => {
  it('ships the catalog with image input admitted on both models', () => {
    for (const model of SHIPPED_MODELS) {
      expect(model.input).toContain('image')
    }
  })

  it('sends the documented CLI header set the proxy gates on', () => {
    const route = resolveRoute({} as Section)
    expect(route.headers?.['x-xai-token-auth']).toBe('xai-grok-cli')
    expect(route.headers?.['x-grok-client-version']).toBe(DEFAULT_CLI_VERSION)
    expect(route.headers?.['x-grok-client-identifier']).toBe('grok-shell')
  })

  it('advertises a configured cliVersion override', () => {
    const route = resolveRoute({ cliVersion: '9.9.9' } as Section)
    expect(route.headers?.['x-grok-client-version']).toBe('9.9.9')
  })

  it('rejects an empty cliVersion', () => {
    expect(() => resolveRoute({ cliVersion: '  ' } as Section)).toThrow(/cliVersion must be non-empty/)
  })
})
