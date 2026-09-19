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
import { JUDGMENT_SETTINGS_NAMESPACE, JudgmentError } from '@shres-code/shres-code-judgment'
import JspaceService, { CharterEntryId } from '@shres-code/shres-code-jspace'
import { CallId, createToolResultMessage } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import { SettingsProvider } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import * as WorkerEscalation from '../src/index.ts'
import type { WorkerEscalationConfig } from '../src/config.ts'
import { FakeJudgment, StubRedactor, REDACTION_MARK } from './fake-judgment.ts'

/** The question text every boot supplies; the consult suites read it back off the ask. */
const PROGRESS = 'Is this worker going to finish without help?'

/** One step below a double, for the gate's own boundary cases. */
const STEP = Number.EPSILON

/** Smallest real settings provider: one in-memory document. */
class MemorySettings extends SettingsProvider {
  private doc: Record<string, unknown> = {}

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

/** What one boot composes beyond the ladder itself. */
interface BootOptions {
  /** `false` omits the Team mailbox service entirely. */
  readonly mailbox?: boolean
  /** `true` mounts a scripted judgment engine as `ctx.judgment`. */
  readonly judgment?: boolean
  /** `true` mounts the egress hook beside the engine. */
  readonly redactor?: boolean
  /** `true` mounts the in-memory settings provider, so the judgment toggle can be written. */
  readonly settings?: boolean
}

/** One booted ladder: the root context and every double it reaches. */
interface Booted {
  readonly ctx: Context
  readonly agents: StubAgents
  readonly mailbox: StubTeamMailbox | undefined
  readonly judgment: FakeJudgment | undefined
  readonly redactor: StubRedactor | undefined
}

/**
 * Boot the ladder over a real context, session store, and agent registry.
 * @param config - composition config; the required question text is supplied here.
 * @param options - which optional services the composition carries.
 * @returns the context and its doubles.
 */
async function boot(
  config: Omit<WorkerEscalationConfig, 'progressInstructions'>,
  options: BootOptions = {},
): Promise<Booted> {
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
  if (options.settings === true) await ctx.plugin(MemorySettings)
  let judgment: FakeJudgment | undefined
  let redactor: StubRedactor | undefined
  if (options.judgment === true) {
    await ctx.plugin(FakeJudgment)
    judgment = ctx.get('judgment') as unknown as FakeJudgment
  }
  if (options.redactor === true) {
    await ctx.plugin(StubRedactor)
    redactor = ctx.get('judgmentRedactor') as unknown as StubRedactor
  }
  await ctx.plugin(WorkerEscalation, { progressInstructions: PROGRESS, ...config })
  return { ctx, agents, mailbox, judgment, redactor }
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
      reason: 'engine-absent',
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
      reason: 'engine-absent',
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

describe('the charter-probe window', () => {
  /** The `jspace_open` arguments for one check the harness will discriminate. */
  const PROBED_REGISTRATION = JSON.stringify({
    goal: 'finish the assignment',
    next: 'keep going',
    charter: [{
      kind: 'check',
      constraint: 'the audit tag is the first line',
      command: 'grep AUDIT-TAG src/mod.js',
      reads: ['src/mod.js'],
      failProbe: { path: 'src/mod.js', mutation: { kind: 'insert', content: '// no tag' } },
    }],
  })

  it('takes no verdict from a probe run whose markers have not landed yet', async () => {
    const booted = await boot({
      enabled: true,
      minStepsBetween: 0,
      triggers: {
        errorBurst: { enabled: true, burst: 2 },
        attemptCount: { enabled: false },
        repeatRunLength: { enabled: false },
        stepBudgetExhausted: { enabled: false },
        turnFailureStreak: { enabled: false },
      },
    })
    const worker = session(booted, 'worker-probe-window', 1)
    // One genuine failure, so the probe's own run would be the burst's second.
    failing(worker, 1, 'a')
    await settle()
    expect(decisions(worker)).toEqual([])

    const parentCall = CallId('call-open')
    const parent = worker.append('tool/call', {
      turn: 1,
      step: 1,
      callId: parentCall,
      name: 'jspace_open',
      arguments: PROBED_REGISTRATION,
    })
    const nestedCall = CallId('call-open:charter:e1')
    const nested = worker.append('tool/call', {
      turn: 1,
      step: 1,
      callId: nestedCall,
      name: 'bash',
      arguments: JSON.stringify({
        command: 'grep AUDIT-TAG src/mod.js',
        description: 'Run charter check e1',
        timeoutMs: 10_000,
      }),
    })
    worker.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: nestedCall, content: [{ type: 'text', text: 'no tag' }], isError: true }),
    }, { surfaceOp: 'append', sourceEventSeqs: [nested.seq] })
    await settle()
    // The nested run failing is the probe succeeding: reading it as the worker's
    // second failed approach is the decision this window must not take.
    expect(decisions(worker)).toEqual([])

    worker.append('jspace/charter-run', {
      entryId: CharterEntryId('e1'),
      callId: nestedCall,
      parentCallId: parentCall,
      phase: 'probe',
      command: 'grep AUDIT-TAG src/mod.js',
      passed: false,
      exitCode: 1,
      outputPreview: '',
    }, { ignorable: true })
    worker.append('jspace/charter-probe', {
      entryId: CharterEntryId('e1'),
      callId: nestedCall,
      path: 'src/mod.js',
      mutationKind: 'insert',
      demonstrated: true,
    }, { ignorable: true })
    worker.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: parentCall, content: [{ type: 'text', text: 'charter registered' }], isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [parent.seq] })
    await settle()
    // Settled: the probe's run is transparent, and the burst still stands at the
    // one genuine failure the window opened with.
    expect(decisions(worker)).toEqual([])
    expect(booted.mailbox?.sent).toEqual([])
  })
})

describe('the returned disposer', () => {
  it('removes the committed-event watch it installed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    const dispose = WorkerEscalation.apply(ctx, { enabled: true, minStepsBetween: 0, progressInstructions: PROGRESS })
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

/**
 * Drive one firing trigger on a fresh worker and return its session.
 * @param booted - the booted ladder.
 * @param id - session id.
 * @returns the live worker session.
 */
async function fire(booted: Booted, id: string): Promise<Session> {
  const worker = session(booted, id, 1)
  failing(worker, 1, 'a')
  failing(worker, 2, 'b')
  await settle()
  return worker
}

describe('the Stage 1 judgment consult', () => {
  it('asks the configured question at the configured tier and logs the ask\'s own choice', async () => {
    const booted = await boot(
      { enabled: true, minStepsBetween: 0, judgmentTier: 'fast', confidence: 0.8, margin: 0.125 },
      { judgment: true },
    )
    booted.judgment?.script({
      option: 'needs-help',
      confidence: 0.8,
      probabilities: { continue: 1, 'needs-help': 0.875 },
    })
    const worker = await fire(booted, 'worker-gate-passed')

    expect(booted.judgment?.asks).toHaveLength(1)
    const ask = booted.judgment?.asks[0]
    expect(ask?.tier).toBe('fast')
    expect(ask?.questions).toEqual([{
      kind: 'choice',
      id: 'worker-progress',
      instructions: PROGRESS,
      options: [{ option: 'continue' }, { option: 'needs-help' }],
    }])
    expect(ask?.state).toContain('Tool outcomes: ok=0 fail=2')

    const logged = decisions(worker)
    expect(logged).toHaveLength(1)
    const triggerSeq = worker.events.filter(event => event.type === 'tool/result').at(-1)?.seq
    // Both gates pass exactly at their thresholds: the answer's confidence equals
    // the configured one and its top-two margin equals the configured margin.
    expect(logged[0]?.data).toEqual({
      trigger: 'errorBurst',
      triggerSeq,
      choice: 'needs-help',
      engine: 'ok',
      reason: 'gate-passed',
      confidence: 0.8,
      margin: 0.125,
      aging: { continues: 1, lastContinueSeq: logged[0]?.seq },
    })
    // Observer means observer: the choice is a record. Nothing is mailed, and
    // nothing enters the worker's own conversation.
    expect(booted.mailbox?.sent).toEqual([])
    expect(worker.events.filter(event => event.type === 'user/message')).toEqual([])
  })

  it('fails one step below each threshold and records the class that failed', async () => {
    const lowConfidence = await boot({ enabled: true, minStepsBetween: 0, confidence: 0.8, margin: 0.125 }, { judgment: true })
    lowConfidence.judgment?.script({ confidence: 0.8 - STEP, probabilities: { continue: 1, 'needs-help': 0.875 } })
    const belowConfidence = decisions(await fire(lowConfidence, 'worker-low-confidence'))

    const thinMargin = await boot({ enabled: true, minStepsBetween: 0, confidence: 0.8, margin: 0.125 }, { judgment: true })
    thinMargin.judgment?.script({ confidence: 0.8, probabilities: { continue: 1, 'needs-help': 0.875 + STEP } })
    const belowMargin = decisions(await fire(thinMargin, 'worker-thin-margin'))

    expect(belowConfidence[0]?.data).toMatchObject({
      choice: 'continue',
      engine: 'ok',
      reason: 'low-confidence',
      confidence: 0.8 - STEP,
      margin: 0.125,
    })
    expect(belowMargin[0]?.data).toMatchObject({
      choice: 'continue',
      engine: 'ok',
      reason: 'thin-margin',
      confidence: 0.8,
    })
    expect(belowMargin[0]?.data.margin).toBeLessThan(0.125)
  })

  it('reads a distribution that omits an option as a zero probability', async () => {
    // A provider validates one entry per option before an answer reaches a
    // consumer; a missing entry reads as zero, which leaves the answer below the
    // margin gate rather than above it.
    for (const probabilities of [{ continue: 0.05 }, { 'needs-help': 0.05 }]) {
      const booted = await boot({ enabled: true, minStepsBetween: 0 }, { judgment: true })
      booted.judgment?.script({ probabilities })
      const logged = decisions(await fire(booted, 'worker-partial-distribution'))
      expect(logged[0]?.data).toMatchObject({ choice: 'continue', engine: 'ok', reason: 'thin-margin', margin: 0.05 })
    }
  })

  it('degrades every consult class to the Stage 0 continue with its own class', async () => {
    const absent = await boot({ enabled: true, minStepsBetween: 0 }, {})
    const absentLogged = decisions(await fire(absent, 'worker-engine-absent'))

    const disabled = await boot({ enabled: true, minStepsBetween: 0 }, { judgment: true, settings: true })
    await disabled.ctx.settings.replace(JUDGMENT_SETTINGS_NAMESPACE, { enabled: false })
    const disabledLogged = decisions(await fire(disabled, 'worker-engine-disabled'))

    const unavailable = await boot({ enabled: true, minStepsBetween: 0 }, { judgment: true })
    unavailable.judgment?.scriptFailure(new JudgmentError('UNAVAILABLE', 'the engine is down'))
    const unavailableLogged = decisions(await fire(unavailable, 'worker-engine-unavailable'))

    const classified = await boot({ enabled: true, minStepsBetween: 0 }, { judgment: true })
    classified.judgment?.scriptFailure(new JudgmentError('INVALID_ANSWER', 'the body did not match the question'))
    const classifiedLogged = decisions(await fire(classified, 'worker-invalid-answer'))

    const foreignKind = await boot({ enabled: true, minStepsBetween: 0 }, { judgment: true })
    foreignKind.judgment?.scriptForeignKind()
    const foreignKindLogged = decisions(await fire(foreignKind, 'worker-foreign-kind'))

    const unknownOption = await boot({ enabled: true, minStepsBetween: 0 }, { judgment: true })
    unknownOption.judgment?.script({ option: 'report-blocked' })
    const unknownOptionLogged = decisions(await fire(unknownOption, 'worker-unknown-option'))

    const cases = [
      [absentLogged, 'absent', 'engine-absent'],
      [disabledLogged, 'disabled', 'engine-disabled'],
      [unavailableLogged, 'unavailable', 'engine-unavailable'],
      [classifiedLogged, 'invalid-answer', 'invalid-answer'],
      [foreignKindLogged, 'invalid-answer', 'invalid-answer'],
      [unknownOptionLogged, 'invalid-answer', 'invalid-answer'],
    ] as const
    for (const [logged, engine, reason] of cases) {
      expect(logged).toHaveLength(1)
      expect(logged[0]?.data).toMatchObject({ choice: 'continue', engine, reason })
      expect(logged[0]?.data.aging.continues).toBe(1)
      // The Stage 0 continue carries no figures: only an answered ask has them.
      expect(logged[0]?.data).not.toHaveProperty('confidence')
      expect(logged[0]?.data).not.toHaveProperty('margin')
    }
    // The two classes that make no ask at all asked nothing; every other class
    // either asked once or refused the ask it was given.
    expect(disabled.judgment?.asks).toEqual([])
    expect(unavailable.judgment?.asks).toHaveLength(1)
    expect(classified.judgment?.asks).toHaveLength(1)
    expect(foreignKind.judgment?.asks).toHaveLength(1)
    expect(unknownOption.judgment?.asks).toHaveLength(1)
  })

  it('reaches the deterministic terminal without consulting the engine', async () => {
    const booted = await boot({ enabled: true, maxContinues: 0, minStepsBetween: 0 }, { judgment: true })
    const worker = await fire(booted, 'worker-terminal-unconsulted')

    expect(booted.judgment?.asks).toEqual([])
    const logged = decisions(worker)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.data).toMatchObject({ choice: 'report-blocked', reason: 'max-continues' })
    expect(logged[0]?.data).not.toHaveProperty('engine')
    expect(booted.mailbox?.sent).toHaveLength(1)
  })
})

describe('the Stage 1 egress hook', () => {
  it('is consulted once per ask, and what it returns is what the engine receives', async () => {
    const booted = await boot({ enabled: true, minStepsBetween: 0 }, { judgment: true, redactor: true })
    const worker = await fire(booted, 'worker-redacted')
    failing(worker, 3, 'c')
    failing(worker, 4, 'd')
    await settle()

    expect(decisions(worker)).toHaveLength(2)
    const asks = booted.judgment?.asks ?? []
    const redacted = booted.redactor?.states ?? []
    expect(asks).toHaveLength(2)
    expect(redacted).toHaveLength(2)
    expect(redacted[0]).toContain('Tool outcomes:')
    expect(asks[0]?.state).toBe(REDACTION_MARK + '\n' + String(redacted[0]))
    expect(asks[1]?.state).toBe(REDACTION_MARK + '\n' + String(redacted[1]))
  })

  it('is not consulted when the ladder is off or no engine is composed', async () => {
    const off = await boot({ enabled: false }, { judgment: true, redactor: true })
    await fire(off, 'worker-off-with-engine')
    expect(off.judgment?.asks).toEqual([])
    expect(off.redactor?.states).toEqual([])

    const engineLess = await boot({ enabled: true, minStepsBetween: 0 }, { redactor: true })
    await fire(engineLess, 'worker-redactor-without-engine')
    expect(engineLess.redactor?.states).toEqual([])
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
    // The terminal resolves on the epoch's own count, so it records that rule and
    // the class of no ask.
    expect(terminal?.data).toEqual({
      trigger: 'errorBurst',
      triggerSeq: third.seq,
      choice: 'report-blocked',
      reason: 'max-continues',
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

    // A second firing lands while the first report is unresolved. The session is
    // still evaluating, so no second evaluation starts and no second report is sent.
    failing(worker, 3, 'c')
    completeStep(worker, 1)
    await settle()
    expect(booted.mailbox?.sent).toHaveLength(1)
    expect(decisions(worker)).toEqual([])
  })
})
