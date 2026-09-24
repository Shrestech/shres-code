/**
 * The two pure folds over the session log. \`foldModelRouting\` reads the mode in
 * force; \`stickyState\` replays the documented transitions of a downgraded
 * streak (entry, hold, gate-failed, escalate, manual deviation, mode-off,
 * route-errors) from \`model-routing/decision\`, \`model-routing/mode\`,
 * \`request/header\`, and turn events. Both are pure functions of the log, which
 * is what lets resume, fork, compaction, and a bench replay continue a streak:
 * the last case below folds a prefix and gets exactly the state that prefix
 * produced before the later events were appended.
 *
 * The logs here are bare sessions (no store, no invariant host): a fold sees
 * only the events a case appends.
 */

import { describe, expect, it } from 'vitest'
import { ReasoningEffortId, createUserMessage } from '@shres-code/shres-code-llm'
import type { LlmFailure } from '@shres-code/shres-code-llm'
import { Session, SessionId } from '@shres-code/shres-code-session'
import type { TurnEndReason } from '@shres-code/shres-code-session'
import {
  advanceStickyFoldState,
  createStickyFoldState,
  foldModelRouting,
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
    expect(foldModelRouting(session.events)).toBe(false)
    expect(foldModelRouting(session.events, session.events.length, true)).toBe(true)
    expect(foldModelRouting(session.events, 0, true)).toBe(true)
  })

  it('takes the last mode event', () => {
    const session = scripted('mode-last-wins')
    session.append('model-routing/mode', { active: true })
    expect(foldModelRouting(session.events)).toBe(true)
    session.append('model-routing/mode', { active: false })
    expect(foldModelRouting(session.events)).toBe(false)
    session.append('model-routing/mode', { active: true })
    expect(foldModelRouting(session.events)).toBe(true)
  })

  it('honours the end prefix', () => {
    const session = scripted('mode-prefix')
    session.append('model-routing/mode', { active: true })
    session.append('model-routing/mode', { active: false })
    expect(foldModelRouting(session.events, 1)).toBe(true)
    expect(foldModelRouting(session.events, 0)).toBe(false)
    // Past the end nothing changes; the prefix rule is the whole rule.
    expect(foldModelRouting(session.events, 99)).toBe(false)
  })
})

describe('stickyState entry', () => {
  it('is strong over an empty log', () => {
    expect(stickyState(scripted('sticky-empty').events)).toEqual({ active: false, turnsElapsed: 0 })
  })

  it('derives enteredTurn, entryBase, and elapsed turns from a downgraded decision', () => {
    const session = scripted('sticky-entry')
    open(session, 1)
    open(session, 1)
    header(session, STRONG_BASE.provider, STRONG_BASE.model)
    user(session, 'a small change')
    session.append('model-routing/decision', decision({ active: true, turnsElapsed: 0, enteredTurn: 1 }))
    close(session, 1)
    open(session, 2)

    expect(stickyState(session.events)).toEqual({
      active: true,
      turnsElapsed: 1,
      enteredTurn: 1,
      candidate: CHEAP,
      entryBase: STRONG_BASE,
      routeErrorLimit: ROUTE_ERROR_LIMIT,
    })
  })

  it('prefers the recorded entry base over the last request header', () => {
    const recordedBase = { provider: 'manual-provider', model: 'manual-model' }
    const view = { active: true, turnsElapsed: 0, enteredTurn: 1, entryBase: recordedBase, routeErrorLimit: ROUTE_ERROR_LIMIT }

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
      turnsElapsed: 0,
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
    session.append('model-routing/decision', decision({ active: true, turnsElapsed: 0, enteredTurn: 1 }))

    expect(stickyState(session.events).entryBase).toEqual({ ...STRONG_BASE, reasoningEffort: 'high' })
  })

  it('takes the turn in force when the logged decision names none', () => {
    const session = scripted('sticky-entry-unnumbered')
    header(session, STRONG_BASE.provider, STRONG_BASE.model)
    session.append('model-routing/decision', decision({ active: true, turnsElapsed: 0 }))
    expect(stickyState(session.events)).toEqual({
      active: true,
      turnsElapsed: 0,
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
    header(session, STRONG_BASE.provider, STRONG_BASE.model)
    user(session, 'a small change')
    session.append('model-routing/decision', decision({ active: true, turnsElapsed: 0, enteredTurn: 1 }))
    close(session, 1)
    open(session, 2)
    return session
  }

  it('keeps enteredTurn and entryBase across a second decision', () => {
    const session = entered('sticky-hold')
    // The loop rewrote the header to the candidate while the streak holds; that
    // must not move the entry base.
    header(session, CHEAP.provider, CHEAP.model, 'plan mode is on')
    session.append('model-routing/decision', decision({ active: true, turnsElapsed: 1, enteredTurn: 1 }))
    close(session, 2)
    open(session, 3)

    expect(stickyState(session.events)).toEqual({
      active: true,
      turnsElapsed: 2,
      enteredTurn: 1,
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
      sticky: { active: true, turnsElapsed: 1, enteredTurn: 1, routeErrorLimit: ROUTE_ERROR_LIMIT },
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
      sticky: { active: true, turnsElapsed: 0, enteredTurn: 1, routeErrorLimit: ROUTE_ERROR_LIMIT },
    })
    session.append('model-routing/decision', decision({ active: true, turnsElapsed: 0, enteredTurn: 1 }))

    expect(stickyState(session.events).candidate).toEqual(CHEAP)
  })
})

describe('stickyState break reasons', () => {
  function entered(id: string): Session {
    const session = scripted(id)
    open(session, 1)
    header(session, STRONG_BASE.provider, STRONG_BASE.model)
    session.append('model-routing/decision', decision({ active: true, turnsElapsed: 0, enteredTurn: 1 }))
    open(session, 2)
    return session
  }

  it('reports the brokenBy of a decision that ends the streak', () => {
    const session = entered('break-decision')
    session.append('model-routing/decision', decision({ active: false, turnsElapsed: 0, brokenBy: 'gate-failed' }))
    expect(stickyState(session.events)).toEqual({ active: false, turnsElapsed: 0, brokenBy: 'gate-failed' })
  })

  it('reports no brokenBy for a decision that never held a streak', () => {
    const session = scripted('break-none')
    session.append('model-routing/decision', decision({ active: false, turnsElapsed: 0 }))
    expect(stickyState(session.events)).toEqual({ active: false, turnsElapsed: 0 })
    // A brokenBy on a decision the fold saw while already strong is not a break.
    session.append('model-routing/decision', decision({ active: false, turnsElapsed: 0, brokenBy: 'escalated' }))
    expect(stickyState(session.events)).toEqual({ active: false, turnsElapsed: 0 })
  })

  it('clears the streak when the mode turns off', () => {
    const session = entered('break-mode-off')
    session.append('model-routing/mode', { active: false })
    expect(stickyState(session.events)).toEqual({ active: false, turnsElapsed: 0, brokenBy: 'mode-off' })
  })

  it('records nothing for a mode event the fold saw while already strong', () => {
    const session = scripted('break-mode-noop')
    session.append('model-routing/mode', { active: false })
    session.append('model-routing/mode', { active: true })
    expect(stickyState(session.events)).toEqual({ active: false, turnsElapsed: 0 })
  })

  it('clears the streak at the route-failure horizon', () => {
    const session = entered('break-route-errors')
    fail(session, 2, 'RATE_LIMIT')
    // One failure is below the two-failure horizon: the streak survives.
    expect(stickyState(session.events)).toMatchObject({ active: true, turnsElapsed: 1, candidate: CHEAP })
    fail(session, 3, 'RATE_LIMIT')
    expect(stickyState(session.events)).toMatchObject({ active: false, turnsElapsed: 0, brokenBy: 'route-errors', needsStrongTurn: true })
  })

  it('starts a fresh failure streak after route errors break the old one', () => {
    const session = entered('break-route-reentry')
    fail(session, 2, 'RATE_LIMIT')
    fail(session, 3, 'RATE_LIMIT')
    open(session, 4)
    session.append('model-routing/decision', decision({ active: true, turnsElapsed: 0, enteredTurn: 4 }))
    fail(session, 4, 'RATE_LIMIT')

    expect(stickyState(session.events)).toMatchObject({
      active: true,
      turnsElapsed: 0,
      candidate: CHEAP,
    })
  })

  describe('route-failed decisions', () => {
    /** Enter a fresh streak on `selection` at `turn` and record its in-turn fallback. */
    function enterAndFall(session: Session, turn: number, selection: ModelRoutingSelection = CHEAP): void {
      open(session, turn)
      session.append('model-routing/decision', decision({ active: true, turnsElapsed: 0, enteredTurn: turn, entryBase: STRONG_BASE }, { selection }))
      session.append('model-routing/decision', decision(
        { active: false, turnsElapsed: 0, brokenBy: 'route-failed', entryBase: STRONG_BASE },
        { reason: 'route-failed', failure: { code: 'AUTH', provider: selection.provider, model: selection.model } },
      ))
      close(session, turn)
    }

    it('route-failed decisions count toward maxRouteErrors across streaks', () => {
      const session = scripted('route-failed-across-streaks')
      enterAndFall(session, 1)
      // One fallback ends its streak without reaching the two-failure limit.
      expect(stickyState(session.events)).toEqual({ active: false, turnsElapsed: 0, brokenBy: 'route-failed' })
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
      expect(stickyState(other.events)).toEqual({ active: false, turnsElapsed: 0, brokenBy: 'route-failed' })

      const recovered = scripted('route-failed-recovered')
      enterAndFall(recovered, 1)
      open(recovered, 2)
      recovered.append('model-routing/decision', decision({ active: true, turnsElapsed: 0, enteredTurn: 2, entryBase: STRONG_BASE }))
      close(recovered, 2)
      enterAndFall(recovered, 3)
      expect(stickyState(recovered.events)).toEqual({ active: false, turnsElapsed: 0, brokenBy: 'route-failed' })
    })

    it('ends a streak that holds no candidate without counting a failure', () => {
      const session = scripted('route-failed-no-candidate')
      rawDecision(session, { active: true, routeErrorLimit: ROUTE_ERROR_LIMIT, turnsElapsed: 0, enteredTurn: 1 })
      session.append('model-routing/decision', decision(
        { active: false, turnsElapsed: 0, brokenBy: 'route-failed', entryBase: STRONG_BASE },
        { reason: 'route-failed', failure: { code: 'AUTH', provider: CHEAP.provider, model: CHEAP.model } },
      ))
      expect(stickyState(session.events)).toEqual({ active: false, turnsElapsed: 0, brokenBy: 'route-failed' })
    })

    it('ignores a route-failed decision the fold saw while strong', () => {
      const session = scripted('route-failed-while-strong')
      session.append('model-routing/decision', decision(
        { active: false, turnsElapsed: 0, brokenBy: 'route-failed', entryBase: STRONG_BASE },
        { reason: 'route-failed', failure: { code: 'AUTH', provider: CHEAP.provider, model: CHEAP.model } },
      ))
      expect(stickyState(session.events)).toEqual({ active: false, turnsElapsed: 0 })
    })
  })

  it('resets route failures when a held candidate changes', () => {
    const session = entered('break-route-candidate-transition')
    fail(session, 2, 'RATE_LIMIT')
    session.append('model-routing/decision', decision(
      { active: true, turnsElapsed: 1, enteredTurn: 1 },
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
    expect(stickyState(completed.events)).toMatchObject({ active: true, turnsElapsed: 1 })

    const aborted = entered('break-route-aborted')
    fail(aborted, 2, 'RATE_LIMIT')
    close(aborted, 3, { kind: 'aborted', reason: { kind: 'user' } })
    fail(aborted, 4, 'RATE_LIMIT')
    expect(stickyState(aborted.events)).toMatchObject({ active: true, turnsElapsed: 1 })

    for (const [id, code] of [['break-route-unknown', 'UNKNOWN'], ['break-route-aborted-code', 'ABORTED'], ['break-route-no-code', undefined]] as const) {
      const session = entered(id)
      fail(session, 2, code)
      fail(session, 3, code)
      expect(stickyState(session.events)).toMatchObject({ active: true, turnsElapsed: 1 })
    }
  })

  it('does not count failures while the fold is strong', () => {
    const session = scripted('break-route-strong')
    fail(session, 1, 'RATE_LIMIT')
    expect(stickyState(session.events)).toEqual({ active: false, turnsElapsed: 0 })
  })

  it('uses the latest recorded error limit without replaying an earlier failure', () => {
    const session = entered('break-route-limit-update')
    fail(session, 2, 'RATE_LIMIT')
    open(session, 3)
    session.append('model-routing/decision', decision({
      active: true,
      turnsElapsed: 1,
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
    rawDecision(missing, { active: true, turnsElapsed: 0, enteredTurn: 1 })
    expect(() => stickyState(missing.events)).toThrow(/routeErrorLimit/)

    const zero = scripted('malformed-route-limit-zero')
    rawDecision(zero, { active: true, turnsElapsed: 0, routeErrorLimit: 0 })
    expect(() => stickyState(zero.events)).toThrow(/routeErrorLimit/)

    const fractional = scripted('malformed-route-limit-fractional')
    rawDecision(fractional, { active: true, turnsElapsed: 0, routeErrorLimit: 1.5 })
    expect(() => stickyState(fractional.events)).toThrow(/routeErrorLimit/)

    const missingRecoveryBase = scripted('malformed-route-recovery-base')
    rawDecision(missingRecoveryBase, { active: false, turnsElapsed: 0, brokenBy: 'route-errors' })
    expect(() => stickyState(missingRecoveryBase.events)).toThrow(/entryBase/)

    const invalidRecoveryBase = scripted('malformed-route-recovery-base-fields')
    rawDecision(invalidRecoveryBase, {
      active: false,
      turnsElapsed: 0,
      brokenBy: 'route-errors',
      entryBase: { provider: '', model: 'strong-model' },
    })
    expect(() => stickyState(invalidRecoveryBase.events)).toThrow(/provider and model/)

    const nullRecoveryBase = scripted('malformed-route-recovery-base-null')
    rawDecision(nullRecoveryBase, {
      active: false,
      turnsElapsed: 0,
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
    session.append('model-routing/decision', decision({ active: true, turnsElapsed: 0, enteredTurn: 1 }))
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
      turnsElapsed: 0,
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
    session.append('model-routing/decision', decision({ active: true, turnsElapsed: 0, enteredTurn: 1 }))
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
      turnsElapsed: 0,
      enteredTurn: 4,
      entryBase: STRONG_BASE,
    }))
    expect(stickyState(session.events)).toMatchObject({ active: true, needsStrongTurn: true, recoveryTurn: 4 })
    header(session, STRONG_BASE.provider, STRONG_BASE.model)
    close(session, 4)
    expect(stickyState(session.events).needsStrongTurn).toBeUndefined()
  })
})

describe('stickyState purity', () => {
  it('reproduces an earlier state from the same log prefix', () => {
    const session = scripted('sticky-purity')
    open(session, 1)
    header(session, STRONG_BASE.provider, STRONG_BASE.model)
    user(session, 'a small change')
    session.append('model-routing/decision', decision({ active: true, turnsElapsed: 0, enteredTurn: 1 }))
    const entryEnd = session.events.length
    const enteredState = stickyState(session.events)
    open(session, 2)

    close(session, 2)
    open(session, 3)
    header(session, CHEAP.provider, CHEAP.model)
    session.append('model-routing/decision', decision({ active: true, turnsElapsed: 1, enteredTurn: 1 }))

    expect(stickyState(session.events, entryEnd)).toEqual(enteredState)
    expect(stickyState(session.events)).toEqual(stickyState(session.events))
    expect(stickyState(session.events)).toEqual({
      active: true,
      turnsElapsed: 2,
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
    session.append('model-routing/decision', decision({ active: true, turnsElapsed: 0, enteredTurn: 1 }))
    close(session, 1)
    open(session, 2)
    close(session, 2, { kind: 'completed' })
    open(session, 3)
    header(session, CHEAP.provider, CHEAP.model)
    session.append('model-routing/decision', decision({ active: true, turnsElapsed: 1, enteredTurn: 1 }))
    fail(session, 3, 'RATE_LIMIT')
    open(session, 4)
    session.append('model-routing/mode', { active: false })

    let state = createStickyFoldState()
    for (let end = 0; end <= session.events.length; end += 1) {
      if (end > 0) state = advanceStickyFoldState(state, session.events[end - 1]!)
      expect(readStickyFoldState(state)).toEqual(stickyState(session.events, end))
    }
  })
})
