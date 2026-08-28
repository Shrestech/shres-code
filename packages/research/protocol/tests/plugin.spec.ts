import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import AgentRegistry, { Inbox } from '@shres-code/shres-code-agent'
import type { Agent } from '@shres-code/shres-code-agent'
import { CallId, createToolResultMessage } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime, { defineTool } from '@shres-code/shres-code-tools'
import JspaceService from '@shres-code/shres-code-jspace'
import { FileSettingsProvider } from '@shres-code/shres-code-settings-file'
import * as Protocol from '../src/index.ts'

let settingsRoot: string | undefined

afterEach(async () => {
  if (settingsRoot !== undefined) await rm(settingsRoot, { recursive: true, force: true })
  settingsRoot = undefined
})

const signal = new AbortController().signal

const gatedTool = defineTool({
  name: 'experiment_log_run',
  description: 'test double for the gated experiment tool',
  parameters: {},
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
    render: () => [{ type: 'text', text: 'logged' }],
  },
  async execute() {
    return { ok: true }
  },
  presentCall: () => ({ card: 'generic' as const, title: 'experiment_log_run', kind: 'other' as const, rawInput: {} }),
})

function liveAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx,
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() {
      return Promise.resolve()
    },
  }
  ctx.agents.register(agent)
  return agent
}

interface HarnessOptions {
  readonly protocol?: Protocol.Config
  readonly jspace?: ConstructorParameters<typeof JspaceService>[1]
  readonly settings?: boolean
}

async function harness(options: HarnessOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (options.settings === true) {
    settingsRoot = await mkdtemp(join(tmpdir(), 'shres-research-protocol-settings-'))
    ctx.plugin(FileSettingsProvider, { path: join(settingsRoot, 'settings.yaml'), watch: false })
  }
  if (options.jspace !== undefined) await ctx.plugin(JspaceService, options.jspace)
  await ctx.plugin(Protocol, options.protocol ?? {})
  ctx.tools.register(gatedTool)
  return ctx
}

function appendDebateCall(session: Agent['session'], name: string, callId: string): void {
  session.append('tool/call', { turn: 1, step: 1, callId: CallId(callId), name, arguments: '{}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: CallId(callId),
      content: [{ type: 'text', text: 'challenge recorded' }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
}

async function runGated(agent: Agent): Promise<string> {
  const result = await agent.ctx.tools.execute({
    signal,
    callId: CallId('g1'),
    name: 'experiment_log_run',
    arguments: {},
    agent,
  })
  return result.isError ? ((result.content[0] as { text?: string }).text ?? '') : 'logged'
}

async function sectionText(ctx: Context): Promise<string> {
  const assembled = await ctx.systemPrompt.assemble()
  return assembled.sections.find(section => section.name === Protocol.RESEARCH_PROTOCOL_SECTION_NAME)?.text ?? ''
}

describe('research-protocol section', () => {
  it('mounts empty while disabled', async () => {
    const ctx = await harness({ protocol: { enabled: false } })
    expect(await sectionText(ctx)).toBe('')
  })

  it('mounts the cycle text while enabled', async () => {
    const ctx = await harness({ protocol: { enabled: true } })
    expect(await sectionText(ctx)).toContain('research:protocol')
    expect(await sectionText(ctx)).toContain('experiment_verify_decision_rule')
  })

  it('flips with the autoresearch settings namespace without a remount', async () => {
    const ctx = await harness({ protocol: { enabled: false }, settings: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await sectionText(ctx)).toBe('')
    await ctx.settings.update(Protocol.AUTORESEARCH_SETTINGS_NAMESPACE, { enabled: true })
    expect(await sectionText(ctx)).toContain('research:protocol')
    await ctx.settings.update(Protocol.AUTORESEARCH_SETTINGS_NAMESPACE, { enabled: false })
    expect(await sectionText(ctx)).toBe('')
  })
})

describe('design-defense gate', () => {
  it('allows gated calls while disabled', async () => {
    const ctx = await harness({ protocol: { enabled: false } })
    expect(await runGated(liveAgent(ctx, 'ws-gate-off'))).toBe('logged')
  })

  it('allows gated calls when requireDesignDefense is off', async () => {
    const ctx = await harness({ protocol: { enabled: true, requireDesignDefense: 'off' } })
    expect(await runGated(liveAgent(ctx, 'ws-gate-mode-off'))).toBe('logged')
  })

  it('allows ungated tools even with the defense required', async () => {
    const ctx = await harness({ protocol: { enabled: true } })
    const agent = liveAgent(ctx, 'ws-gate-ungated')
    const result = await agent.ctx.tools.execute({
      signal,
      callId: CallId('u1'),
      name: 'experiment_query',
      arguments: {},
      agent,
    })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text?: string }).text).not.toContain(Protocol.DESIGN_DEFENSE_DENY_PREFIX)
  })

  it('denies a gated call naming every missing debate tool', async () => {
    const ctx = await harness({ protocol: { enabled: true } })
    const refusal = await runGated(liveAgent(ctx, 'ws-gate-deny'))
    expect(refusal).toContain(Protocol.DESIGN_DEFENSE_DENY_PREFIX)
    expect(refusal).toContain('aegis, ward')
  })

  it('honors custom debate tool names from config', async () => {
    const ctx = await harness({ protocol: { enabled: true, debateTools: ['solo-reviewer'] } })
    const refusal = await runGated(liveAgent(ctx, 'ws-gate-custom'))
    expect(refusal).toContain('completed calls missing for: solo-reviewer')
  })

  it('allows a gated call once every debate tool completed in the epoch', async () => {
    const ctx = await harness({ protocol: { enabled: true } })
    const agent = liveAgent(ctx, 'ws-gate-pass')
    appendDebateCall(agent.session, 'aegis', 'a1')
    appendDebateCall(agent.session, 'ward', 'w1')
    expect(await runGated(agent)).toBe('logged')
  })

  it('anchors on the card epoch: pre-card calls satisfy nothing and a new Goal re-arms the gate', async () => {
    const ctx = await harness({ protocol: { enabled: true }, jspace: { enabled: true } })
    const agent = liveAgent(ctx, 'ws-gate-epoch')
    appendDebateCall(agent.session, 'aegis', 'a-old')
    appendDebateCall(agent.session, 'ward', 'w-old')
    ctx.jspace.open(agent.session, { goal: 'first hypothesis', next: 'debate' })
    expect(await runGated(agent)).toContain(Protocol.DESIGN_DEFENSE_DENY_PREFIX)

    appendDebateCall(agent.session, 'aegis', 'a-new')
    appendDebateCall(agent.session, 'ward', 'w-new')
    expect(await runGated(agent)).toBe('logged')

    ctx.jspace.close(agent.session)
    ctx.jspace.open(agent.session, { goal: 'second hypothesis', next: 'debate again' })
    expect(await runGated(agent)).toContain(Protocol.DESIGN_DEFENSE_DENY_PREFIX)
  })

  it('anchors at session start when the seat is mounted without a card, still requiring the defense', async () => {
    const ctx = await harness({ protocol: { enabled: true }, jspace: { enabled: true } })
    const agent = liveAgent(ctx, 'ws-gate-no-card')
    const refusal = await runGated(agent)
    expect(refusal).toContain(Protocol.DESIGN_DEFENSE_DENY_PREFIX)
    appendDebateCall(agent.session, 'aegis', 'a1')
    appendDebateCall(agent.session, 'ward', 'w1')
    expect(await runGated(agent)).toBe('logged')
  })

  it('anchors at session start when the seat is mounted but disabled', async () => {
    const ctx = await harness({ protocol: { enabled: true }, jspace: { enabled: false } })
    const agent = liveAgent(ctx, 'ws-gate-seat-off')
    const refusal = await runGated(agent)
    expect(refusal).toContain(Protocol.DESIGN_DEFENSE_DENY_PREFIX)
  })

  it('lets a gated call through when no session is attached', async () => {
    const ctx = await harness({ protocol: { enabled: true } })
    const result = await ctx.tools.execute({
      signal,
      callId: CallId('s1'),
      name: 'experiment_log_run',
      arguments: {},
    })
    expect(result.isError).toBe(false)
  })
})

describe('config resolution', () => {
  it('rejects blank tool names outside Loader normalization', () => {
    expect(() => {
      Protocol.apply(new Context(), { debateTools: ['   '] })
    }).toThrow(TypeError)
  })

  it('rejects an unknown defense mode outside Loader normalization', () => {
    expect(() => {
      Protocol.apply(new Context(), { requireDesignDefense: 'whenever' as never })
    }).toThrow(TypeError)
  })

  it('defaults to disabled and gates nothing until enabled', async () => {
    const ctx = await harness()
    expect(await sectionText(ctx)).toBe('')
    expect(await runGated(liveAgent(ctx, 'ws-gate-defaults'))).toBe('logged')
  })
})
