import { describe, expect, it } from 'vitest'
import { Config as Section } from '../src/index.ts'
import { DEFAULT_CLI_VERSION, resolveRoute } from '../src/config.ts'

describe('resolveRoute headers', () => {
  it('advertises the default CLI version the proxy gates on', () => {
    const route = resolveRoute({} as Section)
    expect(route.headers?.['user-agent']).toBe('grok-cli/' + DEFAULT_CLI_VERSION)
    expect(route.headers?.['x-grok-cli-version']).toBe(DEFAULT_CLI_VERSION)
  })

  it('advertises a configured cliVersion override', () => {
    const route = resolveRoute({ cliVersion: '9.9.9' } as Section)
    expect(route.headers?.['user-agent']).toBe('grok-cli/9.9.9')
  })

  it('rejects an empty cliVersion', () => {
    expect(() => resolveRoute({ cliVersion: '  ' } as Section)).toThrow(/cliVersion must be non-empty/)
  })
})
