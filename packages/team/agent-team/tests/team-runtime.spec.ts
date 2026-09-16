import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@shres-code/cordis'
import { assembleContextFor, type Agent } from '@shres-code/shres-code-agent'
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
import { renderPrompt } from '@shres-code/shres-code-system-prompt'
import * as AgentTeamPlugin from '../src/index.ts'
import { ENVIRONMENT_SECTION } from '@shres-code/shres-code-subagent'
import { TEAM_POLICY_SECTION, teammatePolicy } from '../src/policy.ts'
import { teammateSeatGuard } from '../src/roster.ts'


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
        event.type === 'user/message')
      expect(targetMail.some(event => event.type === 'user/message'
        && event.data.source.kind === 'team-message'
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
      textResponse('notes ready'),
    ]))
    ctx.agentTeams.setRosterTemplate(() => [{
      name: 'researcher',
      description: 'Researcher',
      persona: 'You are Researcher.',
      provider: 'mock',
      model: 'mock',
    }, {
      name: 'notes',
      description: 'notes',
      provider: 'mock',
    }])
    expect(ctx.agentTeams.listMembers(lead).map(row => row.name)).toContain('researcher')
    const sent = await ctx.agentTeams.sendMessage(lead, {
      target: 'researcher',
      content: content('look this up'),
      signal: SIGNAL,
    })
    expect(['accepted', 'queued']).toContain(sent.status)
    const notes = await ctx.agentTeams.sendMessage(lead, {
      target: 'notes',
      content: content('take a note'),
      signal: SIGNAL,
    })
    expect(['accepted', 'queued']).toContain(notes.status)
    const names = ctx.agentTeams.listMembers(lead).map(row => row.name)
    expect(names).toContain('researcher')
    expect(names).toContain('notes')
    expect(names).not.toContain('subagent')
    await ctx.fiber.dispose()
  })

  it('uses the Lead-sent role as the child system prompt instead of the template persona', async () => {
    const { ctx, lead } = await setup(new MockAdapter([textResponse('aegis ready')]))
    const shipped = 'You are Aegis, the shipped Architect.'
    const role = 'You are the Architect seat. Probe /tmp/verity. Do not invent structure.'
    ctx.agentTeams.setRosterTemplate(() => [{
      name: 'aegis',
      description: 'Architect',
      persona: shipped,
      provider: 'mock',
      model: 'mock',
    }])
    let started: { prompt?: unknown; persona?: string } = {}
    const orig = ctx.subagents.startContinuable.bind(ctx.subagents)
    const spy = vi.spyOn(ctx.subagents, 'startContinuable').mockImplementation(async (spec) => {
      started = { prompt: spec.request.prompt, persona: spec.request.persona }
      return orig(spec)
    })
    const sent = await ctx.agentTeams.sendMessage(lead, {
      target: 'aegis',
      content: [
        { type: 'reasoning', text: 'ignore' },
        { type: 'text', text: 'Architecture probe: shres-verity' },
      ],
      persona: role,
      signal: SIGNAL,
    })
    expect(sent.status).toBe('accepted')
    expect(started.persona).toBe(role)
    expect(started.prompt).toEqual([
      { type: 'reasoning', text: 'ignore' },
      { type: 'text', text: 'Architecture probe: shres-verity' },
    ])
    spy.mockRestore()
    await ctx.fiber.dispose()
  })

  it('keeps the shipped persona when the Lead sends no role and uses a role on an empty assignment', async () => {
    const { ctx, lead } = await setup(new MockAdapter([
      textResponse('aegis ready'),
      textResponse('ward ready'),
      textResponse('notes ready'),
    ]))
    const shipped = 'You are Aegis, the shipped Architect.'
    const reviewRole = 'You are the Reviewer seat. Report findings only.'
    ctx.agentTeams.setRosterTemplate(() => [{
      name: 'aegis',
      description: 'Architect',
      persona: shipped,
      provider: 'mock',
      model: 'mock',
    }, {
      name: 'ward',
      description: 'Reviewer',
      persona: 'You are Ward, the shipped Reviewer.',
      provider: 'mock',
      model: 'mock',
    }, {
      name: 'notes',
      description: 'notes',
      provider: 'mock',
    }])
    const seen: { prompt?: unknown; persona?: string }[] = []
    const orig = ctx.subagents.startContinuable.bind(ctx.subagents)
    const spy = vi.spyOn(ctx.subagents, 'startContinuable').mockImplementation(async (spec) => {
      seen.push({ prompt: spec.request.prompt, persona: spec.request.persona })
      return orig(spec)
    })
    await ctx.agentTeams.sendMessage(lead, {
      target: 'aegis',
      content: content('look this up'),
      persona: '   ',
      signal: SIGNAL,
    })
    await ctx.agentTeams.sendMessage(lead, {
      target: 'ward',
      content: content('   '),
      persona: reviewRole,
      signal: SIGNAL,
    })
    await ctx.agentTeams.ensureTemplateMember(lead, 'notes', [])
    expect(seen[0]?.persona).toBe(shipped)
    expect(seen[0]?.prompt).toEqual(content('look this up'))
    expect(seen[1]?.persona).toBe(reviewRole)
    expect(seen[1]?.prompt).toEqual(content('You are ward. Reviewer'))
    expect(seen[2]?.persona).toBeUndefined()
    expect(seen[2]?.prompt).toEqual(content('You are notes.'))
    spy.mockRestore()
    await ctx.fiber.dispose()
  })

  it('provisions a teammate in an explicit workspace and installs team policy', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'shres-team-cwd-'))
    let releaseAegis!: () => void
    const aegisGate = new Promise<undefined>((resolve) => {
      releaseAegis = () => { resolve(undefined) }
    })
    const { ctx, lead } = await setup(new GatedAdapter([
      { chunks: textResponse('aegis ready'), gate: aegisGate },
    ]))
    ctx.agentTeams.setRosterTemplate(() => [{
      name: 'aegis',
      description: 'Architect',
      persona: 'You are Aegis.',
      provider: 'mock',
      model: 'mock',
    }])
    const sent = await ctx.agentTeams.sendMessage(lead, {
      target: 'aegis',
      content: content('Design the approach.'),
      cwd: workspace,
      signal: SIGNAL,
    })
    expect(sent.status).toBe('accepted')
    const row = ctx.agentTeams.listMembers(lead).find(member => member.name === 'aegis')
    expect(row).toBeDefined()
    const child = ctx.agents.get(row!.id)!
    expect(child.session.header.cwd).toBe(workspace)
    expect(lead.session.events.filter(event => event.type === 'team/message/queued')).toHaveLength(1)
    expect(lead.session.events.filter(event => event.type === 'team/message/delivered')).toHaveLength(1)
    const firstUser = child.session.events.find(event => event.type === 'user/message')
    expect(firstUser?.data.source).toMatchObject({
      kind: 'team-message',
      messageId: sent.messageId,
    })
    expect(firstUser?.data.content).toEqual(content('Design the approach.'))
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(child))
    expect(assembly.sections.find(section => section.name === TEAM_POLICY_SECTION)?.text)
      .toBe(teammatePolicy('aegis'))
    expect(assembly.sections.find(section => section.name === ENVIRONMENT_SECTION)?.text)
      .toBe('Your working directory is {{cwd}}.')
    expect(renderPrompt(assembly)).toContain(`Your working directory is ${workspace}`)
    const leadAssembly = await ctx.systemPrompt.assemble(assembleContextFor(lead))
    expect(leadAssembly.sections.some(section => section.name === TEAM_POLICY_SECTION)).toBe(false)
    expect(leadAssembly.sections.some(section => section.name === ENVIRONMENT_SECTION)).toBe(false)
    releaseAegis()
    await ctx.fiber.dispose()
    rmSync(workspace, { recursive: true, force: true })
  })

  it('rejects a cwd after the teammate is already active', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'shres-team-cwd-late-'))
    const { ctx, lead } = await setup(new MockAdapter([textResponse('aegis ready')]))
    ctx.agentTeams.setRosterTemplate(() => [{
      name: 'aegis',
      description: 'Architect',
      provider: 'mock',
      model: 'mock',
    }])
    await ctx.agentTeams.sendMessage(lead, {
      target: 'aegis',
      content: content('Design the approach.'),
      signal: SIGNAL,
    })
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'aegis',
      content: content('later'),
      cwd: workspace,
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await ctx.fiber.dispose()
    rmSync(workspace, { recursive: true, force: true })
  })

  it('rejects an oversized first assignment before spawning the teammate', async () => {
    const { ctx, lead } = await setup(new MockAdapter([]), { maxMessageBytes: 32 })
    ctx.agentTeams.setRosterTemplate(() => [{
      name: 'aegis',
      description: 'Architect',
      provider: 'mock',
      model: 'mock',
    }])
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'aegis',
      content: content('this first assignment is far too large for the mailbox'),
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_TOO_LARGE' })
    expect(ctx.agentTeams.listMembers(lead).some(member => member.name === 'aegis' && member.status !== 'inactive'))
      .toBe(false)
    await ctx.fiber.dispose()
  })

  it('honors the caller abort signal on first provision', async () => {
    const { ctx, lead } = await setup(new MockAdapter([]))
    ctx.agentTeams.setRosterTemplate(() => [{
      name: 'aegis',
      description: 'Architect',
      provider: 'mock',
      model: 'mock',
    }])
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'aegis',
      content: content('Design the approach.'),
      signal: controller.signal,
    })).rejects.toThrow()
    expect(ctx.agentTeams.listMembers(lead).some(member => member.name === 'aegis' && member.status !== 'inactive'))
      .toBe(false)
    await ctx.fiber.dispose()
  })

  it('rejects a teammate cwd that is not an accessible directory', async () => {
    const { ctx, lead } = await setup(new MockAdapter([]))
    ctx.agentTeams.setRosterTemplate(() => [{
      name: 'aegis',
      description: 'Architect',
      provider: 'mock',
      model: 'mock',
    }])
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'aegis',
      content: content('Design the approach.'),
      cwd: join(tmpdir(), 'shres-missing-team-cwd'),
      signal: SIGNAL,
    })).rejects.toThrow('not an accessible directory')
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

  it('joins concurrent first-use of the same name and waits for in-flight provisioning', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { ctx, lead } = await setup(new MockAdapter([
      textResponse('aegis done'),
      textResponse('aegis after first mail'),
      textResponse('aegis after second mail'),
    ]))
    ctx.agentTeams.setRosterTemplate(() => [{
      name: 'aegis',
      description: 'Architect',
      provider: 'mock',
      model: 'mock',
    }])
    const orig = ctx.subagents.startContinuable.bind(ctx.subagents)
    vi.spyOn(ctx.subagents, 'startContinuable').mockImplementation(async (spec) => {
      await gate
      return orig(spec)
    })
    const first = ctx.agentTeams.sendMessage(lead, {
      target: 'aegis',
      content: content('plan one'),
      signal: SIGNAL,
    })
    await vi.waitFor(() => {
      expect(ctx.agentTeams.listMembers(lead).some(row => row.name === 'aegis' && row.status === 'provisioning')).toBe(true)
    }, { timeout: 5_000 })
    const second = ctx.agentTeams.sendMessage(lead, {
      target: 'aegis',
      content: content('plan two'),
      signal: SIGNAL,
    })
    const joined = spawn(ctx, lead, 'aegis')
    release()
    const [left, right, same] = await Promise.all([first, second, joined])
    expect(left.messageId).not.toBe(right.messageId)
    expect(['accepted', 'queued']).toContain(left.status)
    expect(['accepted', 'queued']).toContain(right.status)
    expect(same.member.name).toBe('aegis')
    expect(ctx.agentTeams.listMembers(lead).filter(row => row.name === 'aegis')).toHaveLength(1)
    expect(ctx.agentTeams.listMembers(lead).some(row => row.name === 'aegis' && row.status !== 'provisioning')).toBe(true)
    await ctx.fiber.dispose()
  })

  it('lets a teammate mail an active seat and refuses teammate provision of a missing name', async () => {
    let releaseAegis!: () => void
    let releaseStride!: () => void
    const aegisGate = new Promise<undefined>((resolve) => {
      releaseAegis = () => { resolve(undefined) }
    })
    const strideGate = new Promise<undefined>((resolve) => {
      releaseStride = () => { resolve(undefined) }
    })
    const { ctx, lead } = await setup(new GatedAdapter([
      { chunks: textResponse('aegis working'), gate: aegisGate },
      { chunks: textResponse('stride working'), gate: strideGate },
    ]))
    ctx.agentTeams.setRosterTemplate(() => [{
      name: 'researcher',
      description: 'Researcher',
      provider: 'mock',
      model: 'mock',
    }])
    const aegis = await spawn(ctx, lead, 'aegis')
    const stride = await spawn(ctx, lead, 'stride')
    const aegisAgent = ctx.agents.get(aegis.member.id)
    expect(aegisAgent).toBeDefined()
    await ctx.agentTeams.ensureTemplateMember(aegisAgent!, 'stride')
    const mailed = await ctx.agentTeams.sendMessage(aegisAgent!, {
      target: 'stride',
      content: content('review this'),
      signal: SIGNAL,
    })
    expect(['accepted', 'queued']).toContain(mailed.status)
    expect(stride.member.name).toBe('stride')
    await expect(ctx.agentTeams.sendMessage(aegisAgent!, {
      target: 'researcher',
      content: content('look this up'),
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    releaseAegis()
    releaseStride()
    await ctx.fiber.dispose()
  })

  it('refuses leftover provisioning that has no in-flight creator', async () => {
    const { ctx, lead } = await setup(new MockAdapter([]))
    lead.session.append('team/member', {
      teamId: TeamId(lead.id),
      member: {
        id: SessionId('leftover-child'),
        name: 'leftover',
        description: 'stuck',
        provider: 'spawn',
        context: 'fresh',
        phase: 'provisioning',
      },
    }, { ignorable: true })
    await ctx.sessions.flush(lead.session)
    await expect(ctx.agentTeams.ensureTemplateMember(lead, 'leftover')).rejects.toMatchObject({
      code: 'TEAM_MEMBER_NOT_FOUND',
    })
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

describe('teammateSeatGuard', () => {
  it('denies named seat tools and leaves other names unchanged', () => {
    expect(teammateSeatGuard({ name: 'aegis' })).toMatch(/team_send/)
    expect(teammateSeatGuard({ name: 'stride' })).toMatch(/team_send/)
    expect(teammateSeatGuard({ name: 'ward' })).toMatch(/team_send/)
    expect(teammateSeatGuard({ name: 'team_send' })).toBeUndefined()
  })
})
