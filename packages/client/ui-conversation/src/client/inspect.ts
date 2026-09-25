/**
 * Cross-view inspect handoff: the persisted-snapshot read of the chat store's
 * `inspect` field and the `reveal` write that addresses one view.
 */
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
