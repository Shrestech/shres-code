import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@shres-code/cordis'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import { mountAgentLoopTestDependencies } from '@shres-code/shres-code-agent-loop-testkit'
import { CallId, LlmAdapter } from '@shres-code/shres-code-llm'
import type { GenerateOptions, StreamChunk } from '@shres-code/shres-code-llm'
import { SessionId } from '@shres-code/shres-code-session'
import JsonlSessionPersistence from '@shres-code/shres-code-session-persistence-jsonl'
import SessionProjectionRegistry from '@shres-code/shres-code-session-projection'
import { SettingsProvider, type SettingsNamespace } from '@shres-code/shres-code-settings'
import SubagentRuntime from '@shres-code/shres-code-subagent'
import * as SubagentSpawn from '@shres-code/shres-code-subagent-spawn-in-process'
import * as AgentTeamPlugin from '@shres-code/shres-code-agent-team'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as seats from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const SIGNAL = new AbortController().signal

class GatedAdapter extends LlmAdapter {
  constructor(private script: { chunks: StreamChunk[]; gate?: Promise<undefined> }[]) {
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

async function bootTeamSeats(adapter?: LlmAdapter) {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'shres-seats-team-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(seats)
  await ctx.plugin(AgentTeamPlugin)
  ctx.llm.registerAdapter(['mock'], adapter ?? new MockAdapter([
    textResponse('aegis working'),
    textResponse('researcher working'),
    textResponse('generic child'),
    textResponse('stride working'),
    textResponse('stride after mail'),
    textResponse('extra child'),
  ]))
  const lead = ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent.id !== lead.id) return next()
    return { kind: 'reject' as const }
  })
  return { ctx, lead }
}

let calls = 0
function callTool(ctx: Context, name: string, args: unknown, agent: unknown) {
  return ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId(`call-${++calls}`),
    name,
    arguments: args,
    agent: agent as never,
  })
}

describe('agent-seats wired to Agent Teams', () => {
  it('remounts bound seats as Team-steer tools, lists YAML extras, and team_sends them', async () => {
    const { ctx, lead } = await bootTeamSeats()
    await ctx.settings.replace(seats.AGENT_SEATS_SETTINGS_NAMESPACE, {
      seats: {
        aegis: { provider: 'mock', model: 'mock' },
        stride: { provider: 'mock', model: 'mock' },
        subagent: { provider: 'mock', model: 'mock' },
      },
      extras: [{
        name: 'researcher',
        persona: 'You are Researcher.',
        provider: 'mock',
        model: 'mock',
        role: 'Researcher',
      }],
    })

    const aegis = ctx.tools.schemas().find(schema => schema.name === 'aegis')
    expect(aegis?.description).toContain('Agent Team')
    expect(aegis?.description).toContain('Team mail')
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(
      expect.arrayContaining(['aegis', 'stride', 'team_send', 'team_list', 'subagent']),
    )
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('ward')

    const listedTool = await callTool(ctx, 'team_list', {}, lead)
    expect(listedTool.isError).toBe(false)
    const listMissing = await ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId(`call-${++calls}`),
      name: 'team_list',
      arguments: {},
    })
    expect(listMissing.isError).toBe(true)
    const listed = ctx.agentTeams.listMembers(lead).map(row => row.name)
    expect(listed).toEqual(expect.arrayContaining(['lead', 'aegis', 'stride', 'researcher']))
    expect(listed).not.toContain('subagent')
    expect(listed.filter(name => name === 'researcher')).toHaveLength(1)

    const mailed = await callTool(ctx, 'team_send', {
      target: 'researcher',
      message: 'search the repo',
    }, lead)
    const mailedText = mailed.content.map(block => 'text' in block ? block.text : '').join('')
    expect(mailedText, mailed.isError ? mailedText : 'ok').not.toMatch(/error|Error|TEAM_/)
    expect(mailed.isError).toBe(false)
    expect(ctx.agentTeams.listMembers(lead).some(row => row.name === 'researcher' && row.status !== 'failed')).toBe(true)

    const steered = await callTool(ctx, 'aegis', {
      description: 'plan',
      prompt: 'Design billing.',
    }, lead)
    const steeredText = steered.content.map(block => 'text' in block ? block.text : '').join('')
    expect(steeredText, steered.isError ? steeredText : 'ok').toContain('aegis')
    expect(steered.isError).toBe(false)
    expect(String(steered.content.map(block => 'text' in block ? block.text : '').join(''))).toContain('aegis')

    const missing = await ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId(`call-${++calls}`),
      name: 'aegis',
      arguments: { description: 'x', prompt: 'y' },
    })
    expect(missing.isError).toBe(true)

    await ctx.settings.replace(seats.AGENT_SEATS_SETTINGS_NAMESPACE, {
      seats: {
        aegis: { provider: 'mock', model: 'mock' },
        stride: { provider: 'mock', model: 'mock' },
        subagent: { provider: 'mock', model: 'mock' },
      },
      extras: [{
        name: 'scout',
        persona: 'You are Scout.',
        provider: 'mock',
        model: 'mock',
      }],
    })
    expect(ctx.agentTeams.listMembers(lead).some(row => row.name === 'scout')).toBe(true)
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(
      expect.arrayContaining(['aegis', 'stride', 'subagent']),
    )
    await ctx.fiber.dispose()
  })

  it('lets a teammate steer an already-active named seat', async () => {
    let releaseAegis!: () => void
    let releaseStride!: () => void
    const aegisGate = new Promise<undefined>((resolve) => {
      releaseAegis = () => { resolve(undefined) }
    })
    const strideGate = new Promise<undefined>((resolve) => {
      releaseStride = () => { resolve(undefined) }
    })
    const { ctx, lead } = await bootTeamSeats(new GatedAdapter([
      { chunks: textResponse('aegis working'), gate: aegisGate },
      { chunks: textResponse('stride working'), gate: strideGate },
    ]))
    await ctx.settings.replace(seats.AGENT_SEATS_SETTINGS_NAMESPACE, {
      seats: {
        aegis: { provider: 'mock', model: 'mock' },
        stride: { provider: 'mock', model: 'mock' },
      },
    })
    const first = await callTool(ctx, 'aegis', { description: 'plan', prompt: 'Design billing.' }, lead)
    expect(first.isError).toBe(false)
    const second = await callTool(ctx, 'stride', { description: 'impl', prompt: 'Write the handler.' }, lead)
    expect(second.isError).toBe(false)
    const aegisId = ctx.agentTeams.listMembers(lead).find(row => row.name === 'aegis')?.id
    expect(aegisId).toBeDefined()
    const aegisAgent = ctx.agents.get(aegisId!)
    expect(aegisAgent).toBeDefined()
    expect(aegisAgent!.ctx.tools.schemas(aegisAgent).map(schema => schema.name)).not.toContain('stride')
    expect(aegisAgent!.ctx.tools.schemas(aegisAgent).map(schema => schema.name)).not.toContain('aegis')
    const mailed = await callTool(ctx, 'team_send', {
      target: 'stride',
      message: 'Keep the handler bounded.',
    }, aegisAgent)
    const mailedText = mailed.content.map(block => 'text' in block ? block.text : '').join('')
    expect(mailedText, mailed.isError ? mailedText : 'ok').toContain('stride')
    expect(mailed.isError).toBe(false)
    const self = await callTool(ctx, 'aegis', { description: 'x', prompt: 'y' }, aegisAgent)
    expect(self.isError).toBe(true)
    releaseAegis()
    releaseStride()
    await ctx.fiber.dispose()
  })

  it('starts a named seat with the Lead prompt as the child system prompt', async () => {
    let releaseAegis!: () => void
    const aegisGate = new Promise<undefined>((resolve) => {
      releaseAegis = () => { resolve(undefined) }
    })
    const { ctx, lead } = await bootTeamSeats(new GatedAdapter([
      { chunks: textResponse('aegis working'), gate: aegisGate },
    ]))
    await ctx.settings.replace(seats.AGENT_SEATS_SETTINGS_NAMESPACE, {
      seats: { aegis: { provider: 'mock', model: 'mock' } },
    })
    const role = 'You are the Architect seat. Probe shres-verity. Do not invent structure.'
    const workspace = mkdtempSync(join(tmpdir(), 'shres-seat-cwd-'))
    roots.push(workspace)
    let started: { prompt?: unknown; persona?: string; cwd?: string; toolFilter?: unknown } = {}
    const orig = ctx.subagents.startContinuable.bind(ctx.subagents)
    const spy = vi.spyOn(ctx.subagents, 'startContinuable').mockImplementation(async (spec) => {
      started = {
        prompt: spec.request.prompt,
        persona: spec.request.persona,
        cwd: spec.request.cwd,
        toolFilter: spec.request.toolFilter,
      }
      return orig(spec)
    })
    const steered = await callTool(ctx, 'aegis', {
      description: 'Architecture probe: shres-verity',
      prompt: role,
      cwd: workspace,
    }, lead)
    expect(steered.isError).toBe(false)
    expect(started.persona).toBe(role)
    expect(started.prompt).toEqual([{ type: 'text', text: role }])
    expect(started.cwd).toBe(workspace)
    expect(started.toolFilter).toEqual({ deny: ['aegis'] })
    const aegisId = ctx.agentTeams.listMembers(lead).find(row => row.name === 'aegis')?.id
    const child = ctx.agents.get(aegisId!)!
    expect(child.session.header.cwd).toBe(workspace)
    expect(child.ctx.tools.schemas(child).map(schema => schema.name)).not.toContain('aegis')
    expect(child.ctx.tools.schemas(child).map(schema => schema.name)).toEqual(
      expect.arrayContaining(['team_send', 'team_list']),
    )
    spy.mockRestore()
    releaseAegis()
    await ctx.fiber.dispose()
  })

  it('pins seats.subagent later without remounting already-bound seat tools', async () => {
    const { ctx } = await bootTeamSeats()
    await ctx.settings.replace(seats.AGENT_SEATS_SETTINGS_NAMESPACE, {
      seats: { aegis: { provider: 'mock', model: 'mock' } },
    })
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('aegis')
    await ctx.settings.replace(seats.AGENT_SEATS_SETTINGS_NAMESPACE, {
      seats: {
        aegis: { provider: 'mock', model: 'mock' },
        subagent: { provider: 'mock', model: 'mock' },
      },
    })
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(
      expect.arrayContaining(['aegis', 'subagent']),
    )
    await ctx.fiber.dispose()
  })

  it('standard and code presets disable unpinned tool-subagent so seats.subagent can pin the hire', () => {
    for (const presetName of ['standard', 'code'] as const) {
      const preset = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), `../../../../apps/cli/config/agent-presets/${presetName}/agent.cordis.yml`),
        'utf8',
      )
      expect(preset, presetName).toMatch(
        /- id: tool-subagent\n      name: '@shres-code\/shres-code-tool-subagent'\n      disabled: true/,
      )
    }
  })
})
