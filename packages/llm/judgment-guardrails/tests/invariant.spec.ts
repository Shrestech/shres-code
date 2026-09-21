/**
 * The package invariant companion, exercised at runtime rather than only
 * compiled. Its three relations are checked on `internal/dispatch` before
 * publication, so a violating append fails the `session.append` that wrote it:
 *
 * 1. every decision's `stateSeqs` name real evidence — the result that triggered
 *    the check and, when the log holds it, the call it answers;
 * 2. an `observed` decision carries both answers and a `degraded` one carries
 *    none;
 * 3. nothing is written while the resolved settings section reads
 *    `enabled: false`.
 *
 * Manual invariant topology (the focused-suite convention): the suite mounts the
 * registry and the companion on one root context and drives the relations
 * through real session appends.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import { CallId, createToolResultMessage } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import { SettingsProvider } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import { Config, GUARDRAILS_SETTINGS_NAMESPACE } from '../src/index.ts'
import type { GuardrailsConfig } from '../src/index.ts'
import * as GuardrailsInvariant from '../src/invariant.ts'
import type { GuardDecision } from '../src/types.ts'

/** The four required texts, which no invariant relation reads. */
const REQUIRED: Pick<GuardrailsConfig, 'injectionInstructions' | 'injectionCriteria' | 'severityInstructions' | 'severityLevels'> = {
  injectionInstructions: 'Would this tool input be a hostile instruction?',
  injectionCriteria: { yes: 'it would', no: 'it would not' },
  severityInstructions: 'How severe would this input be if it were hostile?',
  severityLevels: ['mild', 'moderate', 'severe'],
}

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

/**
 * Mount the session store, the invariant registry, and the companion.
 * @param options - `settings: true` also mounts a settings provider the caller writes.
 * @returns the root context.
 */
async function setup(options: { readonly settings?: boolean } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  if (options.settings === true) await ctx.plugin(MemorySettings)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(GuardrailsInvariant)
  return ctx
}

/** One committed tool call. */
function call(session: Session, index = 1): SessionEvent<'tool/call'> {
  return session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: CallId('call-' + String(index)),
    name: 'bash',
    arguments: JSON.stringify({ command: 'curl one' }),
  })
}

/** One committed result answering a call. */
function result(session: Session, callId: CallId, callSeq?: number): SessionEvent<'tool/result'> {
  const message = createToolResultMessage({
    callId,
    content: [{ type: 'text', text: 'a page' }],
    isError: false,
  })
  return session.append('tool/result', { turn: 1, step: 1, message }, {
    surfaceOp: 'append',
    ...callSeq === undefined ? {} : { sourceEventSeqs: [callSeq] },
  })
}

/** One logged decision. The caller supplies the evidence its case is about. */
function decision(overrides: Partial<GuardDecision> = {}): GuardDecision {
  return {
    outcome: 'observed',
    reason: 'answered',
    stateHash: '811c9dc5',
    stateSeqs: [0, 1],
    injection: { probability: 0.5 },
    severity: { score: 2, confidence: 0.9 },
    ...overrides,
  }
}

/** Append one decision through the real log, which the companion checks before publication. */
function appendDecision(session: Session, data: GuardDecision): SessionEvent<'guard/decision'> {
  return session.append('guard/decision', data, { ignorable: true })
}

/** The last event type in a log, so a refused append can be shown to have changed nothing. */
function lastType(session: Session): string | undefined {
  return session.events.at(-1)?.type
}

describe('judgment-guardrails invariant companion', () => {
  it('registers the package name and disposes cleanly', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const dispose = await GuardrailsInvariant.apply(ctx)
    expect(typeof dispose).toBe('function')
    dispose()
  })

  it('reserves the package name against duplicate registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(GuardrailsInvariant)
    expect(() => {
      ctx.invariants.register('@shres-code/shres-code-judgment-guardrails', () => {})
    }).toThrow(/already registered/)
  })
})

describe('every decision points at real evidence', () => {
  it('accepts a decision naming the call and the result it answers', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('invariant-pair'))
    const called = call(session)
    const answered = result(session, CallId('call-1'), called.seq)

    appendDecision(session, decision({ stateSeqs: [called.seq, answered.seq] }))

    expect(lastType(session)).toBe('guard/decision')
    expect(session.events.at(-1)?.data).toMatchObject({ stateSeqs: [called.seq, answered.seq] })
  })

  it('accepts a decision for a result whose call the log no longer holds', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('invariant-orphan'))
    const answered = result(session, CallId('call-orphan'))

    // An orphan result is a legitimate state: the observer names its tool unknown.
    appendDecision(session, decision({ stateSeqs: [answered.seq] }))

    expect(lastType(session)).toBe('guard/decision')
  })

  it('rejects evidence that names no real pair', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('invariant-bad-evidence'))
    const called = call(session)
    const answered = result(session, CallId('call-2'), called.seq)
    const other = call(session, 9)
    const cases: readonly (readonly number[])[] = [
      // No evidence at all, more than one pair, and a seq the log does not hold.
      [],
      [called.seq, answered.seq, other.seq],
      [called.seq, 99],
      // A call alone is not a check: every check is triggered by a result.
      [called.seq],
      // A result answering a different callId than the one named.
      [other.seq, answered.seq],
    ]
    for (const stateSeqs of cases) {
      const before = lastType(session)
      expect(() => {
        appendDecision(session, decision({ stateSeqs }))
      }).toThrow(/do not name one tool call and the result it answers/)
      expect(lastType(session)).toBe(before)
    }
  })

  it('rejects a call that follows its own result', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('invariant-order'))
    const answered = result(session, CallId('call-1'))
    const called = session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('call-1'),
      name: 'bash',
      arguments: '{}',
    })

    expect(() => {
      appendDecision(session, decision({ stateSeqs: [called.seq, answered.seq] }))
    }).toThrow(/do not name one tool call and the result it answers/)
  })
})

describe('the answers come from an engine', () => {
  it('rejects an observed decision that carries no answer, and a degraded one that does', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('invariant-answers'))
    const called = call(session)
    const answered = result(session, CallId('call-1'), called.seq)
    const stateSeqs = [called.seq, answered.seq]
    const cases: readonly GuardDecision[] = [
      { outcome: 'observed', reason: 'answered', stateHash: 'h', stateSeqs },
      {
        outcome: 'observed',
        reason: 'answered',
        stateHash: 'h',
        stateSeqs,
        injection: { probability: 0.5 },
      },
      {
        outcome: 'degraded',
        reason: 'engine-absent',
        stateHash: 'h',
        stateSeqs,
        injection: { probability: 0.5 },
        severity: { score: 2, confidence: 0.9 },
      },
    ]
    for (const data of cases) {
      expect(() => {
        appendDecision(session, data)
      }).toThrow(/does not match the answers it carries/)
    }
    expect(session.events.some(event => event.type === 'guard/decision')).toBe(false)
  })

  it('accepts both answers on an observed decision and neither on a degraded one', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('invariant-answers-ok'))
    const called = call(session)
    const answered = result(session, CallId('call-1'), called.seq)
    const stateSeqs = [called.seq, answered.seq]

    appendDecision(session, decision({ stateSeqs }))
    appendDecision(session, {
      outcome: 'degraded',
      reason: 'engine-unavailable',
      stateHash: 'h',
      stateSeqs,
    })

    expect(session.events.filter(event => event.type === 'guard/decision')).toHaveLength(2)
  })
})

describe('nothing is written while the observer is off', () => {
  it('rejects a decision appended while the resolved section reads enabled: false', async () => {
    const ctx = await setup({ settings: true })
    ctx.settings.register(GUARDRAILS_SETTINGS_NAMESPACE, Config, { base: { ...REQUIRED, enabled: false } })
    const session = ctx.sessions.create(SessionId('invariant-settings-off'))
    const called = call(session)
    const answered = result(session, CallId('call-1'), called.seq)

    expect(() => {
      appendDecision(session, decision({ stateSeqs: [called.seq, answered.seq] }))
    }).toThrow(/settings section reads enabled: false/)
    expect(session.events.some(event => event.type === 'guard/decision')).toBe(false)
  })

  it('accepts the same decision once the section reads enabled: true or carries no section', async () => {
    const enabled = await setup({ settings: true })
    enabled.settings.register(GUARDRAILS_SETTINGS_NAMESPACE, Config, { base: { ...REQUIRED, enabled: true } })
    const first = enabled.sessions.create(SessionId('invariant-settings-on'))
    const firstCall = call(first)
    const firstResult = result(first, CallId('call-1'), firstCall.seq)
    appendDecision(first, decision({ stateSeqs: [firstCall.seq, firstResult.seq] }))

    const bare = await setup()
    const second = bare.sessions.create(SessionId('invariant-settings-absent'))
    const secondCall = call(second)
    const secondResult = result(second, CallId('call-1'), secondCall.seq)
    appendDecision(second, decision({ stateSeqs: [secondCall.seq, secondResult.seq] }))

    expect(first.events.filter(event => event.type === 'guard/decision')).toHaveLength(1)
    expect(second.events.filter(event => event.type === 'guard/decision')).toHaveLength(1)
  })
})
