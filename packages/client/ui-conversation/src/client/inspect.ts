/**
 * Cross-view inspect handoff: the persisted-snapshot read of the chat store's
 * `inspect` field and the `reveal` write that addresses one view.
 */
import type { SessionId } from '@shres-code/shres-code-client-runtime/client'
import type { InspectRequest } from './contract/views.ts'

/** 'conversation.view' entry id of the Trajectory view, the target of chat's call inspection. */
export const TRAJECTORY_VIEW_ID = 'trajectory'

/** The chat-store writes one reveal performs. */
export interface RevealActions {
  setInspect: (request: InspectRequest | null) => void
  setView: (view: string) => void
  setActivityOpen: (open: boolean) => void
}

/**
 * Read the chat store's persisted `inspect` value. The store rehydrates
 * localStorage JSON without validation, so this read is where a stored value
 * becomes a typed request: a current request returns as the same object, the
 * legacy `{ callId }` value becomes a Trajectory call target, and every other
 * value reads as null.
 * @param value - the store's `inspect` field as rehydrated.
 * @returns the request, or null when idle or unrecognized.
 */
export function readInspectRequest(value: unknown): InspectRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (!('view' in record) && !('target' in record)) {
    const callId = record['callId']
    return typeof callId === 'string' && callId !== ''
      ? { view: TRAJECTORY_VIEW_ID, target: { kind: 'call', callId } }
      : null
  }
  const view = record['view']
  const target = record['target']
  if (typeof view !== 'string' || view === '' || typeof target !== 'object' || target === null) return null
  const fields = target as Record<string, unknown>
  switch (fields['kind']) {
    case 'call':
      return typeof fields['callId'] === 'string' && fields['callId'] !== '' ? value as InspectRequest : null
    case 'event': {
      const seq = fields['seq']
      return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? value as InspectRequest : null
    }
    default:
      return null
  }
}

/**
 * Build one session's reveal: write the request, select the view it addresses,
 * and close the Activity popover, all through that session's chat store. A
 * `none` target writes no request, which also clears any pending one: there is
 * nothing for the view to apply or acknowledge.
 * @param actions - the session's bound chat-store actions.
 * @returns the reveal function.
 */
export function createReveal(actions: RevealActions): (request: InspectRequest) => void {
  return (request) => {
    actions.setInspect(request.target.kind === 'none' ? null : request)
    actions.setView(request.view)
    actions.setActivityOpen(false)
  }
}

/**
 * Every mounted session's reveal, and at most one request waiting for a
 * session whose body has not mounted: the latest one wins, and it is applied
 * after the session's registration records its reveal, outside that render.
 */
export class SessionReveals {
  private readonly reveals = new Map<SessionId, (request: InspectRequest) => void>()
  private readonly pending = new Map<SessionId, InspectRequest>()

  /** @param canReveal - whether a 'conversation.view' entry with this id is registered. */
  constructor(private readonly canReveal: (view: string) => boolean) {}

  /**
   * Record a session's reveal and apply a request waiting for it.
   * @param sessionId - the session whose body mounted.
   * @param reveal - its reveal.
   * @returns whether the session had no reveal recorded before.
   */
  record(sessionId: SessionId, reveal: (request: InspectRequest) => void): boolean {
    const fresh = !this.reveals.has(sessionId)
    this.reveals.set(sessionId, reveal)
    const waiting = this.pending.get(sessionId)
    if (waiting !== undefined) {
      this.pending.delete(sessionId)
      // The registration records its reveal while it renders; the write waits
      // until that render is done.
      queueMicrotask(() => { this.reveals.get(sessionId)?.(waiting) })
    }
    return fresh
  }

  /**
   * Drop a session's reveal when its scope ends.
   * @param sessionId - the session.
   */
  forget(sessionId: SessionId): void {
    this.reveals.delete(sessionId)
  }

  /**
   * A mounted session's reveal.
   * @param sessionId - the session.
   * @returns its reveal, or undefined while its body is not mounted.
   */
  get(sessionId: SessionId): ((request: InspectRequest) => void) | undefined {
    return this.reveals.get(sessionId)
  }

  /**
   * Reveal a view in one session: at once while its body is mounted, else when it next mounts.
   * @param sessionId - the session.
   * @param request - the view and target.
   * @throws Error naming the view when no 'conversation.view' entry has its id.
   */
  reveal(sessionId: SessionId, request: InspectRequest): void {
    if (!this.canReveal(request.view)) throw new Error(`ui-conversation: no conversation view "${request.view}" to reveal`)
    const reveal = this.reveals.get(sessionId)
    if (reveal === undefined) this.pending.set(sessionId, request)
    else reveal(request)
  }
}
