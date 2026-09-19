/**
 * The package invariant companion, exercised at runtime rather than only
 * compiled. Its three relations are checked on `internal/dispatch` before
 * publication, so a violating append fails the `session.append` that wrote it:
 *
 * 1. every decision's `triggerSeq` resolves to an event of that trigger's own
 *    family (a failed approach for the two failure triggers, a call for the
 *    repeat chain, a stop for the step budget, a durable failure for the turn
 *    streak), and a sandbox denial or charter probe never satisfies one;
 * 2. the epoch's aging pair is exact — a continue advances the count by one and
 *    records its own seq, a terminal inherits the count and the newest continue;
 * 3. nothing is written while the resolved settings section reads
 *    `enabled: false`.
 *
 * Manual invariant topology (the focused-suite convention): the suite mounts
 * the registry and the companion on one root context and drives the relations
 * through real session appends.
 */

import { describe, expect, it } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import { CharterEntryId } from '@shres-code/shres-code-jspace'
import { CallId, MessageId } from '@shres-code/shres-code-llm'
import type { ToolResultMessage } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import { SettingsProvider } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import { triggerSatisfiedAt } from '../src/fold.ts'
import * as WorkerEscalationInvariant from '../src/invariant.ts'
import { Config, WORKER_ESCALATION_SETTINGS_NAMESPACE } from '../src/index.ts'
import type { EscalationDecision } from '../src/types.ts'

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

/** J-Space double: the companion reads one card fact, the open goal epoch. */
class StubJspace extends Service {
  /** `goalOpenedSeq` the double reports, or `-1` for no open card. */
  anchor = -1

  constructor(ctx: Context) {
    super(ctx, 'jspace')
  }

  /**
   * Report the open card's goal epoch.
   * @param _session - the session the companion asked about.
   * @returns the card's `goalOpenedSeq`, or null without an open card.
   */
  card(_session: Session): { readonly goalOpenedSeq: number } | null {
    return this.anchor < 0 ? null : { goalOpenedSeq: this.anchor }
  }
}

/**
 * Mount the session store, the invariant registry, and the companion.
 * @param options - `settings: true` also mounts a settings provider,
 *   `jspace: true` a card double whose goal epoch the caller sets.
 * @returns the root context.
 */
async function setup(options: { readonly settings?: boolean; readonly jspace?: boolean } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  if (options.settings === true) await ctx.plugin(MemorySettings)
  if (options.jspace === true) await ctx.plugin(StubJspace)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(WorkerEscalationInvariant)
  return ctx
}

/**
 * One logged decision. An override set to `undefined` drops the key instead of
 * logging it: `Session.append` refuses data carrying an explicit `undefined`.
 * @param overrides - fields to replace.
 * @returns the decision payload.
 */
function decision(overrides: Partial<EscalationDecision> = {}): EscalationDecision {
  const merged: Record<string, unknown> = {
    trigger: 'errorBurst',
    triggerSeq: 0,
    choice: 'continue',
    engine: 'absent',
    aging: { continues: 1 },
    ...overrides,
  }
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as unknown as EscalationDecision
}

/** One tool-result message: `isError` marks a failing approach. */
function resultMessage(index: number, callId: CallId, failure: boolean): ToolResultMessage {
  return {
    id: MessageId('result-' + String(index)),
    role: 'user',
    source: { kind: 'tool', callId },
    content: [{
      type: 'tool-result',
      toolCallId: callId,
      content: [{ type: 'text', text: failure ? 'boom' : 'done' }],
      isError: failure,
    }],
  }
}

/** Append one tool call and return its event. */
function call(session: Session, index: number, name = 'bash'): SessionEvent<'tool/call'> {
  return session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: CallId('call-' + String(index)),
    name,
    arguments: '{"command":"a' + String(index) + '"}',
  })
}

/** Append one tool result for a call and return its event. */
function result(
  session: Session,
  index: number,
  failure: boolean,
  callSeq: number,
  error?: { readonly code: string },
): SessionEvent<'tool/result'> {
  const callId = CallId('call-' + String(index))
  return session.append('tool/result', {
    turn: 1,
    step: 1,
    message: resultMessage(index, callId, failure),
    ...error === undefined ? {} : { error: { name: 'ToolError', code: error.code } },
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
}

/** Append one stop of the step-budget guard. */
function stepBudgetStop(session: Session): SessionEvent<'step-budget/exhausted'> {
  return session.append('step-budget/exhausted', { turn: 1, step: 3, limit: 2 }, { ignorable: true })
}

/** Append one closed turn with a durable failure or another end reason. */
function turnEnd(session: Session, reason: unknown): SessionEvent<'turn/end'> {
  return session.append('turn/end', { turn: 1, reason } as never)
}

/** Append one decision through the real log, which the companion checks before publication. */
function appendDecision(session: Session, data: EscalationDecision): SessionEvent<'escalation/decision'> {
  return session.append('escalation/decision', data, { ignorable: true })
}

/** The last event type in a log, so a refused append can be shown to have changed nothing. */
function lastType(session: Session): string | undefined {
  return session.events.at(-1)?.type
}

describe('worker-escalation invariant companion', () => {
  it('registers the package name and disposes cleanly', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const dispose = await WorkerEscalationInvariant.apply(ctx)
    expect(typeof dispose).toBe('function')
    dispose()
  })

  it('reserves the package name against duplicate registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(WorkerEscalationInvariant)
    expect(() => {
      ctx.invariants.register('@shres-code/shres-code-worker-escalation', () => {})
    }).toThrow(/already registered/)
  })
})

describe('triggerSeq resolves to a satisfying event', () => {
  it('accepts a decision pointing at each trigger family\'s own evidence', async () => {
    const ctx = await setup()
    const families = [
      { evidence: 'failed approach', trigger: 'errorBurst' },
      { evidence: 'failed approach', trigger: 'attemptCount' },
      { evidence: 'call', trigger: 'repeatRunLength' },
      { evidence: 'stop', trigger: 'stepBudgetExhausted' },
      { evidence: 'durable failure', trigger: 'turnFailureStreak' },
    ] as const
    for (const [index, { evidence, trigger }] of families.entries()) {
      const session = ctx.sessions.create(SessionId('invariant-satisfied-' + String(index)))
      let seq: number
      if (evidence === 'failed approach') {
        seq = result(session, 1, true, call(session, 1).seq).seq
      } else if (evidence === 'call') {
        seq = call(session, 1).seq
      } else if (evidence === 'stop') {
        seq = stepBudgetStop(session).seq
      } else {
        seq = turnEnd(session, { kind: 'error', error: { message: 'the route failed', code: 'RATE_LIMIT' } }).seq
      }
      const at = session.seq
      appendDecision(session, decision({ trigger, triggerSeq: seq, aging: { continues: 1, lastContinueSeq: at } }))
      expect(session.events.at(-1)?.data).toMatchObject({ trigger, triggerSeq: seq })
      expect(session.events.filter(event => event.type === 'escalation/decision')).toHaveLength(1)
    }
  })

  it('rejects a decision whose triggerSeq holds no event', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('invariant-orphan'))
    const callEvent = call(session, 1)
    result(session, 1, true, callEvent.seq)
    expect(() => {
      appendDecision(session, decision({ triggerSeq: 99 }))
    }).toThrow(/no satisfying event at triggerSeq 99/)
    // The refused append never entered the log.
    expect(session.events.some(event => event.type === 'escalation/decision')).toBe(false)
  })

  it('rejects a decision pointing at an event its trigger does not count', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('invariant-unsatisfied'))
    const callEvent = call(session, 1)
    const ok = result(session, 1, false, callEvent.seq)
    const denied = result(session, 2, true, callEvent.seq, { code: 'FS_SANDBOX_DENIED' })
    const stop = stepBudgetStop(session)
    const aborted = turnEnd(session, { kind: 'error', error: { message: 'cancelled', code: 'ABORTED' } })
    const cases = [
      // A successful result is not a failed approach.
      ['errorBurst', ok.seq],
      // A policy denial is the harness refusing, not the worker failing.
      ['errorBurst', denied.seq],
      ['attemptCount', denied.seq],
      // A call is not a repeat chain verdict, and a stop is not a failure.
      ['repeatRunLength', stop.seq],
      ['stepBudgetExhausted', ok.seq],
      // An ABORTED turn is not attributable to the worker.
      ['turnFailureStreak', aborted.seq],
    ] as const
    for (const [trigger, triggerSeq] of cases) {
      const before = lastType(session)
      expect(() => {
        appendDecision(session, decision({ trigger, triggerSeq }))
      }).toThrow(/no satisfying event at triggerSeq/)
      expect(lastType(session)).toBe(before)
    }
  })

  it('rejects a decision pointing at a charter discrimination probe', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('invariant-probe'))
    const callEvent = call(session, 1)
    session.append('jspace/charter-probe', {
      entryId: CharterEntryId('check-1'),
      callId: CallId('call-1'),
      path: '/tmp/probe.txt',
      mutationKind: 'insert',
      demonstrated: true,
    }, { ignorable: true })
    const probed = result(session, 1, true, callEvent.seq)
    expect(() => {
      appendDecision(session, decision({ trigger: 'errorBurst', triggerSeq: probed.seq }))
    }).toThrow(/no satisfying event at triggerSeq/)
  })

  it('ignores every event that is not a decision', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('invariant-other-events'))
    expect(() => { call(session, 1) }).not.toThrow()
    expect(() => { session.append('todo/write', { todos: [] }, { ignorable: true }) }).not.toThrow()
    expect(lastType(session)).toBe('todo/write')
  })
})

describe('the aging pair is exact', () => {
  it('accepts a terminal that inherits the epoch count and its newest continue', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('invariant-terminal'))
    const callEvent = call(session, 1)
    const failed = result(session, 1, true, callEvent.seq)
    const first = session.seq
    appendDecision(session, decision({ triggerSeq: failed.seq, aging: { continues: 1, lastContinueSeq: first } }))
    appendDecision(session, decision({
      triggerSeq: failed.seq,
      choice: 'report-blocked',
      aging: { continues: 1, lastContinueSeq: first },
    }))
    expect(session.events.at(-1)?.data).toMatchObject({ choice: 'report-blocked', aging: { continues: 1, lastContinueSeq: first } })
  })

  it('accepts a terminal with no continue before it', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('invariant-first-terminal'))
    const callEvent = call(session, 1)
    const failed = result(session, 1, true, callEvent.seq)
    appendDecision(session, decision({ triggerSeq: failed.seq, choice: 'report-blocked', aging: { continues: 0 } }))
    expect(session.events.at(-1)?.data).toMatchObject({ choice: 'report-blocked' })
    expect(session.events.at(-1)?.data).not.toHaveProperty('aging.lastContinueSeq')
  })

  it('rejects a continue that does not advance the epoch count by one', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('invariant-non-monotone'))
    const callEvent = call(session, 1)
    const failed = result(session, 1, true, callEvent.seq)
    const first = session.seq
    appendDecision(session, decision({ triggerSeq: failed.seq, aging: { continues: 1, lastContinueSeq: first } }))
    // The second continue must record two, and its own seq as the newest.
    expect(() => {
      appendDecision(session, decision({ triggerSeq: failed.seq, aging: { continues: 1, lastContinueSeq: session.seq } }))
    }).toThrow(/records 1 continue resolutions while its goal epoch already took 1/)
    expect(() => {
      appendDecision(session, decision({ triggerSeq: failed.seq, aging: { continues: 3, lastContinueSeq: session.seq } }))
    }).toThrow(/records 3 continue resolutions while its goal epoch already took 1/)
    // A continue that names an older seq as the newest continue is refused too.
    expect(() => {
      appendDecision(session, decision({ triggerSeq: failed.seq, aging: { continues: 2, lastContinueSeq: first } }))
    }).toThrow(/while the epoch's newest continue is/)
    expect(session.events.filter(event => event.type === 'escalation/decision')).toHaveLength(1)
  })

  it('rejects a continue that omits its own seq as the newest continue', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('invariant-missing-continue-seq'))
    const callEvent = call(session, 1)
    const failed = result(session, 1, true, callEvent.seq)
    expect(() => {
      appendDecision(session, decision({ triggerSeq: failed.seq, aging: { continues: 1 } }))
    }).toThrow(/records lastContinueSeq undefined while the epoch's newest continue is/)
  })

  it('rejects a terminal whose count or newest continue contradicts the epoch', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('invariant-terminal-contradiction'))
    const callEvent = call(session, 1)
    const failed = result(session, 1, true, callEvent.seq)
    const first = session.seq
    appendDecision(session, decision({ triggerSeq: failed.seq, aging: { continues: 1, lastContinueSeq: first } }))
    expect(() => {
      appendDecision(session, decision({ triggerSeq: failed.seq, choice: 'report-blocked', aging: { continues: 2, lastContinueSeq: first } }))
    }).toThrow(/records 2 continue resolutions while its goal epoch already took 1/)
    expect(() => {
      appendDecision(session, decision({ triggerSeq: failed.seq, choice: 'report-blocked', aging: { continues: 1, lastContinueSeq: 99 } }))
    }).toThrow(/while the epoch's newest continue is 2/)
    expect(session.events.filter(event => event.type === 'escalation/decision')).toHaveLength(1)
  })
})

describe('the epoch the aging relation counts over', () => {
  it('skips a decision that is not a continue when it counts the epoch', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('invariant-skip-terminal'))
    const callEvent = call(session, 1)
    const failed = result(session, 1, true, callEvent.seq)
    appendDecision(session, decision({ triggerSeq: failed.seq, choice: 'report-blocked', aging: { continues: 0 } }))
    const at = session.seq
    appendDecision(session, decision({ triggerSeq: failed.seq, aging: { continues: 1, lastContinueSeq: at } }))
    expect(session.events.filter(event => event.type === 'escalation/decision')).toHaveLength(2)
  })

  it('skips a decision at or below the open goal epoch when it counts the epoch', async () => {
    const ctx = await setup({ jspace: true })
    const session = ctx.sessions.create(SessionId('invariant-epoch-window'))
    const callEvent = call(session, 1)
    const failed = result(session, 1, true, callEvent.seq)
    const first = session.seq
    appendDecision(session, decision({ triggerSeq: failed.seq, aging: { continues: 1, lastContinueSeq: first } }))
    // The card's epoch opens after that decision, so it is not this epoch's continue.
    const jspace = ctx.get('jspace') as unknown as StubJspace
    jspace.anchor = first
    const second = session.seq
    appendDecision(session, decision({ triggerSeq: failed.seq, aging: { continues: 1, lastContinueSeq: second } }))
    expect(session.events.filter(event => event.type === 'escalation/decision')).toHaveLength(2)
  })

  it('counts the whole log when no card is open', async () => {
    const ctx = await setup({ jspace: true })
    const session = ctx.sessions.create(SessionId('invariant-no-card'))
    const callEvent = call(session, 1)
    const failed = result(session, 1, true, callEvent.seq)
    const first = session.seq
    appendDecision(session, decision({ triggerSeq: failed.seq, aging: { continues: 1, lastContinueSeq: first } }))
    const second = session.seq
    appendDecision(session, decision({ triggerSeq: failed.seq, aging: { continues: 2, lastContinueSeq: second } }))
    expect(session.events.filter(event => event.type === 'escalation/decision')).toHaveLength(2)
  })
})

describe('nothing is written while the settings section is off', () => {
  /** A decision that satisfies the trigger relation, so only the settings relation can refuse it. */
  async function satisfiable(ctx: Context, id: string): Promise<{ session: Session; data: EscalationDecision }> {
    const session = ctx.sessions.create(SessionId(id))
    const callEvent = call(session, 1)
    const failed = result(session, 1, true, callEvent.seq)
    const at = session.seq
    return { session, data: decision({ triggerSeq: failed.seq, aging: { continues: 1, lastContinueSeq: at } }) }
  }

  it('rejects a decision appended while the resolved section reads enabled: false', async () => {
    const ctx = await setup({ settings: true })
    ctx.settings.register(WORKER_ESCALATION_SETTINGS_NAMESPACE, Config, { base: { enabled: false } })
    const { session, data } = await satisfiable(ctx, 'invariant-settings-off')
    expect(() => {
      appendDecision(session, data)
    }).toThrow(/settings section reads enabled: false/)
    expect(session.events.some(event => event.type === 'escalation/decision')).toBe(false)
  })

  it('accepts the same decision once the section reads enabled: true', async () => {
    const ctx = await setup({ settings: true })
    ctx.settings.register(WORKER_ESCALATION_SETTINGS_NAMESPACE, Config, { base: { enabled: true } })
    const { session, data } = await satisfiable(ctx, 'invariant-settings-on')
    appendDecision(session, data)
    expect(session.events.filter(event => event.type === 'escalation/decision')).toHaveLength(1)
  })

  it('is inert when no settings service carries the section', async () => {
    const ctx = await setup()
    const { session, data } = await satisfiable(ctx, 'invariant-settings-absent')
    appendDecision(session, data)
    expect(session.events.filter(event => event.type === 'escalation/decision')).toHaveLength(1)
  })

  it('reads the committed change rather than the composition entry', async () => {
    const ctx = await setup({ settings: true })
    ctx.settings.register(WORKER_ESCALATION_SETTINGS_NAMESPACE, Config, { base: { enabled: false } })
    const { session, data } = await satisfiable(ctx, 'invariant-settings-commit')
    await ctx.settings.replace(WORKER_ESCALATION_SETTINGS_NAMESPACE, { enabled: true })
    appendDecision(session, data)
    expect(session.events.filter(event => event.type === 'escalation/decision')).toHaveLength(1)
  })
})

describe('triggerSatisfiedAt', () => {
  it('reports whether one event proves one trigger family', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('invariant-predicate'))
    const callEvent = call(session, 1)
    const failed = result(session, 1, true, callEvent.seq)
    const ok = result(session, 2, false, callEvent.seq)
    const stop = stepBudgetStop(session)
    const failedTurn = turnEnd(session, { kind: 'error', error: { message: 'the route failed', code: 'RATE_LIMIT' } })
    const events = session.events
    expect(triggerSatisfiedAt(events, failed.seq, 'errorBurst')).toBe(true)
    expect(triggerSatisfiedAt(events, failed.seq, 'attemptCount')).toBe(true)
    expect(triggerSatisfiedAt(events, ok.seq, 'errorBurst')).toBe(false)
    expect(triggerSatisfiedAt(events, callEvent.seq, 'repeatRunLength')).toBe(true)
    expect(triggerSatisfiedAt(events, failed.seq, 'repeatRunLength')).toBe(false)
    expect(triggerSatisfiedAt(events, stop.seq, 'stepBudgetExhausted')).toBe(true)
    expect(triggerSatisfiedAt(events, failedTurn.seq, 'turnFailureStreak')).toBe(true)
    expect(triggerSatisfiedAt(events, failed.seq, 'turnFailureStreak')).toBe(false)
    expect(triggerSatisfiedAt(events, 999, 'errorBurst')).toBe(false)
  })

  it('throws on a trigger family the vocabulary does not carry', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('invariant-unknown-trigger'))
    const callEvent = call(session, 1)
    // The event must resolve first: an unknown family over a real event is the
    // unreachable branch, an unknown family over no event is just no evidence.
    expect(triggerSatisfiedAt(session.events, 99, 'bogus' as never)).toBe(false)
    expect(() => triggerSatisfiedAt(session.events, callEvent.seq, 'bogus' as never)).toThrow(/unreachable variant/)
  })
})
