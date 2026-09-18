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
import { createUserMessage } from '@shres-code/shres-code-llm'
import type { LlmFailure } from '@shres-code/shres-code-llm'
import { Session, SessionId } from '@shres-code/shres-code-session'
import type { TurnEndReason } from '@shres-code/shres-code-session'
import { resolveConfig } from '../src/config.ts'
import { foldModelRouting, stickyState } from '../src/folds.ts'
import type { ModelRoutingDecision, ModelRoutingSelection, ModelRoutingStickyView } from '../src/types.ts'

const CHEAP: ModelRoutingSelection = { candidateId: 'cheap', provider: 'cheap-provider', model: 'cheap-model' }
const STRONG_BASE = { provider: 'strong-provider', model: 'strong-model' }

/** Resolved config with a two-turn horizon and a two-failure route-error streak. */
const CONFIG = resolveConfig({
  initialMode: 'on',
  candidates: [{ id: 'cheap', provider: 'cheap-provider', model: 'cheap-model' }],
  downgradeThreshold: 0.8,
  downgradeMargin: 0.1,
  routeInstructions: 'Which route should handle this turn?',
  difficultyInstructions: 'How hard is this turn?',
  minTurnsDowngraded: 2,
  maxRouteErrors: 2,
})

/** One logged decision; \`sticky\` scripts the transition the case replays. */
function decision(sticky: ModelRoutingStickyView, overrides: Partial<ModelRoutingDecision> = {}): ModelRoutingDecision {
  return {
    outcome: sticky.active ? 'downgraded' : 'kept-strong',
    reason: sticky.active ? 'gate-passed' : 'gate-failed',
    stateHash: '00000000',
    stateSeqs: [0],
    ...sticky.active ? { selection: CHEAP } : {},
    sticky,
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
    expect(stickyState(scripted('sticky-empty').events, CONFIG)).toEqual({ active: false, turnsElapsed: 0 })
  })

  it('derives enteredTurn, entryBase, and elapsed turns from a downgraded decision', () => {
    const session = scripted('sticky-entry')
    open(session, 1)
    header(session, STRONG_BASE.provider, STRONG_BASE.model)
    user(session, 'a small change')
    session.append('model-routing/decision', decision({ active: true, turnsElapsed: 0, enteredTurn: 1 }))
    close(session, 1)
    open(session, 2)

    expect(stickyState(session.events, CONFIG)).toEqual({
      active: true,
      turnsElapsed: 1,
      enteredTurn: 1,
      candidate: CHEAP,
      entryBase: STRONG_BASE,
    })
  })

  it('prefers the recorded entry base over the last request header', () => {
    const recordedBase = { provider: 'manual-provider', model: 'manual-model' }
    const view = { active: true, turnsElapsed: 0, enteredTurn: 1, entryBase: recordedBase }

    // A header the fold saw before the entering decision does not win: the record
    // is what the consult wrote for this streak.
    const withHeader = scripted('sticky-entry-recorded')
    header(withHeader, STRONG_BASE.provider, STRONG_BASE.model)
    withHeader.append('model-routing/decision', decision(view))
    expect(stickyState(withHeader.events, CONFIG).entryBase).toEqual(recordedBase)

    // With no header at all the record is the only base there is.
    const headerless = scripted('sticky-entry-headerless')
    headerless.append('model-routing/decision', decision(view))
    expect(stickyState(headerless.events, CONFIG)).toEqual({
      active: true,
      turnsElapsed: 0,
      enteredTurn: 1,
      candidate: CHEAP,
      entryBase: recordedBase,
    })
  })

  it('takes the turn in force when the logged decision names none', () => {
    const session = scripted('sticky-entry-unnumbered')
    header(session, STRONG_BASE.provider, STRONG_BASE.model)
    session.append('model-routing/decision', decision({ active: true, turnsElapsed: 0 }))
    expect(stickyState(session.events, CONFIG)).toEqual({
      active: true,
      turnsElapsed: 0,
      enteredTurn: 0,
      candidate: CHEAP,
      entryBase: STRONG_BASE,
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

    expect(stickyState(session.events, CONFIG)).toEqual({
      active: true,
      turnsElapsed: 2,
      enteredTurn: 1,
      candidate: CHEAP,
      entryBase: STRONG_BASE,
    })
  })

  it('keeps the held candidate when a decision names no selection', () => {
    const session = entered('sticky-hold-unnamed')
    session.append('model-routing/decision', {
      outcome: 'downgraded',
      reason: 'sticky-hold',
      stateHash: '00000000',
      stateSeqs: [0],
      sticky: { active: true, turnsElapsed: 1, enteredTurn: 1 },
    })
    expect(stickyState(session.events, CONFIG).candidate).toEqual(CHEAP)
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
    expect(stickyState(session.events, CONFIG)).toEqual({ active: false, turnsElapsed: 0, brokenBy: 'gate-failed' })
  })

  it('reports no brokenBy for a decision that never held a streak', () => {
    const session = scripted('break-none')
    session.append('model-routing/decision', decision({ active: false, turnsElapsed: 0 }))
    expect(stickyState(session.events, CONFIG)).toEqual({ active: false, turnsElapsed: 0 })
    // A brokenBy on a decision the fold saw while already strong is not a break.
    session.append('model-routing/decision', decision({ active: false, turnsElapsed: 0, brokenBy: 'escalated' }))
    expect(stickyState(session.events, CONFIG)).toEqual({ active: false, turnsElapsed: 0 })
  })

  it('clears the streak when the mode turns off', () => {
    const session = entered('break-mode-off')
    session.append('model-routing/mode', { active: false })
    expect(stickyState(session.events, CONFIG)).toEqual({ active: false, turnsElapsed: 0, brokenBy: 'mode-off' })
  })

  it('records nothing for a mode event the fold saw while already strong', () => {
    const session = scripted('break-mode-noop')
    session.append('model-routing/mode', { active: false })
    session.append('model-routing/mode', { active: true })
    expect(stickyState(session.events, CONFIG)).toEqual({ active: false, turnsElapsed: 0 })
  })

  it('clears the streak at the route-failure horizon', () => {
    const session = entered('break-route-errors')
    fail(session, 2, 'RATE_LIMIT')
    // One failure is below the two-failure horizon: the streak survives.
    expect(stickyState(session.events, CONFIG)).toMatchObject({ active: true, turnsElapsed: 1, candidate: CHEAP })
    fail(session, 3, 'RATE_LIMIT')
    expect(stickyState(session.events, CONFIG)).toEqual({ active: false, turnsElapsed: 0, brokenBy: 'route-errors' })
  })

  it('resets the failure streak on a completed, aborted, or unattributable turn', () => {
    const completed = entered('break-route-completed')
    fail(completed, 2, 'RATE_LIMIT')
    close(completed, 3)
    fail(completed, 4, 'RATE_LIMIT')
    expect(stickyState(completed.events, CONFIG)).toMatchObject({ active: true, turnsElapsed: 1 })

    const aborted = entered('break-route-aborted')
    fail(aborted, 2, 'RATE_LIMIT')
    close(aborted, 3, { kind: 'aborted', reason: { kind: 'user' } })
    fail(aborted, 4, 'RATE_LIMIT')
    expect(stickyState(aborted.events, CONFIG)).toMatchObject({ active: true, turnsElapsed: 1 })

    for (const [id, code] of [['break-route-unknown', 'UNKNOWN'], ['break-route-aborted-code', 'ABORTED'], ['break-route-no-code', undefined]] as const) {
      const session = entered(id)
      fail(session, 2, code)
      fail(session, 3, code)
      expect(stickyState(session.events, CONFIG)).toMatchObject({ active: true, turnsElapsed: 1 })
    }
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
    const enteredState = stickyState(session.events, CONFIG)
    open(session, 2)

    close(session, 2)
    open(session, 3)
    header(session, CHEAP.provider, CHEAP.model)
    session.append('model-routing/decision', decision({ active: true, turnsElapsed: 1, enteredTurn: 1 }))

    expect(stickyState(session.events, CONFIG, entryEnd)).toEqual(enteredState)
    expect(stickyState(session.events, CONFIG)).toEqual(stickyState(session.events, CONFIG))
    expect(stickyState(session.events, CONFIG)).toEqual({
      active: true,
      turnsElapsed: 2,
      enteredTurn: 1,
      candidate: CHEAP,
      entryBase: STRONG_BASE,
    })
  })
})
