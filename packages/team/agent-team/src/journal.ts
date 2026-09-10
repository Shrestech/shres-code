/**
 * Serialized Team transactions over the exact live Lead Session log.
 *
 * An acknowledged append is durable before any later delivery attempt: the
 * journal reaches `ctx.sessions.flush(session)` and requires at least one
 * persistence listener. Persistence plugins subscribe to `session/flush`
 * (see `packages/session/session-persistence/src/coordinator.ts`).
 *
 * @module @shres-code/shres-code-agent-team/journal
 */

import type { Context } from '@shres-code/cordis'
import type { Session, SessionEventMap, SessionId } from '@shres-code/shres-code-session'
import { TeamError } from './error.ts'
import type { TeamEventType } from './fold.ts'

type MutableTeamEventType = TeamEventType
type AppendTeamEvent = <T extends MutableTeamEventType>(
  type: T,
  data: SessionEventMap[T],
  opts: { ignorable: true },
) => void

/** Owns per-Lead transaction order and committed Team event publication. */
export class TeamJournal {
  private readonly tails = new Map<SessionId, Promise<void>>()

  /**
   * @param ctx - context carrying the live session store.
   */
  constructor(private readonly ctx: Context) {}

  /**
   * Serialize one Lead's asynchronous mutation operation.
   * @param rootId - Lead Session identity selecting the transaction queue.
   * @param operation - complete read-check-append operation.
   * @returns the operation result.
   */
  async transact<T>(rootId: SessionId, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(rootId) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.tails.set(rootId, tail)
    try {
      return await run
    } finally {
      if (this.tails.get(rootId) === tail) this.tails.delete(rootId)
    }
  }

  /**
   * Append one root-owned Team event and wait for the session durability barrier.
   * @param session - exact live Lead Session that owns the event.
   * @param type - Team event discriminant.
   * @param data - payload correlated with the event type.
   * @returns after at least one persistence listener acknowledges completed durability work.
   * @throws {TeamError} when flush rejects or no persistence listener participates.
   */
  async appendAndFlush<T extends MutableTeamEventType>(
    session: Session,
    type: T,
    data: SessionEventMap[T],
  ): Promise<void> {
    // Team events never enter the conversation surface. This narrower local
    // capability removes Session.append's conditional surface argument while
    // preserving the event-key/payload correlation.
    const append = session.append.bind(session) as unknown as AppendTeamEvent
    append(type, data, { ignorable: true })
    await this.flush(session)
  }

  /**
   * Require one successful shared persistence checkpoint.
   * @param session - exact live session to checkpoint.
   * @returns after at least one listener acknowledges completed durability work.
   */
  async flush(session: Session): Promise<void> {
    try {
      if (!await this.ctx.sessions.flush(session)) {
        throw new TeamError('Agent Team persistence did not complete.', 'TEAM_PERSISTENCE_FAILED')
      }
    } catch (error: unknown) {
      if (error instanceof TeamError) throw error
      throw new TeamError('Agent Team persistence did not complete.', 'TEAM_PERSISTENCE_FAILED')
    }
  }
}
