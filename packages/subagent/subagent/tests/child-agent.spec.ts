/**
 * Child route inheritance: logged header, else live default, else creation options.
 */

import { describe, expect, it } from 'vitest'
import type { Agent } from '@shres-code/shres-code-agent'
import { effectiveChildRoute } from '../src/child-agent.ts'

function parent(overrides: {
  header?: { provider?: string; model?: string }
  defaults?: { provider: string; model: string }
  options?: { provider?: string; model?: string }
}): Agent {
  return {
    session: {
      requestHeader: () => overrides.header === undefined ? undefined : { config: overrides.header },
    },
    ctx: {
      get: (name: string) => name === 'agentDefaultModel' && overrides.defaults !== undefined
        ? { currentSelection: () => overrides.defaults }
        : undefined,
    },
    options: overrides.options ?? {},
  } as Agent
}

describe('effectiveChildRoute', () => {
  it('inherits the live default model when the parent has no logged header', () => {
    expect(effectiveChildRoute(parent({ defaults: { provider: 'live', model: 'm' } }), undefined))
      .toEqual({ provider: 'live', model: 'm' })
  })

  it('falls back to creation options when no header and no default-model service exist', () => {
    expect(effectiveChildRoute(parent({ options: { provider: 'opt', model: 'n' } }), undefined))
      .toEqual({ provider: 'opt', model: 'n' })
  })
})
