import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import { CallId } from '@shres-code/shres-code-llm'
import * as Invariant from '../src/invariant.ts'
import type { GrokXSearchRequestEventData } from '../src/index.ts'

const valid: GrokXSearchRequestEventData = {
  tool: 'x_user_search',
  callId: CallId('call-1'),
  route: { provider: 'grok-session', model: 'grok-4.6' },
  system: 'system',
  messages: [],
  hostedTools: ['x_search'],
  maxTokens: 2048,
}

async function session() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(Invariant)
  return ctx.sessions.create(SessionId('caller'))
}

describe('grok-x-search/request invariant', () => {
  it('accepts what the tools write and rejects any other tool, route, or hosted-tool list', async () => {
    const target = await session()
    expect(() => { target.append('grok-x-search/request', valid, { ignorable: true }) }).not.toThrow()
    for (const forged of [
      { ...valid, tool: 'web_search' as never },
      { ...valid, route: { provider: 'deepseek-official', model: 'm' } },
      { ...valid, hostedTools: ['x_search', 'web_search'] as const },
    ]) {
      expect(() => { target.append('grok-x-search/request', forged, { ignorable: true }) }).toThrow(/grok-x-search\/request/)
    }
  })
})
