/**
 * Last-known J-Space card summary from the selected session projection.
 */

/** Open/closed and Checked-line count shown under the Settings switch. */
export interface JSpaceCardView {
  /** True while a native card is open. */
  readonly open: boolean
  /** Number of Checked lines on the last-known card. */
  readonly checked: number
}

/** Sessions reads the Settings page needs for the selected-session card. */
export interface JSpaceSessionRead {
  /** Current-session list snapshot. */
  readonly list: {
    getSnapshot(): { readonly current: string | undefined }
    subscribe(listener: () => void): () => void
  }
  /**
   * Resolve one listed session.
   * @param id - session id from {@link JSpaceSessionRead.list}.
   */
  binding(id: string): {
    readonly session: {
      readonly projections: {
        faceOf(key: string): {
          getSnapshot(): unknown
          subscribe(listener: () => void): () => void
        }
      }
    }
  } | undefined
}

/**
 * Fold one jspace projection snapshot onto the last-known view.
 * @param raw - `jspace` projection value, or undefined while absent.
 * @param previous - last view kept when the projection is missing or unchanged.
 * @returns the next view, or `previous` when the snapshot is absent or when
 *   `open` and `checked` match (useSyncExternalStore identity).
 */
export function foldJSpaceCardView(
  raw: unknown,
  previous: JSpaceCardView | undefined,
  sessionId?: string,
): JSpaceCardView | undefined {
  if (raw === undefined) return previous
  const card = (raw as { card?: { checked?: readonly unknown[]; sessionId?: string } | null }).card
  if (card === undefined) return previous
  if (card === null) return reuseCardView(previous, false, previous?.checked ?? 0)
  if (
    sessionId !== undefined
    && typeof card.sessionId === 'string'
    && card.sessionId.length > 0
    && card.sessionId !== sessionId
  ) {
    return reuseCardView(previous, false, previous?.checked ?? 0)
  }
  return reuseCardView(previous, true, card.checked?.length ?? 0)
}

/**
 * Return `previous` when `open` and `checked` already match.
 * @param previous - last view, if any.
 * @param open - next open flag.
 * @param checked - next Checked-line count.
 * @returns `previous` or a new view.
 */
function reuseCardView(
  previous: JSpaceCardView | undefined,
  open: boolean,
  checked: number,
): JSpaceCardView {
  if (previous !== undefined && previous.open === open && previous.checked === checked) {
    return previous
  }
  return { open, checked }
}

/**
 * Read the selected session's jspace projection, keeping last-known counts.
 * @param sessions - list + binding used by the Settings page.
 * @param previous - last view when no session or projection is present.
 * @returns the current or last-known view.
 */
export function readJSpaceView(
  sessions: JSpaceSessionRead,
  previous: JSpaceCardView | undefined,
): JSpaceCardView | undefined {
  const current = sessions.list.getSnapshot().current
  if (current === undefined) return previous
  const raw = sessions.binding(current)?.session.projections.faceOf('jspace').getSnapshot()
  return foldJSpaceCardView(raw, previous, current)
}

/**
 * Subscribe to the selected session's jspace face, rebinding on list change.
 * @param sessions - list + binding used by the Settings page.
 * @param listener - invoked after a list or projection change.
 * @returns disposer for both subscriptions.
 */
export function subscribeJSpaceView(
  sessions: JSpaceSessionRead,
  listener: () => void,
): () => void {
  let offFace = attachFace(sessions, listener)
  const offList = sessions.list.subscribe(() => {
    offFace()
    offFace = attachFace(sessions, listener)
    listener()
  })
  return () => {
    offList()
    offFace()
  }
}

/**
 * Observable last-known card view for the Settings page.
 * `getSnapshot` returns the same object until `open` or `checked` changes.
 * @param sessions - list + binding used by the Settings page.
 * @returns a source the renderer binds through `bindSnapshotSelector`.
 */
export function createJSpaceViewSource(sessions: JSpaceSessionRead): {
  getSnapshot(): JSpaceCardView | undefined
  subscribe(listener: () => void): () => void
} {
  let last: JSpaceCardView | undefined
  return {
    getSnapshot: () => {
      last = readJSpaceView(sessions, last)
      return last
    },
    subscribe: listener => subscribeJSpaceView(sessions, listener),
  }
}

/**
 * Attach the current session's jspace face, or a no-op when none is selected.
 * @param sessions - list + binding used by the Settings page.
 * @param listener - projection listener.
 * @returns disposer.
 */
function attachFace(sessions: JSpaceSessionRead, listener: () => void): () => void {
  const current = sessions.list.getSnapshot().current
  if (current === undefined) return () => {}
  const face = sessions.binding(current)?.session.projections.faceOf('jspace')
  if (face === undefined) return () => {}
  return face.subscribe(listener)
}
