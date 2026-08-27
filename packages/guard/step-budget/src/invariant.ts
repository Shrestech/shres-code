/**
 * Package-owned durable step-budget invariants.
 * @module @shres-code/shres-code-step-budget/invariant
 */

import type { Context } from '@shres-code/cordis'
import type { InvariantFailure, InvariantInstaller } from '@shres-code/shres-code-invariants'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import './types.ts'

const PACKAGE_NAME = '@shres-code/shres-code-step-budget'

/** Cordis companion plugin name. */
export const name = 'step-budget-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** One session's position in the loop's turn stream, as this fold has seen it. */
interface TurnState {
  /** Turn opened by the latest unmatched `turn/start`, or `undefined` between turns. */
  open: number | undefined
  /** Whether the open turn already recorded a stop. */
  stopped: boolean
}

/**
 * Validate one candidate event against the fold, without mutating it. A stop
 * only makes sense inside the turn it ends, exactly once, one step past a
 * positive budget.
 * @param state - the committed turn position for this session.
 * @param event - the candidate event.
 * @param fail - invariant reporter.
 */
function validate(state: TurnState, event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'step-budget/exhausted') return
  const { turn, step, limit } = event.data
  if (!Number.isInteger(limit) || limit < 1) {
    fail(`step-budget/exhausted at seq ${String(event.seq)} carries limit ${String(limit)}; expected an integer >= 1`)
    return
  }
  if (step !== limit + 1) {
    fail(`step-budget/exhausted at seq ${String(event.seq)} stops at step ${String(step)}; expected ${String(limit + 1)}`)
    return
  }
  if (state.open === undefined || state.open !== turn) {
    fail(`step-budget/exhausted at seq ${String(event.seq)} names turn ${String(turn)}; the open turn is ${String(state.open)}`)
    return
  }
  if (state.stopped) {
    fail(`step-budget/exhausted at seq ${String(event.seq)} is the second stop recorded for turn ${String(turn)}`)
  }
}

/**
 * Advance the fold past one committed event.
 * @param state - the session's turn position.
 * @param event - the committed event.
 */
function advance(state: TurnState, event: SessionEvent): void {
  switch (event.type) {
    case 'turn/start':
      state.open = event.data.turn
      state.stopped = false
      break
    case 'turn/end':
      state.open = undefined
      break
    case 'step-budget/exhausted':
      state.stopped = true
      break
    default:
      break
  }
}

/** Install an independent incremental fold over every attached session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, TurnState>()

  const seed = (session: Session): TurnState => {
    const state: TurnState = { open: undefined, stopped: false }
    for (const event of session.events) {
      validate(state, event, fail)
      advance(state, event)
    }
    states.set(session, state)
    return state
  }
  /* v8 ignore next -- session/event always follows list() or session/created seeding */
  const stateFor = (session: Session): TurnState => states.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  // Validate before the append commits, then advance only on publication, so a
  // refused event never moves the fold.
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    validate(stateFor(session), event, fail)
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    advance(stateFor(session), event)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the step-budget invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
