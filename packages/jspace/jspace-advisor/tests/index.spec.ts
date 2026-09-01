import { describe, expect, it } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import SubagentRuntime from '@shres-code/shres-code-subagent'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import { CallId, MessageId } from '@shres-code/shres-code-llm'
import { defineTool } from '@shres-code/shres-code-tools'
import JspaceService, { JSPACE_SETTINGS_NAMESPACE } from '@shres-code/shres-code-jspace'
import { SettingsProvider, type SettingsNamespace } from '@shres-code/shres-code-settings'
import * as Advisor from '../src/index.ts'

/** The smallest real settings provider: one in-memory document. */
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

/** In-memory agents registry: enough of ctx.agents for the proactive path. */
class StubAgents extends Service {
  private readonly agents = new Map<string, { id: string; session: unknown }>()

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  registerAgent(session: { id: string }): void {
    this.agents.set(session.id, { id: session.id, session })
  }

  get(id: string): { id: string; session: unknown } | undefined {
    return this.agents.get(id)
  }
}

/** Labels observed on reviewer-child start requests, newest last. */
const startLabels: (string | undefined)[] = []
/** Personas observed on one-shot consult starts, newest last. */
const startPersonas: (string | undefined)[] = []
/** Prompts observed on one-shot consult starts, newest last. */
const startPrompts: string[] = []

/** A spawn provider whose one-shot consult children settle a scripted reply. */
function registerSpawn(ctx: Context, behavior: 'verdict' | 'noredirect'): void {
  ctx.subagents.registerProvider({
    name: 'spawn',
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    start: async (request: {
      label?: string
      persona?: string
      prompt?: { text?: string }[]
      outputSchema?: { properties?: Record<string, unknown> }
    }) => {
      startLabels.push(request.label)
      startPersonas.push(request.persona)
      startPrompts.push((request.prompt ?? []).map(part => part.text ?? '').join(''))
      const structured = 'verdict' in (request.outputSchema?.properties ?? {})
        ? behavior === 'noredirect'
          ? { verdict: 'drift', advice: 'off course' }
          : { verdict: 'drift', advice: 'off course', redirect: 'drop X, do Y' }
        : { advice: 'off course', recommendation: 're-read the goal' }
      return {
        id: SessionId('child-1'),
        localAgent: undefined,
        result: Promise.resolve({
          stopReason: 'completed' as const,
          output: [{ type: 'text' as const, text: 'drifting' }],
          structured,
        }),
        dispose: async () => { /* scripted child has nothing to release */ },
      }
    },
    prepareContinuable: async () => ({}),
  })
}

const ENABLED: Advisor.Config = { enabled: true, provider: 'zai', model: 'glm-5.3' }

async function boot(
  advisorConfig: Advisor.Config = ENABLED,
  options: { spawn?: 'verdict' | 'noredirect'; agents?: boolean; jspaceEnabled?: boolean } = {},
): Promise<{ ctx: Context; advisorFiber: { dispose: () => Promise<void> } }> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  registerSpawn(ctx, options.spawn ?? 'verdict')
  await ctx.plugin(SessionStore)
  if (options.agents !== false) await ctx.plugin(StubAgents)
  await ctx.plugin(JspaceService, { enabled: options.jspaceEnabled === false ? false : true })
  const advisorFiber = await ctx.plugin(Advisor, advisorConfig)
  return { ctx, advisorFiber }
}


/** A live session handle for event-level assertions. */
async function liveSession(ctx: Context) {
  const session = ctx.sessions.create(SessionId('s-advisor'))
  const agents = ctx.get('agents') as StubAgents | undefined
  agents?.registerAgent(session)
  ctx.jspace.open(session, { goal: 'Ship the advisor', next: 'write specs' })
  return session
}

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error('condition not reached in time')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function adviceEvents(session: Session): SessionEvent<'jspace/advisor'>[] {
  return session.events.filter(
    (event): event is SessionEvent<'jspace/advisor'> => event.type === 'jspace/advisor',
  )
}

function consultExec(session: { id: string }) {
  return {
    signal: new AbortController().signal,
    callId: CallId('consult-call'),
    name: 'jspace_consult',
    arguments: { question: 'am I drifting?' },
    agent: { id: session.id, session } as never,
  }
}


/** What the patched continuable service recorded, for assertions. */
interface ContinuableLog {
  starts: number
  followups: number
  interrupts: number
  prompts: string[]
  personas: string[]
  childId: SessionId
  setBehavior: (behavior: 'verdict' | 'noredirect' | 'garbage' | 'fail' | 'hang') => void
}

/**
 * Patch the real subagent runtime's continuable operations with scripted
 * advisor children: every start/followup records its prompt and schedules the
 * child session's reply, so the plugin's verdict wait resolves through the
 * same global session-event channel production uses.
 */
function patchContinuable(ctx: Context): ContinuableLog {
  const log: ContinuableLog = {
    starts: 0,
    followups: 0,
    interrupts: 0,
    prompts: [],
    personas: [],
    childId: SessionId('advisor-child-1'),
    setBehavior: () => {},
  }
  let behavior: 'verdict' | 'noredirect' | 'garbage' | 'fail' | 'hang' = 'verdict'
  let child: Session | undefined
  log.setBehavior = (next) => { behavior = next }
  const deliverTurn = (): void => {
    if (behavior === 'hang' || behavior === 'fail') return
    const text = behavior === 'garbage'
      ? 'I could not tell.'
      : behavior === 'noredirect'
        ? '{"verdict":"drift","advice":"off course"}'
        : '{"verdict":"drift","advice":"off course","redirect":"drop X, do Y"}'
    const target = child ?? ctx.sessions.create(log.childId)
    child = target
    setTimeout(() => {
      target.append('assistant/message', {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      } as never, { surfaceOp: 'append' })
      target.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    }, 0)
  }
  const runtime = ctx.subagents as unknown as {
    startContinuable: (spec: {
      request: { prompt: { text?: string }[]; persona?: string }
    }) => Promise<{ childId: SessionId; messageId: MessageId }>
    followup: (parent: unknown, childId: SessionId, content: { text?: string }[]) => Promise<MessageId>
    interrupt: (target: SessionId, authority: unknown) => void
  }
  runtime.startContinuable = async (spec) => {
    log.starts += 1
    log.prompts.push(spec.request.prompt.map(part => part.text ?? '').join(''))
    log.personas.push(spec.request.persona ?? '')
    if (behavior === 'fail') throw new Error('stub start failure')
    deliverTurn()
    return { childId: log.childId, messageId: MessageId('m-' + String(log.starts)) }
  }
  runtime.followup = async (_parent, _childId, content) => {
    log.followups += 1
    log.prompts.push(content.map(part => part.text ?? '').join(''))
    deliverTurn()
    return MessageId('m-f' + String(log.followups))
  }
  runtime.interrupt = () => { log.interrupts += 1 }
  return log
}

describe('resolveConfig', () => {
  it('keeps enabled without a bound route unarmed', () => {
    const unbound = Advisor.resolveConfig({ enabled: true })
    expect(unbound.enabled).toBe(true)
    expect(unbound.provider).toBeUndefined()
    expect(Advisor.armed(unbound, { active: true, reason: 'enabled' } as never)).toBe(false)
    expect(Advisor.armed(
      Advisor.resolveConfig({ enabled: true, provider: 'zai' }),
      { active: true, reason: 'enabled' } as never,
    )).toBe(false)
  })

  it('rejects invalid numeric fields', () => {
    for (const field of ['maxDigestTools', 'maxDigestChars', 'maxExcerptChars', 'maxUserMessageChars',
      'maxUserHistoryChars', 'maxAdviceChars', 'maxArgChars', 'errorBurst', 'driftEverySteps', 'advisorySectionOrder']) {
      expect(() => Advisor.resolveConfig({ ...ENABLED, [field]: 0 })).toThrow(field)
    }
    expect(() => Advisor.resolveConfig({ ...ENABLED, driftEverySteps: 1 })).toThrow(/driftEverySteps/)
  })

  it('rejects an empty reviewer tool filter and defaults the spawn provider', () => {
    expect(() => Advisor.resolveConfig({ ...ENABLED, reviewerTools: [] })).toThrow(/reviewerTools/)
    expect(Advisor.resolveConfig(ENABLED).subagentProvider).toBe('spawn')
    expect(Advisor.resolveConfig({ ...ENABLED, subagentProvider: '  ' }).subagentProvider).toBe('spawn')
  })
})

describe('MAIN_SESSION_ADVISOR_RULES', () => {
  it('treats a Redirect as a suggestion, not an order', () => {
    expect(Advisor.MAIN_SESSION_ADVISOR_RULES).toContain('A Redirect is a suggestion')
    expect(Advisor.MAIN_SESSION_ADVISOR_RULES).not.toMatch(/act on a Redirect/)
    expect(Advisor.MAIN_SESSION_ADVISOR_RULES).toContain('stop tending the card')
  })
})

describe('armed', () => {
  it('needs enabled, a route, and an active seat', () => {
    const active = { active: true, reason: 'enabled' } as never
    const inactive = { active: false, reason: 'disabled' } as never
    expect(Advisor.armed(Advisor.resolveConfig({}), active)).toBe(false)
    expect(Advisor.armed(Advisor.resolveConfig(ENABLED), inactive)).toBe(false)
    expect(Advisor.armed(Advisor.resolveConfig(ENABLED), active)).toBe(true)
  })
})

describe('advisor apply', () => {
  it('remounts consult when settings enable a bound route', async () => {
    const { ctx } = await boot({ enabled: false })
    const session = await liveSession(ctx)
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('jspace_consult')
    await ctx.settings.replace(Advisor.ADVISOR_SETTINGS_NAMESPACE, { enabled: true })
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('jspace_consult')
    await ctx.settings.replace(Advisor.ADVISOR_SETTINGS_NAMESPACE, {
      enabled: true,
      provider: 'zai',
      model: 'glm-5.3',
    })
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('jspace_consult')
    const assembly = await ctx.systemPrompt.assemble({ agent: { id: session.id, session } } as never)
    expect(JSON.stringify(assembly)).toContain('call ward')
    await ctx.settings.replace(Advisor.ADVISOR_SETTINGS_NAMESPACE, { enabled: false })
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('jspace_consult')
    await ctx.fiber.dispose()
  })

  it('denies consult before a card opens', async () => {
    const { ctx } = await boot()
    const session = ctx.sessions.create(SessionId('s-no-card'))
    const result = await ctx.tools.execute(consultExec(session) as never)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('open J-Space card')
    await ctx.fiber.dispose()
  })

  it('returns the reviewer advice through consult', async () => {
    const { ctx } = await boot()
    const session = await liveSession(ctx)
    const result = await ctx.tools.execute(consultExec(session) as never)
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result)).toContain('off course')
    expect(startLabels.at(-1)).toBe('Advisor')
    expect(startPersonas.at(-1)).toContain('one-shot consult')
    expect(startPersonas.at(-1)).toContain('`advice`')
    expect(startPersonas.at(-1)).not.toContain('exactly one JSON object')
    expect(startPersonas.at(-1)).not.toContain('session_event_read')
    expect(startPrompts.at(-1)).not.toContain('session_event_read')
    await ctx.fiber.dispose()
  })

  it('does not advertise session_event_read when the name is filtered but unmounted', async () => {
    const { ctx } = await boot({
      ...ENABLED,
      reviewerTools: ['wiki_search', 'wiki_read', 'session_event_read'],
    })
    const session = await liveSession(ctx)
    const result = await ctx.tools.execute(consultExec(session) as never)
    expect(result.isError).toBe(false)
    expect(startPersonas.at(-1)).not.toContain('session_event_read')
    expect(startPrompts.at(-1)).not.toContain('session_event_read')
    await ctx.fiber.dispose()
  })

  it('advertises session_event_read on consult only when the tool is filtered and mounted', async () => {
    const { ctx } = await boot({
      ...ENABLED,
      reviewerTools: ['wiki_search', 'wiki_read', 'session_event_read'],
    })
    ctx.tools.register(defineTool({
      name: 'session_event_read',
      description: 'stub parent-event read',
      parameters: { seq: { type: 'number', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: {} } },
      execute: async () => ({}),
    }))
    const session = await liveSession(ctx)
    const result = await ctx.tools.execute(consultExec(session) as never)
    expect(result.isError).toBe(false)
    expect(startPersonas.at(-1)).toContain('session_event_read')
    expect(startPrompts.at(-1)).toContain('session_event_read')
    await ctx.fiber.dispose()
  })

  it('uses a custom standing persona on the continuable child', async () => {
    const { ctx } = await boot({ ...ENABLED, persona: 'custom standing voice' })
    const continuable = patchContinuable(ctx)
    const session = await liveSession(ctx)
    for (let step = 1; step <= 8; step += 1) session.append('step/end', { turn: 1, step })
    await until(() => adviceEvents(session).length === 1)
    expect(continuable.personas[0]).toBe('custom standing voice')
    await ctx.fiber.dispose()
  })

  it('runs a drift review on the step cadence and logs the verdict', async () => {
    const { ctx } = await boot()
    const continuable = patchContinuable(ctx)
    const session = await liveSession(ctx)
    for (let step = 1; step <= 8; step += 1) {
      session.append('step/end', { turn: 1, step })
    }
    await until(() => adviceEvents(session).length === 1)
    expect(continuable.starts).toBe(1)
    expect(continuable.personas[0]).toContain('standing reviewer of one main session')
    expect(continuable.personas[0]).toContain('exactly one JSON object')
    expect(continuable.personas[0]).not.toContain('session_event_read')
    expect(continuable.prompts[0]).toContain('reply with only the verdict JSON now')
    expect(continuable.prompts[0]).toContain('Main session id: s-advisor')
    const advice = adviceEvents(session)[0]?.data
    expect(advice?.trigger).toBe('drift-check')
    expect(advice?.triggerSeq).toBe(session.events.findLast(e => e.type === 'step/end')?.seq)
    expect(advice?.verdict).toBe('drift')
    expect(advice?.redirect).toBe('drop X, do Y')
    expect(advice?.childId).toBe(continuable.childId)
    await ctx.fiber.dispose()
  })

  it('reuses one standing advisor across reviews and sends deltas after the first turn', async () => {
    const { ctx } = await boot()
    const continuable = patchContinuable(ctx)
    const session = await liveSession(ctx)
    for (let step = 1; step <= 8; step += 1) session.append('step/end', { turn: 1, step })
    await until(() => adviceEvents(session).length === 1)
    for (let step = 1; step <= 16; step += 1) session.append('step/end', { turn: 2, step })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(adviceEvents(session)).toHaveLength(1)
    session.append('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'stay on the goal' }],
    } as never, { surfaceOp: 'append' })
    await until(() => adviceEvents(session).length === 2)
    expect(continuable.starts).toBe(1)
    expect(continuable.followups).toBe(1)
    expect(continuable.prompts[0]).not.toContain('since your last review')
    expect(continuable.prompts[1]).toContain('since your last review')
    expect(continuable.prompts[1]).toContain('N1: stay on the goal')
    await ctx.fiber.dispose()
  })

  it('renders the verdict and redirect in the prompt section', async () => {
    const { ctx } = await boot()
    patchContinuable(ctx)
    const session = await liveSession(ctx)
    for (let step = 1; step <= 8; step += 1) session.append('step/end', { turn: 1, step })
    await until(() => adviceEvents(session).length === 1)
    const assembly = await ctx.systemPrompt.assemble({ agent: { id: session.id, session } } as never)
    expect(JSON.stringify(assembly)).toContain('Drift: off course')
    expect(JSON.stringify(assembly)).toContain('Redirect: drop X, do Y')
    await ctx.fiber.dispose()
  })

  it('keeps the section and roster empty for agent-less, card-less, and advice-less assemblies', async () => {
    const { ctx } = await boot()
    const bare = await ctx.systemPrompt.assemble({} as never)
    expect(JSON.stringify(bare)).not.toContain('untrusted-jspace-advisor')
    expect(JSON.stringify(bare)).not.toContain('jspace_consult')
    const noCard = ctx.sessions.create(SessionId('s-no-card-2'))
    const noCardAssembly = await ctx.systemPrompt.assemble({ agent: { id: noCard.id, session: noCard } } as never)
    expect(JSON.stringify(noCardAssembly)).not.toContain('untrusted-jspace-advisor')
    expect(JSON.stringify(noCardAssembly)).not.toContain('jspace_consult')
    const fresh = await liveSession(ctx)
    const freshAssembly = await ctx.systemPrompt.assemble({ agent: { id: fresh.id, session: fresh } } as never)
    expect(JSON.stringify(freshAssembly)).toContain('jspace_consult')
    expect(JSON.stringify(freshAssembly)).toContain('call ward')
    expect(JSON.stringify(freshAssembly)).toContain('A Redirect is a suggestion')
    expect(JSON.stringify(freshAssembly)).not.toContain('act on a Redirect')
    expect(JSON.stringify(freshAssembly)).not.toContain('untrusted-jspace-advisor')
    await ctx.fiber.dispose()
  })

  it('renders an on-track verdict distinctly and skips advice forked from another session', async () => {
    const { ctx } = await boot()
    const session = await liveSession(ctx)
    session.append('step/end', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 2 })
    session.append('jspace/advisor', {
      sessionId: session.id,
      childId: SessionId('c1'),
      trigger: 'drift-check',
      triggerSeq: session.events[session.events.length - 2]?.seq,
      verdict: 'on-track',
      advice: 'serving the goal',
      seq: session.seq,
    } as never, { ignorable: true })
    session.append('jspace/advisor', {
      sessionId: 'another-session',
      childId: SessionId('c2'),
      trigger: 'drift-check',
      triggerSeq: session.events[session.events.length - 2]?.seq,
      verdict: 'drift',
      advice: 'forked noise',
      seq: session.seq,
    } as never, { ignorable: true })
    const assembly = await ctx.systemPrompt.assemble({ agent: { id: session.id, session } } as never)
    const rendered = JSON.stringify(assembly)
    expect(rendered).toContain('On track: serving the goal')
    expect(rendered).not.toContain('forked noise')
    await ctx.fiber.dispose()
  })


  it('withdraws the consult tool when the seat turns off and returns it after', async () => {
    const { ctx } = await boot()
    const session = await liveSession(ctx)
    const names = () => ctx.tools.schemas().map(schema => schema.name)
    expect(names()).toContain('jspace_consult')
    await ctx.settings.replace(JSPACE_SETTINGS_NAMESPACE, { enabled: false })
    expect(names()).not.toContain('jspace_consult')
    for (let step = 1; step <= 8; step += 1) session.append('step/end', { turn: 1, step })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(adviceEvents(session)).toHaveLength(0)
    await ctx.settings.replace(JSPACE_SETTINGS_NAMESPACE, { enabled: true })
    expect(names()).toContain('jspace_consult')
    await ctx.fiber.dispose()
  })

  it('aborts in-flight reviews when the advisor fiber disposes', async () => {
    const { ctx, advisorFiber } = await boot()
    const continuable = patchContinuable(ctx)
    continuable.setBehavior('hang')
    const session = await liveSession(ctx)
    for (let step = 1; step <= 8; step += 1) session.append('step/end', { turn: 1, step })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(continuable.starts).toBe(1)
    await advisorFiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(continuable.interrupts).toBe(1)
    expect(adviceEvents(session)).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('swallows a failing advisor start without logging advice', async () => {
    const { ctx } = await boot()
    const continuable = patchContinuable(ctx)
    continuable.setBehavior('fail')
    const session = await liveSession(ctx)
    for (let step = 1; step <= 8; step += 1) session.append('step/end', { turn: 1, step })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(continuable.starts).toBe(1)
    expect(adviceEvents(session)).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('reviews a ship stamp even after a landed verdict', async () => {
    const { ctx } = await boot()
    const continuable = patchContinuable(ctx)
    const session = await liveSession(ctx)
    for (let step = 1; step <= 8; step += 1) session.append('step/end', { turn: 1, step })
    await until(() => adviceEvents(session).length === 1)
    const card = ctx.jspace.card(session)
    session.append('jspace/shipped', {
      sessionId: session.id,
      goal: card?.goal ?? 'Ship the advisor',
      goalOpenedSeq: card?.goalOpenedSeq ?? 0,
    }, { ignorable: true })
    await until(() => adviceEvents(session).length === 2)
    expect(adviceEvents(session)[1]?.data.trigger).toBe('ship-attempt')
    expect(continuable.starts).toBe(1)
    expect(continuable.followups).toBe(1)
    await ctx.fiber.dispose()
  })

  it('cold-restarts the advisor after a verdict-less turn and cools down drift re-fires', async () => {
    const { ctx } = await boot()
    const continuable = patchContinuable(ctx)
    const session = await liveSession(ctx)
    continuable.setBehavior('garbage')
    for (let step = 1; step <= 8; step += 1) session.append('step/end', { turn: 1, step })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(continuable.starts).toBe(1)
    expect(adviceEvents(session)).toHaveLength(0)
    // The failed turn cools down cadence triggers: more steps do not re-fire.
    for (let step = 1; step <= 8; step += 1) session.append('step/end', { turn: 2, step })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(continuable.starts).toBe(1)
    // The user speaking again re-arms the review with a fresh advisor.
    continuable.setBehavior('verdict')
    session.append('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'try again' }],
    } as never, { surfaceOp: 'append' })
    await until(() => adviceEvents(session).length === 1)
    expect(continuable.starts).toBe(2)
    await ctx.fiber.dispose()
  })

  it('skips the proactive run when no agents service exists', async () => {
    const { ctx } = await boot(ENABLED, { agents: false })
    const session = await liveSession(ctx)
    for (let step = 1; step <= 8; step += 1) session.append('step/end', { turn: 1, step })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(adviceEvents(session)).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('registers nothing while the jspace seat is disabled', async () => {
    const { ctx } = await boot(ENABLED, { jspaceEnabled: false })
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('jspace_consult')
    await ctx.fiber.dispose()
  })

  it('mounts no proactive watcher when proactive is off', async () => {
    const { ctx } = await boot({ ...ENABLED, proactive: false })
    const session = await liveSession(ctx)
    for (let step = 1; step <= 8; step += 1) session.append('step/end', { turn: 1, step })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(adviceEvents(session)).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('ignores step cadence on a session with no open card', async () => {
    const { ctx } = await boot()
    const session = ctx.sessions.create(SessionId('s-cardless'))
    for (let step = 1; step <= 8; step += 1) session.append('step/end', { turn: 1, step })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(adviceEvents(session)).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('wakes the standing advisor on a human user message without waiting for the step cadence', async () => {
    const { ctx } = await boot()
    const continuable = patchContinuable(ctx)
    const session = await liveSession(ctx)
    session.append('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'do the thing' }],
    } as never, { surfaceOp: 'append' })
    await until(() => adviceEvents(session).length === 1)
    expect(adviceEvents(session)[0]?.data.trigger).toBe('user-intent')
    expect(continuable.starts).toBe(1)
    expect(continuable.prompts[0]).toContain('U1: do the thing')
    await ctx.fiber.dispose()
  })

  it('catches a second user message that arrived while a review was in flight', async () => {
    const { ctx } = await boot()
    const continuable = patchContinuable(ctx)
    const session = await liveSession(ctx)
    session.append('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'first ask' }],
    } as never, { surfaceOp: 'append' })
    session.append('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'second ask' }],
    } as never, { surfaceOp: 'append' })
    await until(() => continuable.followups === 1)
    expect(continuable.starts).toBe(1)
    expect(continuable.prompts[1]).toContain('N1: second ask')
    await ctx.fiber.dispose()
  })

  it('records drift advice without a redirect when the reviewer gives none', async () => {
    const { ctx } = await boot()
    const continuable = patchContinuable(ctx)
    continuable.setBehavior('noredirect')
    const session = await liveSession(ctx)
    for (let step = 1; step <= 8; step += 1) session.append('step/end', { turn: 1, step })
    await until(() => adviceEvents(session).length === 1)
    expect(adviceEvents(session)[0]?.data?.redirect).toBeUndefined()
    const assembly = await ctx.systemPrompt.assemble({ agent: { id: session.id, session } } as never)
    const rendered = JSON.stringify(assembly)
    expect(rendered).toContain('Drift: off course')
    expect(rendered).not.toContain('Redirect:')
    await ctx.fiber.dispose()
  })
})
