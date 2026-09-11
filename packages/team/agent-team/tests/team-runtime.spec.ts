import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@shres-code/cordis'
import type { Agent } from '@shres-code/shres-code-agent'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import { mountAgentLoopTestDependencies } from '@shres-code/shres-code-agent-loop-testkit'
import type { GenerateOptions, StreamChunk } from '@shres-code/shres-code-llm'
import { LlmAdapter } from '@shres-code/shres-code-llm'
import { SessionId } from '@shres-code/shres-code-session'
import { TeamId } from '../src/brand.ts'
import JsonlSessionPersistence from '@shres-code/shres-code-session-persistence-jsonl'
import SessionProjectionRegistry from '@shres-code/shres-code-session-projection'
import SubagentRuntime from '@shres-code/shres-code-subagent'
import * as SubagentSpawn from '@shres-code/shres-code-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as AgentTeamPlugin from '../src/index.ts'


const SIGNAL = new AbortController().signal
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

interface GatedEntry {
  chunks: StreamChunk[]
  gate?: Promise<undefined>
}

class GatedAdapter extends LlmAdapter {
  constructor(private script: GatedEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const entry = this.script.shift()
    if (!entry) throw new Error('GatedAdapter: script exhausted')
    if (entry.gate) await entry.gate
    for (const chunk of entry.chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

function park(ctx: Context, id: SessionId): void {
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent.id !== id) return next()
    return { kind: 'reject' as const }
  })
}

async function setup(adapter: MockAdapter | GatedAdapter, config?: AgentTeamPlugin.Config) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'shres-team-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(AgentTeamPlugin, config)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  park(ctx, lead.id)
  return { ctx, lead, storageRoot }
}

function content(text: string) {
  return [{ type: 'text' as const, text }]
}

async function spawn(ctx: Context, lead: Agent, name: string) {
  return ctx.agentTeams.spawnTeammate(lead, {
    name,
    description: `${name} responsibility`,
    prompt: content(`${name} initial`),
    context: 'fresh',
    provider: 'spawn',
    signal: SIGNAL,
  })
}

describe('Agent Teams runtime mailbox', () => {
  it('provisions two members and steers Lead→member and member→Lead without double-post', async () => {
    let releaseAegis!: () => void
    const aegisGate = new Promise<undefined>((resolve) => {
      releaseAegis = () => { resolve(undefined) }
    })
    const { ctx, lead } = await setup(new GatedAdapter([
      { chunks: textResponse('aegis working'), gate: aegisGate },
      { chunks: textResponse('stride idle') },
      { chunks: textResponse('aegis after mail') },
    ]))

    const aegis = await spawn(ctx, lead, 'aegis')
    const stride = await spawn(ctx, lead, 'stride')
    const aegisAgent = await vi.waitFor(() => {
      const live = ctx.agents.get(aegis.member.id)
      expect(live).toBeDefined()
      return live!
    }, { timeout: 5_000 })

    const toAegis = await ctx.agentTeams.sendMessage(lead, {
      target: 'aegis',
      content: content('plan billing'),
      signal: SIGNAL,
    })
    expect(toAegis.status).toBe('accepted')
    expect(aegisAgent.inbox.nextStep.some(message => message.source.kind === 'team-message'
      && message.source.messageId === toAegis.messageId)).toBe(true)
    expect(aegisAgent.inbox.nextTurn).toHaveLength(0)
    expect(lead.session.events.filter(event => event.type === 'team/message/queued')).toHaveLength(1)

    const fromAegis = await ctx.agentTeams.sendMessage(aegisAgent, {
      target: 'lead',
      content: content('here is the plan'),
      signal: SIGNAL,
    })
    expect(['accepted', 'queued']).toContain(fromAegis.status)
    const leadSteer = lead.session.events.some(event =>
      event.type === 'agent/inbox/spliced'
      && event.data.target === 'next-step'
      && event.data.inserted.some(message => 'source' in message
        && message.source.kind === 'team-message'
        && message.source.messageId === fromAegis.messageId))
    expect(leadSteer).toBe(true)
    expect(lead.inbox.nextTurn).toHaveLength(0)

    releaseAegis()
    await vi.waitFor(() => {
      const targetMail = aegisAgent.session.events.filter(event =>
        event.type === 'user/message' && event.data.source.kind === 'team-message')
      expect(targetMail.some(event => event.data.source.kind === 'team-message'
        && event.data.source.messageId === toAegis.messageId)).toBe(true)
    }, { timeout: 5_000 })
    expect(lead.session.events.filter(event => event.type === 'team/message/delivered')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ data: expect.objectContaining({ messageId: toAegis.messageId }) }),
      ]),
    )

    const sameIdentity = aegisAgent.session.events.filter(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'team-message'
      && event.data.source.messageId === toAegis.messageId)
    expect(sameIdentity).toHaveLength(1)
    const names = ctx.agentTeams.listMembers(lead).map(row => row.name)
    expect(names).toEqual(expect.arrayContaining(['lead', 'aegis', 'stride']))
    expect(names).not.toContain('subagent')
    expect(stride.member.name).toBe('stride')
    await ctx.fiber.dispose()
  })

  it('retries queued-minus-delivered after a restart without double-posting', { timeout: 20_000 }, async () => {
    const { ctx, lead, storageRoot } = await setup(new MockAdapter([
      textResponse('aegis done'),
    ]))
    const spawned = await spawn(ctx, lead, 'aegis')
    await vi.waitFor(() => {
      expect(ctx.agents.get(spawned.member.id)).toBeUndefined()
    }, { timeout: 5_000 })

    const queued = await ctx.agentTeams.sendMessage(lead, {
      target: 'aegis',
      content: content('after settle'),
      signal: SIGNAL,
    })
    expect(['accepted', 'queued']).toContain(queued.status)

    await ctx.fiber.dispose()

    const resumed = new Context()
    await mountAgentLoopTestDependencies(resumed)
    await resumed.plugin(JsonlSessionPersistence, { root: storageRoot })
    await resumed.plugin(AgentLoop, { agents: [] })
    await resumed.plugin(SessionProjectionRegistry)
    await resumed.plugin(SubagentRuntime)
    await resumed.plugin(SubagentSpawn, { providerName: 'spawn' })
    await resumed.plugin(AgentTeamPlugin)
    resumed.llm.registerAdapter(['mock'], new MockAdapter([textResponse('resumed')]))
    const lead2 = (await resumed.agents.resume({
      resumeSessionId: SessionId('lead'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })).agent
    park(resumed, lead2.id)
    await vi.waitFor(() => {
      const delivered = lead2.session.events.filter(event => event.type === 'team/message/delivered')
      expect(delivered.some(event => event.data.messageId === queued.messageId)).toBe(true)
    }, { timeout: 8_000 })
    const childEvents = resumed.sessions.get(spawned.member.id)?.events
      ?? (await resumed.sessionPersistence.inspect(spawned.member.id)).events
    const posts = childEvents.filter(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'team-message'
      && event.data.source.messageId === queued.messageId)
    expect(posts).toHaveLength(1)
    await resumed.fiber.dispose()
  })

  it('lazily provisions a YAML extra from the roster template via team_send', async () => {
    const { ctx, lead } = await setup(new MockAdapter([
      textResponse('researcher ready'),
      textResponse('researcher after mail'),
    ]))
    ctx.agentTeams.setRosterTemplate(() => [{
      name: 'researcher',
      description: 'Researcher',
      persona: 'You are Researcher.',
      provider: 'mock',
      model: 'mock',
    }])
    expect(ctx.agentTeams.listMembers(lead).map(row => row.name)).toContain('researcher')
    const sent = await ctx.agentTeams.sendMessage(lead, {
      target: 'researcher',
      content: content('look this up'),
      signal: SIGNAL,
    })
    expect(['accepted', 'queued']).toContain(sent.status)
    const names = ctx.agentTeams.listMembers(lead).map(row => row.name)
    expect(names).toContain('researcher')
    expect(names).not.toContain('subagent')
    await ctx.fiber.dispose()
  })

  it('rejects self-send, unknown names, and duplicate teammate names', async () => {
    const { ctx, lead } = await setup(new MockAdapter([textResponse('aegis done')]))
    await spawn(ctx, lead, 'aegis')
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'lead',
      content: content('nope'),
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_SELF_MESSAGE' })
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'missing',
      content: content('nope'),
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
    await expect(spawn(ctx, lead, 'aegis')).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_TAKEN' })
    await expect(spawn(ctx, lead, 'Lead')).rejects.toMatchObject({ code: 'TEAM_INVALID_MEMBER_NAME' })
    await ctx.fiber.dispose()
  })

  it('recovers already-live Leads when the Team plugin mounts later', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const storageRoot = mkdtempSync(join(tmpdir(), 'shres-team-'))
    roots.push(storageRoot)
    await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
    const lead = ctx.agentLoop.create(SessionId('lead-late'), { provider: 'mock' })
    park(ctx, lead.id)
    await ctx.plugin(AgentTeamPlugin)
    expect(ctx.agentTeams.tryMembership(lead)?.role).toBe('lead')
    expect(ctx.agentTeams.listMembers(lead).some(row => row.name === 'lead' && row.model === undefined)).toBe(true)
    await ctx.fiber.dispose()
  })

  it('registers team_send and team_list', async () => {
    const { ctx } = await setup(new MockAdapter([]))
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toEqual(expect.arrayContaining(['team_send', 'team_list']))
    await ctx.fiber.dispose()
  })

  it('rejects teammate spawn, reserved names, a member cap, and a stale caller', async () => {
    let release!: () => void
    const gate = new Promise<undefined>((resolve) => { release = () => { resolve(undefined) } })
    const { ctx, lead } = await setup(new GatedAdapter([
      { chunks: textResponse('aegis working'), gate },
    ]), { maxMembers: 1 })
    const aegis = await spawn(ctx, lead, 'aegis')
    const aegisAgent = ctx.agents.get(aegis.member.id)
    expect(aegisAgent).toBeDefined()
    await expect(ctx.agentTeams.spawnTeammate(aegisAgent!, {
      name: 'stride',
      description: 'Worker',
      prompt: content('nope'),
      context: 'fresh',
      provider: 'spawn',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    await expect(spawn(ctx, lead, 'subagent')).rejects.toMatchObject({ code: 'TEAM_INVALID_MEMBER_NAME' })
    await expect(spawn(ctx, lead, 'stride')).rejects.toMatchObject({ code: 'TEAM_MEMBER_LIMIT' })
    expect(ctx.agentTeams.tryMembership(lead)?.role).toBe('lead')
    expect(ctx.agentTeams.tryMembership(aegisAgent!)?.role).toBe('teammate')
    const stale = { ...lead, id: SessionId('missing-agent') } as Agent
    expect(ctx.agentTeams.tryMembership(stale)).toBeUndefined()
    expect(() => ctx.agentTeams.membership(stale)).toThrow(/not a member/)

    const stray = await ctx.agents.create({
      sessionId: SessionId('stray-child'),
      meta: { parentSession: lead.id },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(ctx.agentTeams.tryMembership(stray.agent)?.role).toBe('lead')
    const orphan = await ctx.agents.create({
      sessionId: SessionId('orphan-child'),
      meta: { parentSession: SessionId('missing-parent') },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(ctx.agentTeams.tryMembership(orphan.agent)?.role).toBe('lead')
    release()
    await ctx.fiber.dispose()
  })

  it('records failed provisioning, refuses a later send, and lists unprovisioned template rows', async () => {
    const { ctx, lead } = await setup(new MockAdapter([]))
    vi.spyOn(ctx.subagents, 'startContinuable').mockRejectedValue(new Error('spawn failed'))
    ctx.agentTeams.setRosterTemplate(() => [{
      name: 'aegis',
      description: 'Architect',
      provider: 'mock',
    }])
    expect(ctx.agentTeams.listMembers(lead).some(row => row.name === 'aegis' && row.status === 'inactive')).toBe(true)
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'aegis',
      content: content('plan'),
      signal: SIGNAL,
    })).rejects.toThrow(/spawn failed/)
    const failed = ctx.agentTeams.listMembers(lead).find(row => row.name === 'aegis')
    expect(failed?.status).toBe('failed')
    expect(failed?.diagnostics.length).toBeGreaterThan(0)
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'aegis',
      content: content('again'),
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
    await ctx.agentTeams.ensureTemplateMember(lead, 'lead')
    await ctx.agentTeams.ensureTemplateMember(lead, String(lead.id))
    await ctx.fiber.dispose()
  })

  it('keeps a provisioning row until startContinuable settles', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { ctx, lead } = await setup(new MockAdapter([textResponse('aegis done')]))
    const orig = ctx.subagents.startContinuable.bind(ctx.subagents)
    vi.spyOn(ctx.subagents, 'startContinuable').mockImplementation(async (spec) => {
      await gate
      return orig(spec)
    })
    const pending = spawn(ctx, lead, 'aegis')
    await vi.waitFor(() => {
      expect(ctx.agentTeams.listMembers(lead).some(row => row.name === 'aegis' && row.status === 'provisioning')).toBe(true)
    }, { timeout: 5_000 })
    await ctx.agentTeams.ensureTemplateMember(lead, 'aegis')
    release()
    await pending
    expect(ctx.agentTeams.listMembers(lead).some(row => row.name === 'aegis' && row.status !== 'provisioning')).toBe(true)
    await ctx.fiber.dispose()
  })

  it('reconciles a leftover provisioning row after restart', { timeout: 20_000 }, async () => {
    const { ctx, lead, storageRoot } = await setup(new MockAdapter([textResponse('lead idle')]))
    const ghost = SessionId('ghost-child')
    lead.session.append('team/member', {
      teamId: TeamId(lead.id),
      member: {
        id: ghost,
        name: 'ghost',
        description: 'missing',
        provider: 'spawn',
        context: 'fresh',
        phase: 'provisioning',
      },
    }, { ignorable: true })
    await ctx.sessions.flush(lead.session)
    await ctx.fiber.dispose()

    const resumed = new Context()
    await mountAgentLoopTestDependencies(resumed)
    await resumed.plugin(JsonlSessionPersistence, { root: storageRoot })
    await resumed.plugin(AgentLoop, { agents: [] })
    await resumed.plugin(SessionProjectionRegistry)
    await resumed.plugin(SubagentRuntime)
    await resumed.plugin(SubagentSpawn, { providerName: 'spawn' })
    await resumed.plugin(AgentTeamPlugin)
    resumed.llm.registerAdapter(['mock'], new MockAdapter([]))
    const lead2 = (await resumed.agents.resume({
      resumeSessionId: SessionId('lead'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })).agent
    park(resumed, lead2.id)
    await vi.waitFor(() => {
      const row = resumed.agentTeams.listMembers(lead2).find(member => member.name === 'ghost')
      expect(row?.status).toBe('failed')
    }, { timeout: 8_000 })
    await resumed.fiber.dispose()
  })
})
