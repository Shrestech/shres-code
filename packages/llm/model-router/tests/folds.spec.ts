/**
 * The two pure folds over the session log. \`foldModelRouting\` reads the mode in
 * force; \`stickyState\` replays the documented transitions of a downgraded
 * streak (entry, hold, gate-failed, escalate, manual deviation, mode-off,
 * route-errors, hold-cap, re-entry cooldown) from \`model-routing/decision\`,
 * \`model-routing/mode\`, \`request/header\`, and turn and step events. Both are pure functions of the log, which
 * is what lets resume, fork, compaction, and a bench replay continue a streak:
 * the last case below folds a prefix and gets exactly the state that prefix
 * produced before the later events were appended.
 *
 * The logs here are bare sessions (no store, no invariant host): a fold sees
 * only the events a case appends.
 */

import { describe, expect, it, vi } from 'vitest'
import { ReasoningEffortId, createUserMessage } from '@shres-code/shres-code-llm'
import type { LlmFailure } from '@shres-code/shres-code-llm'
import { Session, SessionId } from '@shres-code/shres-code-session'
import type { SessionEvent, TurnEndReason } from '@shres-code/shres-code-session'
import {
  advanceStickyFoldState,
  coldPointAt,
  createStickyFoldState,
  foldModelRouting,
  isCompactionEnd,
  latestStepStart,
  modeOfRecord,
  modeRecord,
  readStickyFoldState,
  stickyState,
} from '../src/folds.ts'
import type { ModelRoutingDecision, ModelRoutingSelection, ModelRoutingStickyView } from '../src/types.ts'
import type { ModelRoutingStickyFoldState } from '../src/folds.ts'

const CHEAP: ModelRoutingSelection = { candidateId: 'cheap', provider: 'cheap-provider', model: 'cheap-model' }
const MID: ModelRoutingSelection = { candidateId: 'mid', provider: 'mid-provider', model: 'mid-model' }
const STRONG_BASE = { provider: 'strong-provider', model: 'strong-model' }
const ROUTE_ERROR_LIMIT = 2

type TestStickyView = ModelRoutingStickyView | (Omit<Extract<ModelRoutingStickyView, { active: true }>, 'routeErrorLimit'> & {
  routeErrorLimit?: number
})

/** One logged decision; \`sticky\` scripts the transition the case replays. */
function decision(sticky: TestStickyView, overrides: Partial<ModelRoutingDecision> = {}): ModelRoutingDecision {
  const recordedSticky: ModelRoutingStickyView = sticky.active
    ? { ...sticky, routeErrorLimit: sticky.routeErrorLimit ?? ROUTE_ERROR_LIMIT }
    : sticky
  return {
    outcome: recordedSticky.active ? 'downgraded' : 'kept-strong',
    reason: recordedSticky.active ? 'gate-passed' : 'gate-failed',
    stateHash: '00000000',
    stateSeqs: [0],
    ...recordedSticky.active ? { selection: CHEAP } : {},
    sticky: recordedSticky,
    ...overrides,
  }
}

/** A bare session: appends here never reach a store, an invariant, or a projection. */
function scripted(id: string): Session {
  return Session.create(SessionId(id))
}

/** One full request-header snapshot, optionally carrying an unrelated system change. */
function header(session: Session, provider: string, model: string, system?: string): void {
  session.append('request/header', {
    header: { config: { provider, model }, ...system === undefined ? {} : { system } },
    reason: 'initial',
  })
}

function user(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function open(session: Session, turn: number): void {
  session.append('turn/start', { turn })
}

function close(session: Session, turn: number, reason: TurnEndReason = { kind: 'completed' }): void {
  session.append('turn/end', { turn, reason })
}

/** One model step's opening event; a held streak counts each one. */
function step(session: Session, turn: number, index: number): void {
  session.append('step/start', { turn, step: index })
}

/** One failed turn; a missing \`code\` stands for a failure the harness recorded none on. */
function fail(session: Session, turn: number, code: string | undefined): void {
  const error: LlmFailure = code === undefined
    ? { message: 'the route failed with no code' } as unknown as LlmFailure
    : { message: 'the route failed', code }
  close(session, turn, { kind: 'error', error })
}

/** Append a deliberately malformed durable decision for replay-boundary tests. */
function rawDecision(session: Session, sticky: unknown): void {
  session.append('model-routing/decision', {
    outcome: 'kept-strong',
    reason: 'gate-failed',
    stateHash: '00000000',
    stateSeqs: [0],
    sticky,
  } as unknown as ModelRoutingDecision)
}

describe('foldModelRouting', () => {
  it('folds an empty log to the caller\u2019s initial mode', () => {
    const session = scripted('mode-empty')
    expect(foldModelRouting(session.events)).toBe('off')
    expect(foldModelRouting(session.events, session.events.length, 'on')).toBe('on')
    expect(foldModelRouting(session.events, 0, 'shadow')).toBe('shadow')
  })

  it('takes the last mode event', () => {
    const session = scripted('mode-last-wins')
    session.append('model-routing/mode', { active: true })
    expect(foldModelRouting(session.events)).toBe('on')
    session.append('model-routing/mode', { active: true, shadow: true })
    expect(foldModelRouting(session.events)).toBe('shadow')
    session.append('model-routing/mode', { active: false })
    expect(foldModelRouting(session.events)).toBe('off')
    session.append('model-routing/configuration', { active: true, shadow: true })
    expect(foldModelRouting(session.events)).toBe('shadow')
  })

  it('honours the end prefix', () => {
    const session = scripted('mode-prefix')
    session.append('model-routing/mode', { active: true })
    session.append('model-routing/mode', { active: false })
    expect(foldModelRouting(session.events, 1)).toBe('on')
    expect(foldModelRouting(session.events, 0)).toBe('off')
    // Past the end nothing changes; the prefix rule is the whole rule.
    expect(foldModelRouting(session.events, 99)).toBe('off')
  })

  it('reads a record from before shadow unchanged, and an inactive record as off whatever it marks', () => {
    expect(modeOfRecord({ active: true })).toBe('on')
    expect(modeOfRecord({ active: false })).toBe('off')
    expect(modeOfRecord({ active: true, shadow: true })).toBe('shadow')
    // Malformed durable history: shadow cannot switch routing on by itself.
    expect(modeOfRecord({ active: false, shadow: true })).toBe('off')
  })

  it('records each mode additively, so on writes what logs before shadow wrote', () => {
    expect(modeRecord('off')).toEqual({ active: false })
    expect(modeRecord('on')).toEqual({ active: true })
    expect(modeRecord('shadow')).toEqual({ active: true, shadow: true })
    for (const mode of ['off', 'on', 'shadow'] as const) expect(modeOfRecord(modeRecord(mode))).toBe(mode)
  })
})

describe('stickyState entry', () => {
  it('is strong over an empty log', () => {
    expect(stickyState(scripted('sticky-empty').events)).toEqual({ active: false, stepsElapsed: 0 })
  })

  it('derives enteredTurn, enteredStep, entryBase, and elapsed steps from a downgraded decision', () => {
    const session = scripted('sticky-entry')
    open(session, 1)
    open(session, 1)
    step(session, 1, 1)
    header(session, STRONG_BASE.provider, STRONG_BASE.model)
    user(session, 'a small change')
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 0, enteredTurn: 1, enteredStep: 1 }))
    close(session, 1)
    open(session, 2)
    step(session, 2, 1)

    expect(stickyState(session.events)).toEqual({
      active: true,
      stepsElapsed: 1,
      enteredTurn: 1,
      enteredStep: 1,
      candidate: CHEAP,
      entryBase: STRONG_BASE,
      routeErrorLimit: ROUTE_ERROR_LIMIT,
    })
  })

  it('stepsElapsed advances within the entry turn', () => {
    const session = scripted('sticky-entry-steps')
    open(session, 1)
    // Steps before the entering decision belong to the manual route.
    step(session, 1, 1)
    step(session, 1, 2)
    header(session, STRONG_BASE.provider, STRONG_BASE.model)
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 0, enteredTurn: 1, enteredStep: 2 }))
    expect(stickyState(session.events)).toMatchObject({ stepsElapsed: 0, enteredTurn: 1, enteredStep: 2 })
    step(session, 1, 3)
    step(session, 1, 4)
    expect(stickyState(session.events)).toMatchObject({ active: true, stepsElapsed: 2, enteredTurn: 1, enteredStep: 2 })
  })

  it('restarts the step count on a candidate change and keeps it on a continuing decision', () => {
    const session = scripted('sticky-entry-restart')
    open(session, 1)
    step(session, 1, 1)
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 0, enteredTurn: 1, enteredStep: 1 }))
    step(session, 1, 2)
    // A continuing record without its own entry step keeps the fold's.
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 1, enteredTurn: 1 }))
    expect(stickyState(session.events)).toMatchObject({ stepsElapsed: 1, enteredStep: 1 })
    step(session, 1, 3)
    session.append('model-routing/decision', decision(
      { active: true, stepsElapsed: 0, enteredTurn: 1, enteredStep: 3 },
      { selection: MID },
    ))
    expect(stickyState(session.events)).toMatchObject({ stepsElapsed: 0, enteredStep: 3, candidate: MID })
    // A changed candidate whose record names no entry step has none.
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 0, enteredTurn: 1 }))
    const restarted = stickyState(session.events)
    expect(restarted).toMatchObject({ stepsElapsed: 0, candidate: CHEAP })
    expect('enteredStep' in restarted).toBe(false)
  })

  it('prefers the recorded entry base over the last request header', () => {
    const recordedBase = { provider: 'manual-provider', model: 'manual-model' }
    const view = { active: true, stepsElapsed: 0, enteredTurn: 1, entryBase: recordedBase, routeErrorLimit: ROUTE_ERROR_LIMIT }

    // A header the fold saw before the entering decision does not win: the record
    // is what the consult wrote for this streak.
    const withHeader = scripted('sticky-entry-recorded')
    header(withHeader, STRONG_BASE.provider, STRONG_BASE.model)
    withHeader.append('model-routing/decision', decision(view))
    expect(stickyState(withHeader.events).entryBase).toEqual(recordedBase)

    // With no header at all the record is the only base there is.
    const headerless = scripted('sticky-entry-headerless')
    headerless.append('model-routing/decision', decision(view))
    expect(stickyState(headerless.events)).toEqual({
      active: true,
      stepsElapsed: 0,
      enteredTurn: 1,
      candidate: CHEAP,
      entryBase: recordedBase,
      routeErrorLimit: ROUTE_ERROR_LIMIT,
    })
  })

  it('carries the header\u2019s reasoning effort into a derived entry base', () => {
    const session = scripted('sticky-entry-effort')
    session.append('request/header', {
      header: {
        config: {
          provider: STRONG_BASE.provider,
          model: STRONG_BASE.model,
          reasoningEffort: ReasoningEffortId('high'),
        },
      },
      reason: 'initial',
    })
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 0, enteredTurn: 1 }))

    expect(stickyState(session.events).entryBase).toEqual({ ...STRONG_BASE, reasoningEffort: 'high' })
  })

  it('takes the turn in force when the logged decision names none', () => {
    const session = scripted('sticky-entry-unnumbered')
    header(session, STRONG_BASE.provider, STRONG_BASE.model)
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 0 }))
    expect(stickyState(session.events)).toEqual({
      active: true,
      stepsElapsed: 0,
      enteredTurn: 0,
      candidate: CHEAP,
      entryBase: STRONG_BASE,
      routeErrorLimit: ROUTE_ERROR_LIMIT,
    })
  })
})

describe('stickyState holds', () => {
  /** A log entered into a downgrade at turn 1, ready for a hold at turn 2. */
  function entered(id: string): Session {
    const session = scripted(id)
    open(session, 1)
    step(session, 1, 1)
    header(session, STRONG_BASE.provider, STRONG_BASE.model)
    user(session, 'a small change')
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 0, enteredTurn: 1, enteredStep: 1 }))
    close(session, 1)
    open(session, 2)
    step(session, 2, 1)
    return session
  }

  it('keeps enteredTurn and entryBase across a second decision', () => {
    const session = entered('sticky-hold')
    // The loop rewrote the header to the candidate while the streak holds; that
    // must not move the entry base.
    header(session, CHEAP.provider, CHEAP.model, 'plan mode is on')
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 1, enteredTurn: 1, enteredStep: 1 }))
    close(session, 2)
    open(session, 3)
    step(session, 3, 1)

    expect(stickyState(session.events)).toEqual({
      active: true,
      stepsElapsed: 2,
      enteredTurn: 1,
      enteredStep: 1,
      candidate: CHEAP,
      entryBase: STRONG_BASE,
      routeErrorLimit: ROUTE_ERROR_LIMIT,
    })
  })

  it('keeps the held candidate when a decision names no selection', () => {
    const session = entered('sticky-hold-unnamed')
    session.append('model-routing/decision', {
      outcome: 'downgraded',
      reason: 'sticky-hold',
      stateHash: '00000000',
      stateSeqs: [0],
      sticky: { active: true, stepsElapsed: 1, enteredTurn: 1, routeErrorLimit: ROUTE_ERROR_LIMIT },
    })
    expect(stickyState(session.events).candidate).toEqual(CHEAP)
  })

  it('recovers a missing candidate when a later held decision names it', () => {
    const session = scripted('sticky-hold-unnamed-first')
    // A replayed active record can omit the selection; the next record remains
    // authoritative and must be able to establish it.
    open(session, 1)
    session.append('model-routing/decision', {
      outcome: 'downgraded',
      reason: 'sticky-hold',
      stateHash: '00000000',
      stateSeqs: [0],
      sticky: { active: true, stepsElapsed: 0, enteredTurn: 1, routeErrorLimit: ROUTE_ERROR_LIMIT },
    })
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 0, enteredTurn: 1 }))

    expect(stickyState(session.events).candidate).toEqual(CHEAP)
  })
})

describe('stickyState break reasons', () => {
  function entered(id: string): Session {
    const session = scripted(id)
    open(session, 1)
    header(session, STRONG_BASE.provider, STRONG_BASE.model)
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 0, enteredTurn: 1 }))
    open(session, 2)
    return session
  }

  it('reports the brokenBy of a decision that ends the streak', () => {
    const session = entered('break-decision')
    session.append('model-routing/decision', decision({ active: false, stepsElapsed: 0, brokenBy: 'gate-failed' }))
    expect(stickyState(session.events)).toEqual({ active: false, stepsElapsed: 0, brokenBy: 'gate-failed' })
  })

  it('reports no brokenBy for a decision that never held a streak', () => {
    const session = scripted('break-none')
    session.append('model-routing/decision', decision({ active: false, stepsElapsed: 0 }))
    expect(stickyState(session.events)).toEqual({ active: false, stepsElapsed: 0 })
    // A brokenBy on a decision the fold saw while already strong is not a break.
    session.append('model-routing/decision', decision({ active: false, stepsElapsed: 0, brokenBy: 'escalated' }))
    expect(stickyState(session.events)).toEqual({ active: false, stepsElapsed: 0 })
  })

  it('clears the streak when the mode turns off', () => {
    const session = entered('break-mode-off')
    session.append('model-routing/mode', { active: false })
    expect(stickyState(session.events)).toEqual({ active: false, stepsElapsed: 0, brokenBy: 'mode-off' })
  })

  it('clears the streak with mode-off when the mode switches to shadow, which never rewrites a request', () => {
    const user = entered('break-mode-shadow')
    user.append('model-routing/mode', { active: true, shadow: true })
    expect(stickyState(user.events)).toEqual({ active: false, stepsElapsed: 0, brokenBy: 'mode-off' })

    const configured = entered('break-configuration-shadow')
    configured.append('model-routing/configuration', { active: true, shadow: true })
    expect(stickyState(configured.events)).toEqual({ active: false, stepsElapsed: 0, brokenBy: 'mode-off' })

    // A record re-affirming on leaves the streak held.
    const affirmed = entered('break-mode-on')
    affirmed.append('model-routing/mode', { active: true })
    expect(stickyState(affirmed.events).active).toBe(true)
  })

  it('records nothing for a mode event the fold saw while already strong', () => {
    const session = scripted('break-mode-noop')
    session.append('model-routing/mode', { active: false })
    session.append('model-routing/mode', { active: true })
    expect(stickyState(session.events)).toEqual({ active: false, stepsElapsed: 0 })
  })

  it('clears the streak at the route-failure horizon', () => {
    const session = entered('break-route-errors')
    fail(session, 2, 'RATE_LIMIT')
    // One failure is below the two-failure horizon: the streak survives.
    expect(stickyState(session.events)).toMatchObject({ active: true, candidate: CHEAP })
    fail(session, 3, 'RATE_LIMIT')
    expect(stickyState(session.events)).toMatchObject({ active: false, stepsElapsed: 0, brokenBy: 'route-errors', needsStrongTurn: true })
  })

  it('starts a fresh failure streak after route errors break the old one', () => {
    const session = entered('break-route-reentry')
    fail(session, 2, 'RATE_LIMIT')
    fail(session, 3, 'RATE_LIMIT')
    open(session, 4)
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 0, enteredTurn: 4 }))
    fail(session, 4, 'RATE_LIMIT')

    expect(stickyState(session.events)).toMatchObject({
      active: true,
      stepsElapsed: 0,
      candidate: CHEAP,
    })
  })

  describe('route-failed decisions', () => {
    /** Enter a fresh streak on `selection` at `turn` and record its in-turn fallback. */
    function enterAndFall(session: Session, turn: number, selection: ModelRoutingSelection = CHEAP): void {
      open(session, turn)
      session.append('model-routing/decision', decision({ active: true, stepsElapsed: 0, enteredTurn: turn, entryBase: STRONG_BASE }, { selection }))
      session.append('model-routing/decision', decision(
        { active: false, stepsElapsed: 0, brokenBy: 'route-failed', entryBase: STRONG_BASE },
        { reason: 'route-failed', failure: { code: 'AUTH', provider: selection.provider, model: selection.model } },
      ))
      close(session, turn)
    }

    it('route-failed decisions count toward maxRouteErrors across streaks', () => {
      const session = scripted('route-failed-across-streaks')
      enterAndFall(session, 1)
      // One fallback ends its streak without reaching the two-failure limit.
      expect(stickyState(session.events)).toEqual({ active: false, stepsElapsed: 0, brokenBy: 'route-failed', cooldownTurn: 1 })
      enterAndFall(session, 2)
      expect(stickyState(session.events)).toMatchObject({
        active: false,
        brokenBy: 'route-errors',
        needsStrongTurn: true,
        entryBase: STRONG_BASE,
      })
    })

    it('restarts the count for another candidate and after a completed candidate turn', () => {
      const other = scripted('route-failed-other-candidate')
      enterAndFall(other, 1)
      enterAndFall(other, 2, MID)
      expect(stickyState(other.events)).toEqual({ active: false, stepsElapsed: 0, brokenBy: 'route-failed', cooldownTurn: 2 })

      const recovered = scripted('route-failed-recovered')
      enterAndFall(recovered, 1)
      open(recovered, 2)
      recovered.append('model-routing/decision', decision({ active: true, stepsElapsed: 0, enteredTurn: 2, entryBase: STRONG_BASE }))
      close(recovered, 2)
      enterAndFall(recovered, 3)
      expect(stickyState(recovered.events)).toEqual({ active: false, stepsElapsed: 0, brokenBy: 'route-failed', cooldownTurn: 3 })
    })

    it('ends a streak that holds no candidate without counting a failure', () => {
      const session = scripted('route-failed-no-candidate')
      rawDecision(session, { active: true, routeErrorLimit: ROUTE_ERROR_LIMIT, stepsElapsed: 0, enteredTurn: 1 })
      session.append('model-routing/decision', decision(
        { active: false, stepsElapsed: 0, brokenBy: 'route-failed', entryBase: STRONG_BASE },
        { reason: 'route-failed', failure: { code: 'AUTH', provider: CHEAP.provider, model: CHEAP.model } },
      ))
      expect(stickyState(session.events)).toEqual({ active: false, stepsElapsed: 0, brokenBy: 'route-failed', cooldownTurn: 0 })
    })

    it('ignores a route-failed decision the fold saw while strong', () => {
      const session = scripted('route-failed-while-strong')
      session.append('model-routing/decision', decision(
        { active: false, stepsElapsed: 0, brokenBy: 'route-failed', entryBase: STRONG_BASE },
        { reason: 'route-failed', failure: { code: 'AUTH', provider: CHEAP.provider, model: CHEAP.model } },
      ))
      expect(stickyState(session.events)).toEqual({ active: false, stepsElapsed: 0 })
    })
  })

  it('resets route failures when a held candidate changes', () => {
    const session = entered('break-route-candidate-transition')
    fail(session, 2, 'RATE_LIMIT')
    session.append('model-routing/decision', decision(
      { active: true, stepsElapsed: 1, enteredTurn: 1 },
      { selection: MID },
    ))
    fail(session, 3, 'RATE_LIMIT')

    expect(stickyState(session.events)).toMatchObject({
      active: true,
      candidate: MID,
    })
  })

  it('resets the failure streak on a completed, aborted, or unattributable turn', () => {
    const completed = entered('break-route-completed')
    fail(completed, 2, 'RATE_LIMIT')
    close(completed, 3)
    fail(completed, 4, 'RATE_LIMIT')
    expect(stickyState(completed.events)).toMatchObject({ active: true, candidate: CHEAP })

    const aborted = entered('break-route-aborted')
    fail(aborted, 2, 'RATE_LIMIT')
    close(aborted, 3, { kind: 'aborted', reason: { kind: 'user' } })
    fail(aborted, 4, 'RATE_LIMIT')
    expect(stickyState(aborted.events)).toMatchObject({ active: true, candidate: CHEAP })

    for (const [id, code] of [['break-route-unknown', 'UNKNOWN'], ['break-route-aborted-code', 'ABORTED'], ['break-route-no-code', undefined]] as const) {
      const session = entered(id)
      fail(session, 2, code)
      fail(session, 3, code)
      expect(stickyState(session.events)).toMatchObject({ active: true, candidate: CHEAP })
    }
  })

  it('does not count failures while the fold is strong', () => {
    const session = scripted('break-route-strong')
    fail(session, 1, 'RATE_LIMIT')
    expect(stickyState(session.events)).toEqual({ active: false, stepsElapsed: 0 })
  })

  it('uses the latest recorded error limit without replaying an earlier failure', () => {
    const session = entered('break-route-limit-update')
    fail(session, 2, 'RATE_LIMIT')
    open(session, 3)
    session.append('model-routing/decision', decision({
      active: true,
      stepsElapsed: 1,
      enteredTurn: 1,
      routeErrorLimit: 3,
    }))
    fail(session, 3, 'RATE_LIMIT')

    expect(stickyState(session.events)).toMatchObject({
      active: true,
      routeErrorLimit: 3,
    })
    open(session, 4)
    fail(session, 4, 'RATE_LIMIT')
    expect(stickyState(session.events)).toMatchObject({
      active: false,
      brokenBy: 'route-errors',
      needsStrongTurn: true,
    })
  })

  it('rejects active records without a valid recorded error limit', () => {
    const missing = scripted('malformed-route-limit-missing')
    rawDecision(missing, { active: true, stepsElapsed: 0, enteredTurn: 1 })
    expect(() => stickyState(missing.events)).toThrow(/routeErrorLimit/)

    const zero = scripted('malformed-route-limit-zero')
    rawDecision(zero, { active: true, stepsElapsed: 0, routeErrorLimit: 0 })
    expect(() => stickyState(zero.events)).toThrow(/routeErrorLimit/)

    const fractional = scripted('malformed-route-limit-fractional')
    rawDecision(fractional, { active: true, stepsElapsed: 0, routeErrorLimit: 1.5 })
    expect(() => stickyState(fractional.events)).toThrow(/routeErrorLimit/)

    const missingRecoveryBase = scripted('malformed-route-recovery-base')
    rawDecision(missingRecoveryBase, { active: false, stepsElapsed: 0, brokenBy: 'route-errors' })
    expect(() => stickyState(missingRecoveryBase.events)).toThrow(/entryBase/)

    const invalidRecoveryBase = scripted('malformed-route-recovery-base-fields')
    rawDecision(invalidRecoveryBase, {
      active: false,
      stepsElapsed: 0,
      brokenBy: 'route-errors',
      entryBase: { provider: '', model: 'strong-model' },
    })
    expect(() => stickyState(invalidRecoveryBase.events)).toThrow(/provider and model/)

    const nullRecoveryBase = scripted('malformed-route-recovery-base-null')
    rawDecision(nullRecoveryBase, {
      active: false,
      stepsElapsed: 0,
      brokenBy: 'route-errors',
      entryBase: null,
    })
    expect(() => stickyState(nullRecoveryBase.events)).toThrow(/must be an object/)
  })

  it('retains a prior recovery base if an active accumulator has no current entry base', () => {
    const session = scripted('break-route-recovery-base-fallback')
    fail(session, 1, 'RATE_LIMIT')
    const state: ModelRoutingStickyFoldState = {
      active: true,
      currentTurn: 1,
      stepsElapsed: 0,
      routeFailures: 0,
      routeErrorLimit: 1,
      needsStrongTurn: true,
      recoveryBase: STRONG_BASE,
    }
    const next = advanceStickyFoldState(state, session.events.at(-1)!)
    expect(readStickyFoldState(next)).toMatchObject({
      active: false,
      needsStrongTurn: true,
      entryBase: STRONG_BASE,
    })
  })

  it('can record a route-error break before an entry base is available', () => {
    const session = scripted('break-route-no-entry-base')
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 0, enteredTurn: 1 }))
    fail(session, 1, 'RATE_LIMIT')
    fail(session, 2, 'RATE_LIMIT')
    expect(stickyState(session.events)).toMatchObject({
      active: false,
      brokenBy: 'route-errors',
      needsStrongTurn: true,
    })
  })
})

describe('stickyState route-error recovery', () => {
  /** A route-error break followed by the forced recovery decision in turn 4. */
  function pendingRecovery(id: string): Session {
    const session = enteredForRecovery(id)
    open(session, 4)
    session.append('model-routing/decision', decision({
      active: false,
      stepsElapsed: 0,
      brokenBy: 'route-errors',
      entryBase: STRONG_BASE,
    }))
    return session
  }

  /** Enter a hold while making the latest consumed header the candidate route. */
  function enteredForRecovery(id: string): Session {
    const session = scripted(id)
    open(session, 1)
    header(session, STRONG_BASE.provider, STRONG_BASE.model)
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 0, enteredTurn: 1 }))
    open(session, 2)
    header(session, CHEAP.provider, CHEAP.model)
    fail(session, 2, 'RATE_LIMIT')
    open(session, 3)
    header(session, CHEAP.provider, CHEAP.model)
    fail(session, 3, 'RATE_LIMIT')
    return session
  }

  it('keeps recovery pending when the process closes the turn before the manual header', () => {
    const session = pendingRecovery('recovery-before-header')
    close(session, 4, { kind: 'interrupted' })
    open(session, 5)

    expect(stickyState(session.events)).toMatchObject({
      active: false,
      brokenBy: 'route-errors',
      needsStrongTurn: true,
      recoveryTurn: 4,
    })
  })

  it('consumes recovery only after a matching completed or error turn', () => {
    const completed = pendingRecovery('recovery-completed')
    header(completed, STRONG_BASE.provider, STRONG_BASE.model)
    close(completed, 4)
    expect(stickyState(completed.events).needsStrongTurn).toBeUndefined()

    const errored = pendingRecovery('recovery-error')
    header(errored, STRONG_BASE.provider, STRONG_BASE.model)
    fail(errored, 4, 'RATE_LIMIT')
    expect(stickyState(errored.events).needsStrongTurn).toBeUndefined()
  })

  it('preserves recovery through aborts, mismatched headers, and mode off', () => {
    const aborted = pendingRecovery('recovery-aborted')
    header(aborted, STRONG_BASE.provider, STRONG_BASE.model)
    close(aborted, 4, { kind: 'aborted', reason: { kind: 'user' } })
    expect(stickyState(aborted.events).needsStrongTurn).toBe(true)

    const mismatched = pendingRecovery('recovery-mismatch')
    header(mismatched, STRONG_BASE.provider, STRONG_BASE.model)
    header(mismatched, CHEAP.provider, CHEAP.model)
    close(mismatched, 4)
    expect(stickyState(mismatched.events).needsStrongTurn).toBe(true)

    const modeOff = pendingRecovery('recovery-mode-off')
    modeOff.append('model-routing/mode', { active: false })
    header(modeOff, STRONG_BASE.provider, STRONG_BASE.model)
    close(modeOff, 4)
    expect(stickyState(modeOff.events).needsStrongTurn).toBeUndefined()
  })

  it('preserves pending recovery across an active decision until the matching turn ends', () => {
    const session = pendingRecovery('recovery-active-decision')
    session.append('model-routing/decision', decision({
      active: true,
      stepsElapsed: 0,
      enteredTurn: 4,
      entryBase: STRONG_BASE,
    }))
    expect(stickyState(session.events)).toMatchObject({ active: true, needsStrongTurn: true, recoveryTurn: 4 })
    header(session, STRONG_BASE.provider, STRONG_BASE.model)
    close(session, 4)
    expect(stickyState(session.events).needsStrongTurn).toBeUndefined()
  })
})

describe('stickyState hold cap and re-entry cooldown', () => {
  /** A streak entered at turn 1 and held into turn `turn`. */
  function heldInto(id: string, turn: number): Session {
    const session = scripted(id)
    open(session, 1)
    step(session, 1, 1)
    header(session, STRONG_BASE.provider, STRONG_BASE.model)
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 0, enteredTurn: 1, enteredStep: 1 }))
    close(session, 1)
    for (let current = 2; current <= turn; current += 1) {
      open(session, current)
      step(session, current, 1)
      if (current < turn) close(session, current)
    }
    return session
  }

  it('hold-cap breaks at maxSteps and starts no cooldown', () => {
    const session = heldInto('hold-cap', 3)
    expect(stickyState(session.events)).toMatchObject({ active: true, stepsElapsed: 2 })
    session.append('model-routing/decision', decision(
      { active: false, stepsElapsed: 0, brokenBy: 'hold-cap' },
      { reason: 'hold-cap' },
    ))
    expect(stickyState(session.events)).toEqual({ active: false, stepsElapsed: 0, brokenBy: 'hold-cap' })
    // Steps while strong count nothing.
    step(session, 3, 2)
    expect(stickyState(session.events).stepsElapsed).toBe(0)
  })

  it('reentry cooldown derives from the break decision turn', () => {
    for (const brokenBy of ['escalated', 'current-preferred'] as const) {
      const session = heldInto(`cooldown-${brokenBy}`, 3)
      session.append('model-routing/decision', decision({ active: false, stepsElapsed: 0, brokenBy }, { reason: brokenBy }))
      expect(stickyState(session.events)).toEqual({ active: false, stepsElapsed: 0, brokenBy, cooldownTurn: 3 })
      // The cooldown turn is a log fact: later turns do not move it.
      close(session, 3)
      open(session, 4)
      expect(stickyState(session.events).cooldownTurn).toBe(3)
    }
  })

  it('starts no cooldown for a non-quality break or a strong decision, and clears it on entry', () => {
    const gateFailed = heldInto('cooldown-gate-failed', 2)
    gateFailed.append('model-routing/decision', decision({ active: false, stepsElapsed: 0, brokenBy: 'gate-failed' }))
    expect(stickyState(gateFailed.events).cooldownTurn).toBeUndefined()

    // A quality reason the fold sees while already strong ended no streak.
    gateFailed.append('model-routing/decision', decision({ active: false, stepsElapsed: 0, brokenBy: 'escalated' }))
    expect(stickyState(gateFailed.events).cooldownTurn).toBeUndefined()

    const reentered = heldInto('cooldown-cleared', 2)
    reentered.append('model-routing/decision', decision({ active: false, stepsElapsed: 0, brokenBy: 'escalated' }))
    expect(stickyState(reentered.events).cooldownTurn).toBe(2)
    close(reentered, 2)
    open(reentered, 5)
    reentered.append('model-routing/decision', decision({ active: true, stepsElapsed: 0, enteredTurn: 5, enteredStep: 1 }))
    expect('cooldownTurn' in stickyState(reentered.events)).toBe(false)
  })
})

describe('stickyState judgment failures', () => {
  it('counts failed judgment calls with the turn of the latest and clears them on an answered call', () => {
    const session = scripted('judgment-failures')
    open(session, 1)
    session.append('model-routing/decision', decision(
      { active: false, stepsElapsed: 0 },
      { reason: 'engine-unavailable', engineFailure: { code: 'DEADLINE' } },
    ))
    close(session, 1)
    open(session, 2)
    for (const reason of ['invalid-answer', 'judgment-error'] as const) {
      session.append('model-routing/decision', decision({ active: false, stepsElapsed: 0 }, { reason }))
    }
    expect(stickyState(session.events)).toEqual({ active: false, stepsElapsed: 0, judgmentFailures: { count: 3, turn: 2 } })

    // Decisions that made no judgment call leave the count alone.
    for (const reason of ['breaker-open', 'reentry-cooldown', 'judgment-input-too-large'] as const) {
      session.append('model-routing/decision', decision({ active: false, stepsElapsed: 0 }, { reason }))
    }
    expect(stickyState(session.events).judgmentFailures).toEqual({ count: 3, turn: 2 })

    // A held failure counts while the streak holds.
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 0, enteredTurn: 2 }, {
      route: { choice: 'cheap', confidence: 0.9, probabilities: { cheap: 0.9 } },
    }))
    expect(stickyState(session.events)).not.toHaveProperty('judgmentFailures')
    session.append('model-routing/decision', decision(
      { active: true, stepsElapsed: 0, enteredTurn: 2 },
      { reason: 'judgment-failure-held' },
    ))
    expect(stickyState(session.events)).toMatchObject({ active: true, judgmentFailures: { count: 1, turn: 2 } })
  })
})

describe('stickyState purity', () => {
  it('reproduces an earlier state from the same log prefix', () => {
    const session = scripted('sticky-purity')
    open(session, 1)
    header(session, STRONG_BASE.provider, STRONG_BASE.model)
    user(session, 'a small change')
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 0, enteredTurn: 1 }))
    const entryEnd = session.events.length
    const enteredState = stickyState(session.events)
    open(session, 2)
    step(session, 2, 1)
    close(session, 2)
    open(session, 3)
    step(session, 3, 1)
    header(session, CHEAP.provider, CHEAP.model)
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 1, enteredTurn: 1 }))

    expect(stickyState(session.events, entryEnd)).toEqual(enteredState)
    expect(stickyState(session.events)).toEqual(stickyState(session.events))
    expect(stickyState(session.events)).toEqual({
      active: true,
      stepsElapsed: 2,
      enteredTurn: 1,
      candidate: CHEAP,
      entryBase: STRONG_BASE,
      routeErrorLimit: ROUTE_ERROR_LIMIT,
    })
  })

  it('matches the incremental reducer at every durable prefix', () => {
    const session = scripted('sticky-incremental-prefixes')
    open(session, 1)
    header(session, STRONG_BASE.provider, STRONG_BASE.model)
    user(session, 'a small change')
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 0, enteredTurn: 1, enteredStep: 1 }))
    close(session, 1)
    open(session, 2)
    step(session, 2, 1)
    close(session, 2, { kind: 'completed' })
    open(session, 3)
    step(session, 3, 1)
    header(session, CHEAP.provider, CHEAP.model)
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 1, enteredTurn: 1 }))
    fail(session, 3, 'RATE_LIMIT')
    open(session, 4)
    step(session, 4, 1)
    session.append('model-routing/decision', decision({ active: false, stepsElapsed: 0, brokenBy: 'escalated' }))
    open(session, 5)
    step(session, 5, 1)
    session.append('model-routing/decision', decision({ active: true, stepsElapsed: 0, enteredTurn: 5, enteredStep: 1 }))
    session.append('model-routing/mode', { active: false })

    let state = createStickyFoldState()
    for (let end = 0; end <= session.events.length; end += 1) {
      if (end > 0) state = advanceStickyFoldState(state, session.events[end - 1]!)
      expect(readStickyFoldState(state)).toEqual(stickyState(session.events, end))
    }
  })
})

describe('coldPointAt', () => {
  const STRONG_ROUTE = { provider: 'strong-provider', model: 'strong-model' }
  const FIVE_MINUTES = { ttlMs: 300_000, ttlSource: 'fallback' } as const
  const ONE_HOUR = { ttlMs: 3_600_000, ttlSource: 'adapter' } as const
  const NONE = { ttlMs: 0, ttlSource: 'adapter' } as const

  /** A log with explicit times: contiguous seqs, as a session commits them. */
  class TimedLog {
    readonly events: SessionEvent[] = []

    private add(type: string, data: unknown, time: number): number {
      const seq = this.events.length
      this.events.push({ type, seq, time, data } as unknown as SessionEvent)
      return seq
    }

    turn(time: number, turn: number): void {
      this.add('turn/start', { turn }, time)
    }

    step(time: number, turn: number, step = 1): void {
      this.add('step/start', { turn, step }, time)
    }

    /** One answer on a route; returns its seq. */
    answer(time: number, turn: number, route: { provider: string; model: string }, step = 1): number {
      return this.add('assistant/message', {
        turn,
        step,
        message: { id: `m${String(this.events.length)}`, role: 'assistant', content: [], source: { kind: 'model', ...route } },
      }, time)
    }

    compacted(time: number, error?: string): number {
      return this.add('compaction/end', { compactionId: 'c', turn: null, ...error === undefined ? {} : { error } }, time)
    }

    select(time: number, route: { provider: string; model: string }): void {
      this.add('agent/model-selection', route, time)
    }

    header(time: number, route: { provider: string; model: string }): void {
      this.add('request/header', { header: { config: route }, reason: 'change' }, time)
    }

    decide(time: number, data: Partial<ModelRoutingDecision>): void {
      this.add('model-routing/decision', { stateHash: '0', stateSeqs: [], sticky: { active: false, stepsElapsed: 0 }, ...data }, time)
    }
  }

  /** One strong turn at `time`: its step starts, then the manual model answers 1 s later. */
  function strongTurn(log: TimedLog, time: number, turn: number): number {
    log.turn(time, turn)
    log.step(time, turn)
    return log.answer(time + 1_000, turn, STRONG_ROUTE)
  }

  it('session-start is cold only without seed', () => {
    const log = new TimedLog()
    log.turn(0, 1)
    log.step(0, 1)
    expect(coldPointAt(log.events, STRONG_ROUTE, FIVE_MINUTES, 0, false))
      .toEqual({ kind: 'session-start', ttlMs: 300_000, ttlSource: 'fallback' })
    // Another model's answer is not the manual model's prefix.
    log.answer(500, 1, { provider: 'cheap-provider', model: 'cheap-model' })
    expect(coldPointAt(log.events, STRONG_ROUTE, FIVE_MINUTES, 1_000, false)?.kind).toBe('session-start')
    // A fork's seed carries its parent's prefix: without a manual answer it is warm.
    expect(coldPointAt(log.events, STRONG_ROUTE, FIVE_MINUTES, 1_000, true)).toBeUndefined()
    expect(coldPointAt(log.events, STRONG_ROUTE, NONE, 1_000, true))
      .toEqual({ kind: 'no-cache', ttlMs: 0, ttlSource: 'adapter' })
  })

  it('resumed or forked session is warm', () => {
    const log = new TimedLog()
    const answered = strongTurn(log, 10_000, 1)
    log.turn(70_000, 2)
    log.step(70_000, 2)
    const warm = [log.events, STRONG_ROUTE, FIVE_MINUTES, 70_000] as const
    // Resumed (unseeded) and forked (seeded) logs with a recent manual answer are warm alike.
    expect(coldPointAt(...warm, false)).toBeUndefined()
    expect(coldPointAt(...warm, true)).toBeUndefined()
    expect(answered).toBe(2)
  })

  it('compaction after last base message is cold', () => {
    const log = new TimedLog()
    log.compacted(5_000)
    const answered = strongTurn(log, 10_000, 1)
    // A compaction before the last answer does not touch the prefix that answer wrote.
    expect(coldPointAt(log.events, STRONG_ROUTE, FIVE_MINUTES, 20_000, false)).toBeUndefined()
    // A failed compaction rewrote nothing.
    log.compacted(15_000, 'the summary call failed')
    expect(coldPointAt(log.events, STRONG_ROUTE, FIVE_MINUTES, 20_000, false)).toBeUndefined()
    const compaction = log.compacted(16_000)
    log.compacted(17_000, 'a later failure')
    expect(coldPointAt(log.events, STRONG_ROUTE, FIVE_MINUTES, 20_000, false)).toEqual({
      kind: 'post-compaction',
      ttlMs: 300_000,
      ttlSource: 'fallback',
      idleMs: 10_000,
      lastBaseSeq: answered,
      compactionSeq: compaction,
    })
    expect(isCompactionEnd(log.events[compaction]!)).toBe(true)
    expect(isCompactionEnd(log.events[compaction + 1]!)).toBe(false)
  })

  it('a manual model change after the last base message is cold, and a routed or same-model header is not', () => {
    const cheap = { provider: 'cheap-provider', model: 'cheap-model' }
    const routed = new TimedLog()
    strongTurn(routed, 0, 1)
    routed.turn(10_000, 2)
    routed.decide(10_000, { outcome: 'downgraded', reason: 'gate-passed', selection: { candidateId: 'cheap', ...cheap } })
    routed.header(10_000, cheap)
    // The header a downgraded decision of its own turn rewrote is not a manual switch.
    expect(coldPointAt(routed.events, STRONG_ROUTE, FIVE_MINUTES, 20_000, false)).toBeUndefined()
    routed.header(11_000, STRONG_ROUTE)
    routed.select(12_000, STRONG_ROUTE)
    expect(coldPointAt(routed.events, STRONG_ROUTE, FIVE_MINUTES, 20_000, false)).toBeUndefined()

    // The same candidate header in a later turn with no decision is a manual choice.
    const manual = new TimedLog()
    strongTurn(manual, 0, 1)
    manual.turn(10_000, 2)
    manual.decide(10_000, { outcome: 'downgraded', reason: 'gate-passed', selection: { candidateId: 'cheap', ...cheap } })
    manual.turn(11_000, 3)
    manual.header(11_000, cheap)
    expect(coldPointAt(manual.events, STRONG_ROUTE, FIVE_MINUTES, 20_000, false)?.kind).toBe('manual-switch')

    const kept = new TimedLog()
    strongTurn(kept, 0, 1)
    kept.turn(10_000, 2)
    kept.decide(10_000, { outcome: 'kept-strong', reason: 'low-confidence' })
    kept.header(10_000, cheap)
    expect(coldPointAt(kept.events, STRONG_ROUTE, FIVE_MINUTES, 20_000, false)?.kind).toBe('manual-switch')

    const selected = new TimedLog()
    const answered = strongTurn(selected, 0, 1)
    selected.select(5_000, cheap)
    selected.select(6_000, STRONG_ROUTE)
    expect(coldPointAt(selected.events, STRONG_ROUTE, FIVE_MINUTES, 20_000, false)).toEqual({
      kind: 'manual-switch', ttlMs: 300_000, ttlSource: 'fallback', idleMs: 20_000, lastBaseSeq: answered,
    })
  })

  it('idle beyond adapter TTL is cold; within is warm', () => {
    const log = new TimedLog()
    const answered = strongTurn(log, 1_000, 1)
    // The lifetime counts from the start of the answering step, not the answer.
    expect(coldPointAt(log.events, STRONG_ROUTE, ONE_HOUR, 1_000 + 3_600_000, false)).toBeUndefined()
    expect(coldPointAt(log.events, STRONG_ROUTE, ONE_HOUR, 1_000 + 3_600_001, false)).toEqual({
      kind: 'idle', ttlMs: 3_600_000, ttlSource: 'adapter', idleMs: 3_600_001, lastBaseSeq: answered,
    })
    // The same gap is warm under a longer lifetime and cold under the five-minute fallback.
    expect(coldPointAt(log.events, STRONG_ROUTE, FIVE_MINUTES, 1_000 + 300_001, false)?.kind).toBe('idle')
    expect(coldPointAt(log.events, STRONG_ROUTE, ONE_HOUR, 1_000 + 300_001, false)).toBeUndefined()
  })

  it('measures from the answer itself when the log lacks its step start', () => {
    const log = new TimedLog()
    log.turn(0, 1)
    log.step(0, 1)
    const answered = log.answer(50_000, 2, STRONG_ROUTE)
    expect(coldPointAt(log.events, STRONG_ROUTE, FIVE_MINUTES, 350_000, false)).toBeUndefined()
    expect(coldPointAt(log.events, STRONG_ROUTE, FIVE_MINUTES, 350_001, false)).toEqual({
      kind: 'idle', ttlMs: 300_000, ttlSource: 'fallback', idleMs: 300_001, lastBaseSeq: answered,
    })
  })

  it('ttl 0 is always cold', () => {
    const log = new TimedLog()
    const answered = strongTurn(log, 0, 1)
    // An answer a millisecond ago keeps no prefix when the route keeps no cache.
    expect(coldPointAt(log.events, STRONG_ROUTE, NONE, 1, false)).toEqual({
      kind: 'no-cache', ttlMs: 0, ttlSource: 'adapter', idleMs: 1, lastBaseSeq: answered,
    })
    expect(coldPointAt(new TimedLog().events, STRONG_ROUTE, NONE, 0, false)?.kind).toBe('session-start')
  })

  it('replay reads the recorded step start, not the clock', () => {
    const log = new TimedLog()
    strongTurn(log, 1_000, 1)
    log.turn(61_000, 2)
    log.step(61_000, 2)
    vi.useFakeTimers({ now: 1_000 + 10 * 3_600_000 })
    try {
      // Hours later on the wall clock, the consult still measures to the logged step start.
      expect(latestStepStart(log.events)).toBe(61_000)
      expect(coldPointAt(log.events, STRONG_ROUTE, FIVE_MINUTES, latestStepStart(log.events)!, false)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
    expect(latestStepStart(new TimedLog().events)).toBeUndefined()
  })
})
