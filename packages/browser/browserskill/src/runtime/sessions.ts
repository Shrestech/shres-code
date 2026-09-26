/**
 * The owner-scoped registry of bsk sessions this runtime started. Every
 * lookup is by explicit owner; there is no current-session fallback, so one
 * agent session can never see or stop another's browser session.
 *
 * @module @shres-code/shres-code-browserskill/runtime/sessions
 */

import type { BskSessionId, BrowserInstanceId, SessionOwner } from '../types.ts'

/** One registered session and its owner. */
interface SessionEntry {
  owner: SessionOwner
  instanceId: BrowserInstanceId
}

/** Tracks which agent session owns which bsk session. */
export class SessionRegistry {
  private readonly entries = new Map<BskSessionId, SessionEntry>()

  /**
   * Register a freshly started session under its owner.
   * @param owner - the agent session that started it.
   * @param session - the bsk session id.
   * @param instanceId - the browser instance it bound.
   */
  register(owner: SessionOwner, session: BskSessionId, instanceId: BrowserInstanceId): void {
    this.entries.set(session, { owner, instanceId })
  }

  /**
   * Remove a session from the registry.
   * @param session - the session to forget.
   */
  unregister(session: BskSessionId): void {
    this.entries.delete(session)
  }

  /**
   * Whether this exact owner owns this exact session.
   * @param owner - the calling agent session.
   * @param session - the bsk session.
   * @returns `true` only when the pair matches a registered entry.
   */
  isOwnedBy(owner: SessionOwner, session: BskSessionId): boolean {
    return this.entries.get(session)?.owner === owner
  }

  /**
   * The instance a session is bound to.
   * @param session - the registered session.
   * @returns the instance id, or `undefined` when unknown.
   */
  instanceOf(session: BskSessionId): BrowserInstanceId | undefined {
    return this.entries.get(session)?.instanceId
  }

  /**
   * The caller's sessions only, in registration order.
   * @param owner - the calling agent session.
   * @returns the owned session ids.
   */
  listFor(owner: SessionOwner): readonly BskSessionId[] {
    return [...this.entries.entries()].filter(([, entry]) => entry.owner === owner).map(([session]) => session)
  }

  /**
   * Every registered session id, for ordered shutdown.
   * @returns all session ids in registration order.
   */
  all(): readonly BskSessionId[] {
    return [...this.entries.keys()]
  }

  /** Forget every session; used only when the runtime tears down. */
  clear(): void {
    this.entries.clear()
  }
}
