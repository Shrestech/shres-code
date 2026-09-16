/** Short-lived inspect of persisted Team member Sessions. */

import type { SessionEvent, SessionHeader } from '@shres-code/shres-code-session'
import type { SessionId } from '@shres-code/shres-code-session'
import type { SessionPersistence } from '@shres-code/shres-code-session-persistence'

/** One persisted Session's detached header and complete committed event log. */
export interface PersistedSessionView {
  /** Exact fork-inherited event count paired with `header`. */
  readonly inheritedEventCount: number
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

/**
 * Read one stored session's header and complete event log.
 * @param persistence - the durable session store.
 * @param id - the stored session to read.
 * @param signal - cancellation observed by inspect.
 * @returns the stored header and every committed event.
 */
export async function readPersistedSession(
  persistence: SessionPersistence,
  id: SessionId,
  signal: AbortSignal,
): Promise<PersistedSessionView> {
  const loaded = await persistence.inspect(id, signal)
  return {
    header: loaded.meta,
    inheritedEventCount: loaded.meta.seedLength ?? 0,
    events: loaded.events,
  }
}
