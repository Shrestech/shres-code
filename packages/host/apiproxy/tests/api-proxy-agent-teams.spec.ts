import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import type { SessionId } from '@shres-code/shres-code-session'
import { RpcId } from '../src/api/rpc.ts'
import { agentTeamsViewValueSchema } from '../src/api/agent-teams.schema.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const LEAD = 'lead-session' as SessionId

function bench(rows: object[]) {
  const lead = { id: LEAD }
  const ctx = new Context()
  ctx.provide('agents', { get: (id: SessionId) => id === LEAD ? lead : undefined })
  ctx.provide('sessionProjections', { onChanged: () => () => {}, register: () => () => {} })
  ctx.provide('userQuestions', { registerProvider: () => () => {} })
  ctx.provide('agentTeams', {
    tryMembership: (agent: unknown) => agent === lead ? { role: 'lead' } : undefined,
    listMembers: () => rows,
  })
  return createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
}

describe('agentTeams.view', () => {
  it('carries each row\'s spawn provider and LLM binding separately and omits unknown routes', async () => {
    const api = bench([
      { id: LEAD, name: 'lead', role: 'lead', status: 'idle', agentProvider: 'lead-llm', model: 'lead-model', diagnostics: [] },
      {
        id: 'scout-child', name: 'scout', role: 'teammate', status: 'inactive', description: 'Scout',
        provider: 'spawn', context: 'fresh', agentProvider: 'child-llm', model: 'child-model', diagnostics: [],
      },
      { id: 'legacy-child', name: 'legacy', role: 'teammate', status: 'inactive', provider: 'spawn', diagnostics: [] },
    ])
    const response = await api.agentTeams.view({ rpcId: RpcId('team-view'), payload: { sessionId: LEAD } })
    if (!response.result.ok) throw new Error(response.result.error.message)
    const value = agentTeamsViewValueSchema.parse(response.result.value)
    expect(value.members).toEqual([
      { name: 'lead', role: 'lead', status: 'idle', id: LEAD, agentProvider: 'lead-llm', model: 'lead-model', diagnostics: [] },
      {
        name: 'scout', role: 'teammate', status: 'inactive', id: 'scout-child', description: 'Scout',
        provider: 'spawn', agentProvider: 'child-llm', model: 'child-model', diagnostics: [],
      },
      { name: 'legacy', role: 'teammate', status: 'inactive', id: 'legacy-child', provider: 'spawn', diagnostics: [] },
    ])
  })
})
