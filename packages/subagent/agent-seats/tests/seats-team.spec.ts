import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@shres-code/cordis'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import { mountAgentLoopTestDependencies } from '@shres-code/shres-code-agent-loop-testkit'
import { CallId } from '@shres-code/shres-code-llm'
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

async function bootTeamSeats() {
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
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    textResponse('aegis working'),
    textResponse('researcher working'),
    textResponse('generic child'),
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
