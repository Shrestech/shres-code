import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@shres-code/cordis'
import { installModelSelection, type Agent } from '@shres-code/shres-code-agent'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import { mountAgentLoopTestDependencies } from '@shres-code/shres-code-agent-loop-testkit'
import { createUserMessage } from '@shres-code/shres-code-llm'
import { SessionId } from '@shres-code/shres-code-session'
import JsonlSessionPersistence from '@shres-code/shres-code-session-persistence-jsonl'
import SessionProjectionRegistry from '@shres-code/shres-code-session-projection'
import SubagentRuntime, { foldSubagentDescriptor } from '@shres-code/shres-code-subagent'
import * as SubagentSpawn from '@shres-code/shres-code-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { TeamId } from '../src/brand.ts'
import * as AgentTeamPlugin from '../src/index.ts'

const SIGNAL = new AbortController().signal
const LEAD = SessionId('route-lead')
const LEAD_ROUTE = { provider: 'mock', model: 'lead-model' }
const CHILD_ROUTE = { provider: 'mock', model: 'child-model' }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Reject every model step for the matched agents so they stay loaded without requesting. */
function parkWhere(ctx: Context, parked: (agent: Agent) => boolean): void {
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (!parked(agent)) return next()
    return { kind: 'reject' as const }
  })
}

/**
 * Park the Lead and hold every teammate while its first request config
 * resolves — after its turn recorded the initial prompt, before any request
 * header is logged — until the turn aborts at teardown.
 */
function holdTeammates(ctx: Context, lead: Agent): void {
  parkWhere(ctx, agent => agent === lead)
  ctx.on('agent/request', async ({ agent, signal }, next) => {
    if (agent !== lead) {
      await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }) })
    }
    return next()
  })
}

async function boot(adapter: MockAdapter, storageRoot?: string) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = storageRoot ?? mkdtempSync(join(tmpdir(), 'shres-team-route-'))
  if (storageRoot === undefined) roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(AgentTeamPlugin)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, root }
}

function spawnScout(ctx: Context, lead: Agent, agentOptions?: { provider: string; model: string }) {
  return ctx.agentTeams.spawnTeammate(lead, {
    name: 'scout',
    description: 'Scout',
    prompt: [{ type: 'text', text: 'scout initial' }],
    context: 'fresh',
    provider: 'spawn',
    signal: SIGNAL,
    ...agentOptions === undefined ? {} : { agentOptions },
  })
}

function row(ctx: Context, lead: Agent, name: string) {
  return ctx.agentTeams.listMembers(lead).find(member => member.name === name)
}

describe('Agent Team roster model route', () => {
  it('runs, records, and lists the child route, then keeps it after unload and restart', { timeout: 20_000 }, async () => {
    const adapter = new MockAdapter([textResponse('scout done')])
    const { ctx, root } = await boot(adapter)
    const lead = ctx.agentLoop.create(LEAD, LEAD_ROUTE)
    parkWhere(ctx, agent => agent === lead)

    const spawned = await spawnScout(ctx, lead, CHILD_ROUTE)
    const childId = spawned.member.id
    expect(spawned.member).toMatchObject({ provider: 'spawn', agentProvider: 'mock', model: 'child-model' })

    // The child's actual model request and its durable descriptor use the child route.
    await vi.waitFor(() => {
      expect(adapter.requests.find(request => request.sessionId === childId)?.model).toBe('child-model')
    }, { timeout: 5_000 })
    const childSession = ctx.agents.get(childId)?.session ?? (await ctx.sessionPersistence.load(childId))
    const descriptor = foldSubagentDescriptor(childSession.events)
    if (descriptor?.mode !== 'continuable') throw new Error('expected a continuable descriptor')
    expect(descriptor).toMatchObject({ agentProvider: 'mock', agentModel: 'child-model' })

    // The Lead log records the descriptor route on the active edge.
    const active = lead.session.events.filter(event => event.type === 'team/member')
      .map(event => event.data.member).find(member => member.phase === 'active')
    expect(active).toMatchObject({ agentProvider: descriptor.agentProvider, agentModel: descriptor.agentModel })

    // Loaded, then inactive: the scout keeps its own route, and the Lead keeps its own.
    await vi.waitFor(() => {
      expect(ctx.agents.get(childId)).toBeUndefined()
    }, { timeout: 5_000 })
    expect(ctx.agentTeams.listMembers(lead).map(member => [member.name, member.status, member.agentProvider, member.model]))
      .toEqual([
        ['lead', 'idle', 'mock', 'lead-model'],
        ['scout', 'inactive', 'mock', 'child-model'],
      ])
    await ctx.sessions.flush(lead.session)
    await ctx.fiber.dispose()

    const restarted = await boot(new MockAdapter([]), root)
    const lead2 = (await restarted.ctx.agents.resume({ resumeSessionId: LEAD, agentOptions: LEAD_ROUTE })).agent
    parkWhere(restarted.ctx, agent => agent === lead2)
    expect(row(restarted.ctx, lead2, 'scout')).toMatchObject({ status: 'inactive', agentProvider: 'mock', model: 'child-model' })
    await restarted.ctx.fiber.dispose()
  })

  it('shows a loaded teammate\'s creation route before its first request, never the Lead\'s', async () => {
    const { ctx } = await boot(new MockAdapter([]))
    const lead = ctx.agentLoop.create(LEAD, LEAD_ROUTE)
    holdTeammates(ctx, lead)
    const spawned = await spawnScout(ctx, lead, CHILD_ROUTE)
    const live = ctx.agents.get(spawned.member.id)
    expect(live?.session.requestHeader()).toBeUndefined()
    expect(row(ctx, lead, 'scout')).toMatchObject({ status: 'running', agentProvider: 'mock', model: 'child-model' })
    await ctx.fiber.dispose()
  })

  it('omits the model for an unloaded teammate whose snapshot has no route', async () => {
    const { ctx } = await boot(new MockAdapter([]))
    const lead = ctx.agentLoop.create(LEAD, LEAD_ROUTE)
    parkWhere(ctx, () => true)
    const legacy = { id: SessionId('legacy-child'), name: 'legacy', description: 'Legacy', provider: 'spawn', context: 'fresh' as const }
    lead.session.append('team/member', { teamId: TeamId(lead.id), member: { ...legacy, phase: 'provisioning' } }, { ignorable: true })
    lead.session.append('team/member', { teamId: TeamId(lead.id), member: { ...legacy, phase: 'active' } }, { ignorable: true })
    const listed = row(ctx, lead, 'legacy')
    expect(listed).toMatchObject({ status: 'inactive', provider: 'spawn' })
    expect(listed).not.toHaveProperty('model')
    expect(listed).not.toHaveProperty('agentProvider')
    await ctx.fiber.dispose()
  })

  it('applies the current template only to unstarted names', async () => {
    const { ctx } = await boot(new MockAdapter([]))
    const lead = ctx.agentLoop.create(LEAD, LEAD_ROUTE)
    holdTeammates(ctx, lead)
    let template = [
      { name: 'aegis', description: 'Architect', provider: 'mock', model: 'first-model' },
      { name: 'ward', description: 'Reviewer', provider: 'mock', model: 'first-model' },
    ]
    ctx.agentTeams.setRosterTemplate(() => template)
    await ctx.agentTeams.ensureTemplateMember(lead, 'aegis', [{ type: 'text', text: 'start' }])
    template = template.map(entry => ({ ...entry, provider: 'other-llm', model: 'second-model' }))
    expect(row(ctx, lead, 'aegis')).toMatchObject({ provider: 'spawn', agentProvider: 'mock', model: 'first-model' })
    expect(row(ctx, lead, 'ward')).toMatchObject({
      status: 'unstarted',
      provider: 'spawn',
      agentProvider: 'other-llm',
      model: 'second-model',
    })
    await ctx.fiber.dispose()
  })

  it('shows the Lead\'s latest logged request route once a switched Lead makes a request', async () => {
    const adapter = new MockAdapter([textResponse('lead switched')])
    const { ctx } = await boot(adapter)
    const lead = ctx.agentLoop.create(LEAD, LEAD_ROUTE)
    const selection = { current: { provider: 'mock', model: 'picked-model' }, assembled: undefined }
    installModelSelection(lead.ctx, selection)
    // Before the switched Lead's next request the roster reports its last known route.
    expect(row(ctx, lead, 'lead')).toMatchObject({ agentProvider: 'mock', model: 'lead-model' })
    lead.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await lead.whenIdle()
    expect(adapter.requests.find(request => request.sessionId === lead.id)?.model).toBe('picked-model')
    expect(row(ctx, lead, 'lead')).toMatchObject({ agentProvider: 'mock', model: 'picked-model' })
    await ctx.fiber.dispose()
  })
})
