/**
 * Package-owned durable J-Space stream invariants.
 * @module @shres-code/shres-code-jspace/invariant
 */

import type { Context } from '@shres-code/cordis'
import type { InvariantFailure, InvariantInstaller } from '@shres-code/shres-code-invariants'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import { applyJspaceEvent, emptyJspaceFoldState } from './fold.ts'

const PACKAGE_NAME = '@shres-code/shres-code-jspace'

/** Cordis companion plugin name. */
export const name = 'jspace-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Copy the independent fold before validating one candidate event. */
function cloneState(state: ReturnType<typeof emptyJspaceFoldState>) {
  return {
    ...state,
    seenChecked: new Set(state.seenChecked),
  }
}

/** Apply one event through the fold and attribute failures. */
function applyChecked(
  state: ReturnType<typeof emptyJspaceFoldState>,
  event: SessionEvent,
  ownerSessionId: string,
  fail: InvariantFailure,
): void {
  const before = state.fault
  applyJspaceEvent(state, event, ownerSessionId)
  if (state.fault !== undefined && state.fault !== before) {
    fail(`session event ${String(event.seq)} violates the jspace stream: ${state.fault}`)
  }
}

/** Install an independent incremental fold over every attached session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, ReturnType<typeof emptyJspaceFoldState>>()
  const staged = new WeakMap<SessionEvent, { session: Session; state: ReturnType<typeof emptyJspaceFoldState> }>()

  const seed = (session: Session) => {
    const state = emptyJspaceFoldState()
    for (const event of session.events) applyChecked(state, event, session.id, fail)
    states.set(session, state)
    return state
  }
  /* v8 ignore next -- session/event always follows list() or session/created seeding */
  const stateFor = (session: Session) => states.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const state = cloneState(stateFor(session))
    applyChecked(state, event, session.id, fail)
    staged.set(event, { session, state })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    const candidate = staged.get(event)
    /* v8 ignore next 2 -- internal/dispatch stages the exact callback arguments */
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without matching jspace fold validation')
    }
    staged.delete(event)
    states.set(session, candidate.state)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the J-Space stream invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
