/**
 * Package-owned durable Agent Team stream invariants.
 * @module @shres-code/shres-code-agent-team/invariant
 */

import type { Context } from '@shres-code/cordis'
import type { InvariantFailure, InvariantInstaller } from '@shres-code/shres-code-invariants'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import { applyTeamEvent, emptyTeamFoldState, isTeamEvent } from './fold.ts'
import type { TeamFoldState } from './fold.ts'
import { TeamId } from './brand.ts'

const PACKAGE_NAME = '@shres-code/shres-code-agent-team'

/** Cordis companion plugin name. */
export const name = 'agent-team-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Copy the independent fold before validating one candidate event. */
function cloneState(state: TeamFoldState): TeamFoldState {
  return {
    id: state.id,
    members: state.members.map(member => ({ ...member })),
    tasks: state.tasks.map(task => ({
      ...task,
      blockedBy: [...task.blockedBy],
      writeScopes: [...task.writeScopes],
    })),
    messages: state.messages.map(message => ({
      ...message,
      content: message.content.map(block => structuredClone(block)),
    })),
    delivered: [...state.delivered],
    nextTaskNumber: state.nextTaskNumber,
    fault: state.fault,
  }
}

/** Apply one event through the fold and attribute failures. */
function applyChecked(state: TeamFoldState, event: SessionEvent, fail: InvariantFailure): void {
  const before = state.fault
  applyTeamEvent(state, event)
  if (state.fault !== undefined && state.fault !== before) {
    fail(`session event ${String(event.seq)} violates the Agent Teams stream: ${state.fault}`)
  }
}

/** Install an independent incremental fold over every attached session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, TeamFoldState>()
  const staged = new WeakMap<SessionEvent, { session: Session; state: TeamFoldState }>()

  const seed = (session: Session): TeamFoldState => {
    const state = emptyTeamFoldState(TeamId(session.id))
    for (const event of session.events) applyChecked(state, event, fail)
    states.set(session, state)
    return state
  }
  /* v8 ignore next -- session/event always follows list() or session/created seeding */
  const stateFor = (session: Session): TeamFoldState => states.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (!isTeamEvent(event)) return
    const state = cloneState(stateFor(session))
    applyChecked(state, event, fail)
    staged.set(event, { session, state })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (!isTeamEvent(event)) return
    const candidate = staged.get(event)
    /* v8 ignore next 2 -- internal/dispatch stages the exact callback arguments */
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without matching Agent Teams fold validation')
    }
    staged.delete(event)
    states.set(session, candidate.state)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the Agent Teams stream invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
