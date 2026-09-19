/**
 * The ladder over a real `Context` and session store: which sessions it
 * engages, the cooldown that keeps a standing trigger from writing a decision
 * per event, the payload it logs, and the report-blocked terminal it reaches
 * after `maxContinues`. The Team mailbox is the one substituted service (a
 * test double, because delivery is an external boundary); the session log, the
 * committed-event watch, the folds, and the digest are the shipped ones.
 *
 * The suite drives real appends, so a decision is written by the same
 * microtask-scheduled evaluation production runs.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import JspaceService from '@shres-code/shres-code-jspace'
import { CallId, createToolResultMessage } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import * as WorkerEscalation from '../src/index.ts'
import type { WorkerEscalationConfig } from '../src/config.ts'

/** One message the ladder asked the Team mailbox to deliver. */
interface SentMail {
  readonly target: string
  readonly text: string
}

/** Team mailbox double; delivery is the one external boundary this suite substitutes. */
class StubTeamMailbox extends Service {
  readonly sent: SentMail[] = []
  private behavior: 'accept' | 'refuse' | 'hang' = 'accept'

  constructor(ctx: Context) {
    super(ctx, 'agentTeams')
  }

  /** Choose what the next send does: succeed, reject, or never settle. */
  setBehavior(next: 'accept' | 'refuse' | 'hang'): void {
    this.behavior = next
  }

  /**
   * Record one send and answer per the configured behavior.
   * @param request - the target, content, and signal the ladder sent.
   * @returns an accepted mailbox result.
   */
  sendMessage(_agent: unknown, request: { readonly target: string; readonly content: readonly { readonly type: string; readonly text?: string }[]; readonly signal: AbortSignal }): Promise<{ messageId: string; status: 'accepted' }> {
    this.sent.push({ target: request.target, text: request.content.map(part => part.text ?? '').join('') })
    if (this.behavior === 'refuse') return Promise.reject(new Error('the mailbox refused the report'))
    if (this.behavior === 'hang') return new Promise(() => { /* the send never settles */ })
    return Promise.resolve({ messageId: 'm-1', status: 'accepted' })
  }
}

/** Agent-registry double: the ladder only asks whether an Agent exists for a session id. */
class StubAgents extends Service {
  private readonly agents = new Map<string, { readonly id: string; readonly session: Session }>()

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  /** Register one live agent. */
  register(session: Session): void {
    this.agents.set(session.id, { id: session.id, session })
  }

  /**
   * Resolve one registered agent.
   * @param id - session id the ladder asked about.
   * @returns the agent, or undefined when the session is not one.
   */
  get(id: string): { readonly id: string; readonly session: Session } | undefined {
    return this.agents.get(id)
  }
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
})

/** Flush the microtask the ladder evaluates from, and any report it starts. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** One booted ladder: the root context and the two doubles it reaches. */
interface Booted {
  readonly ctx: Context
  readonly agents: StubAgents
  readonly mailbox: StubTeamMailbox | undefined
}

/**
 * Boot the ladder over a real context, session store, and agent registry.
 * @param config - composition config.
 * @param options - `mailbox: false` omits the Team mailbox service entirely.
 * @returns the context and its doubles.
 */
async function boot(config: WorkerEscalationConfig, options: { readonly mailbox?: boolean } = {}): Promise<Booted> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(StubAgents)
  const agents = ctx.get('agents') as unknown as StubAgents
  let mailbox: StubTeamMailbox | undefined
  if (options.mailbox !== false) {
    await ctx.plugin(StubTeamMailbox)
    mailbox = ctx.get('agentTeams') as unknown as StubTeamMailbox
  }
  await ctx.plugin(WorkerEscalation, config)
  return { ctx, agents, mailbox }
}

/**
 * Create one live session and register its agent.
 * @param booted - the booted ladder.
 * @param id - session id.
 * @param depth - delegation depth; omitted is a root session.
 * @param register - whether the agent registry knows this session.
 * @returns the live session.
 */
function session(booted: Booted, id: string, depth?: number, register = true): Session {
  const created = booted.ctx.sessions.create(SessionId(id), depth === undefined ? {} : { meta: { delegationDepth: depth } })
  if (register) booted.agents.register(created)
  return created
}

/** One failing tool call and its errored result — the shortest error burst. */
function failing(session_: Session, index: number, command: string): SessionEvent<'tool/result'> {
  const callId = CallId('call-' + String(index))
  const called = session_.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command }) })
  return session_.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'boom' }], isError: true }),
  }, { surfaceOp: 'append', sourceEventSeqs: [called.seq] })
}

/** One finished step, which is the unit the cooldown counts. */
function completeStep(session_: Session, step: number): void {
  session_.append('step/start', { turn: 1, step })
  session_.append('step/end', { turn: 1, step })
}

/** Every ladder decision in a session log. */
function decisions(session_: Session): SessionEvent<'escalation/decision'>[] {
  return session_.events.filter(
    (event): event is SessionEvent<'escalation/decision'> => event.type === 'escalation/decision',
  )
}

describe('worker-escalation evaluation', () => {
  it('logs one decision per firing trigger with the documented payload', async () => {
    const booted = await boot({ enabled: true })
    const worker = session(booted, 'worker-logs', 1)
    worker.append('turn/start', { turn: 1 })
    failing(worker, 1, 'a')
    const second = failing(worker, 2, 'b')
    // Two completed steps satisfy the default cooldown.
    completeStep(worker, 1)
    completeStep(worker, 2)
    await settle()

    const logged = decisions(worker)
    expect(logged).toHaveLength(1)
    const decision = logged[0]
    expect(decision?.data).toEqual({
      trigger: 'errorBurst',
      triggerSeq: second.seq,
      choice: 'continue',
      engine: 'absent',
      aging: { continues: 1, lastContinueSeq: decision?.seq },
    })
    // The recorded triggerSeq resolves to a real event of that trigger's family.
    const pointed = worker.events.find(event => event.seq === decision?.data.triggerSeq)
    expect(pointed?.type).toBe('tool/result')
    // Log-only: the decision carries the append contract's ignorable envelope.
    expect(decision?.ignorable).toBe(true)
    expect(booted.mailbox?.sent).toEqual([])
  })

  it('suppresses a decision inside the cooldown window and takes it once the steps land', async () => {
    const booted = await boot({ enabled: true })
    const worker = session(booted, 'worker-cooldown', 1)
    failing(worker, 1, 'a')
    failing(worker, 2, 'b')
    completeStep(worker, 1)
    completeStep(worker, 2)
    await settle()
    expect(decisions(worker)).toHaveLength(1)

    // Fresh evidence, but only one completed step since the decision.
    const third = failing(worker, 3, 'c')
    completeStep(worker, 3)
    await settle()
    expect(decisions(worker)).toHaveLength(1)

    completeStep(worker, 4)
    await settle()
    const logged = decisions(worker)
    expect(logged).toHaveLength(2)
    expect(logged[1]?.data).toEqual({
      trigger: 'errorBurst',
      triggerSeq: third.seq,
      choice: 'continue',
      engine: 'absent',
      aging: { continues: 2, lastContinueSeq: logged[1]?.seq },
    })
  })

  it('keeps a standing trigger from writing a second decision once the steps land', async () => {
    const booted = await boot({ enabled: true })
    const worker = session(booted, 'worker-standing', 1)
    failing(worker, 1, 'a')
    failing(worker, 2, 'b')
    completeStep(worker, 1)
    completeStep(worker, 2)
    await settle()
    expect(decisions(worker)).toHaveLength(1)

    // Two more completed steps clear the cooldown, but no new evidence arrived:
    // the trigger still points at the event the first decision recorded.
    completeStep(worker, 3)
    completeStep(worker, 4)
    await settle()
    expect(decisions(worker)).toHaveLength(1)
    expect(booted.mailbox?.sent).toEqual([])
  })

  it('writes nothing for a root session', async () => {
    const booted = await boot({ enabled: true })
    const root = session(booted, 'root-session')
    failing(root, 1, 'a')
    failing(root, 2, 'b')
    completeStep(root, 1)
    completeStep(root, 2)
    await settle()
    expect(decisions(root)).toEqual([])
    expect(booted.mailbox?.sent).toEqual([])
  })

  it('engages a delegated session up to maxArbiterDepth and no deeper', async () => {
    const booted = await boot({ enabled: true, maxArbiterDepth: 2, minStepsBetween: 0 })
    const deep = session(booted, 'worker-deep', 3)
    failing(deep, 1, 'a')
    failing(deep, 2, 'b')
    await settle()
    expect(decisions(deep)).toEqual([])

    const atCap = session(booted, 'worker-at-cap', 2)
    failing(atCap, 1, 'a')
    failing(atCap, 2, 'b')
    await settle()
    expect(decisions(atCap)).toHaveLength(1)
  })

  it('scopes the goal-epoch triggers to the card the epoch opened at', async () => {
    const booted = await boot({
      enabled: true,
      minStepsBetween: 0,
      triggers: {
        errorBurst: { enabled: false },
        attemptCount: { enabled: true, attempts: 2 },
        repeatRunLength: { enabled: false },
        stepBudgetExhausted: { enabled: false },
        turnFailureStreak: { enabled: false },
      },
    })
    await booted.ctx.plugin(JspaceService, { enabled: true })
    const worker = session(booted, 'worker-epoch', 1)
    failing(worker, 1, 'a')
    failing(worker, 2, 'b')
    // The card opens after both failures, so the epoch holds no failed approach yet.
    booted.ctx.jspace.open(worker, { goal: 'finish the assignment', next: 'keep going' })
    await settle()
    expect(decisions(worker)).toEqual([])

    failing(worker, 3, 'c')
    failing(worker, 4, 'd')
    await settle()
    const logged = decisions(worker)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.data.trigger).toBe('attemptCount')
    expect(logged[0]?.data.triggerSeq).toBeGreaterThan(booted.ctx.jspace.card(worker)?.goalOpenedSeq ?? 0)
  })
})

describe('the returned disposer', () => {
  it('removes the committed-event watch it installed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    const dispose = WorkerEscalation.apply(ctx, { enabled: true, minStepsBetween: 0 })
    const worker = ctx.sessions.create(SessionId('worker-disposed'), { meta: { delegationDepth: 1 } })
    failing(worker, 1, 'a')
    failing(worker, 2, 'b')
    await settle()
    expect(decisions(worker)).toHaveLength(1)

    dispose()
    failing(worker, 3, 'c')
    await settle()
    expect(decisions(worker)).toHaveLength(1)
  })
})

describe('the report-blocked terminal', () => {
  it('reaches the terminal at maxContinues and mails the Lead the bounded digest', async () => {
    const booted = await boot({ enabled: true, maxContinues: 1, minStepsBetween: 0 })
    const worker = session(booted, 'worker-terminal', 1)
    failing(worker, 1, 'a')
    failing(worker, 2, 'b')
    await settle()
    expect(decisions(worker)).toHaveLength(1)

    const third = failing(worker, 3, 'c')
    await settle()
    const logged = decisions(worker)
    expect(logged).toHaveLength(2)
    const terminal = logged[1]
    expect(terminal?.data).toEqual({
      trigger: 'errorBurst',
      triggerSeq: third.seq,
      choice: 'report-blocked',
      engine: 'absent',
      aging: { continues: 1, lastContinueSeq: logged[0]?.seq },
    })

    expect(booted.mailbox?.sent).toHaveLength(1)
    const report = booted.mailbox?.sent[0]
    expect(report?.target).toBe('lead')
    expect(report?.text).toContain('Worker report: blocked.')
    expect(report?.text).toContain('it took 1 escalation decisions on this goal epoch')
    expect(report?.text).toContain('the latest errorBurst trigger fired at event ' + String(third.seq))
    expect(report?.text).toContain('Worker session id: worker-terminal')
    expect(report?.text).toContain('Recent tool outcomes:')

    // The terminal is one-shot for the epoch: later evidence writes nothing.
    failing(worker, 4, 'd')
    completeStep(worker, 1)
    await settle()
    expect(decisions(worker)).toHaveLength(2)
    expect(booted.mailbox?.sent).toHaveLength(1)
  })

  it('leaves the epoch open when the mailbox refuses, and reports on the next firing', async () => {
    const booted = await boot({ enabled: true, maxContinues: 0, minStepsBetween: 0 })
    booted.mailbox?.setBehavior('refuse')
    const worker = session(booted, 'worker-refused', 1)
    failing(worker, 1, 'a')
    failing(worker, 2, 'b')
    await settle()
    // A refused report records nothing, so no terminal entered the log.
    expect(decisions(worker)).toEqual([])

    booted.mailbox?.setBehavior('accept')
    failing(worker, 3, 'c')
    await settle()
    const logged = decisions(worker)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.data.choice).toBe('report-blocked')
    expect(booted.mailbox?.sent).toHaveLength(2)
  })

  it('writes no terminal, and warns instead, when the session has no Agent', async () => {
    const booted = await boot({ enabled: true, maxContinues: 0, minStepsBetween: 0 })
    const orphan = session(booted, 'worker-without-agent', 1, false)
    failing(orphan, 1, 'a')
    failing(orphan, 2, 'b')
    await settle()
    expect(decisions(orphan)).toEqual([])
    expect(booted.mailbox?.sent).toEqual([])
  })

  it('writes no terminal, and warns instead, when no Team mailbox is composed', async () => {
    const booted = await boot({ enabled: true, maxContinues: 0, minStepsBetween: 0 }, { mailbox: false })
    const worker = session(booted, 'worker-without-team', 1)
    failing(worker, 1, 'a')
    failing(worker, 2, 'b')
    await settle()
    expect(decisions(worker)).toEqual([])
  })

  it('starts only one report for a session while one is in flight', async () => {
    const booted = await boot({ enabled: true, maxContinues: 0, minStepsBetween: 0 })
    booted.mailbox?.setBehavior('hang')
    const worker = session(booted, 'worker-in-flight', 1)
    failing(worker, 1, 'a')
    failing(worker, 2, 'b')
    await settle()
    expect(booted.mailbox?.sent).toHaveLength(1)

    // A second firing re-enters the evaluator while the first report is unresolved.
    failing(worker, 3, 'c')
    completeStep(worker, 1)
    await settle()
    expect(booted.mailbox?.sent).toHaveLength(1)
    expect(decisions(worker)).toEqual([])
  })
})
