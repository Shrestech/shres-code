/** Shared conversation view, selection, and store-state contracts. */

/** Tool call identity as carried on the wire (branded upstream in connection). */
export type CallId = string

/**
 * Call selection: the details panel shows the tool call's material (the step
 * special case carries a `stepSeq`). `kind` stays optional so the persisted
 * pre-file selection shape rehydrates as a call target untouched.
 */
export interface CallSelectionTarget { turnSeq: number; stepSeq?: number; callId?: CallId; toolName?: string }

/** File selection target: the details panel shows one workspace file's text. */
export interface FileSelectionTarget { kind: 'file'; path: string }

/**
 * Selection target for the details linkage channel. Call targets show the
 * selected tool call; a file target shows the file's text in the viewer.
 */
export type SelectionTarget = CallSelectionTarget | FileSelectionTarget

/**
 * One conversation view tab, projected from a 'conversation.view' slot
 * entry's registration options (label falls back to the entry id).
 */
export interface ViewTab { id: string; label: string }

/**
 * What one conversation view is asked to show. `call` names a tool call.
 * `event` names a session-event seq; the receiving view resolves it to the
 * record containing that event or, failing that, the nearest earlier record.
 * `none` only selects the view: `reveal` stores no request for it, so no view
 * receives or acknowledges one.
 */
export type InspectTarget =
  | { readonly kind: 'call'; readonly callId: CallId }
  | { readonly kind: 'event'; readonly seq: number }
  | { readonly kind: 'none' }

/** One cross-view handoff: the view to select and the target it shows. */
export interface InspectRequest {
  /** 'conversation.view' entry id that receives the target. */
  readonly view: string
  /** The target the receiving view opens. */
  readonly target: InspectTarget
}

/**
 * Per-session state shared by conversation, chat-view, and details slots.
 * Unknown persisted view ids fall back to the stable Chat view.
 */
export interface ChatStoreState {
  /** Details-linkage channel (conversation writes, details reads). */
  selection: SelectionTarget | null
  /** Composer draft (persisted; survives session switches and reloads). */
  draft: string
  /** Active conversation view id ('conversation.view' entry id); null falls back to Chat. */
  view: string | null
  /**
   * One-shot cross-view handoff: `reveal` writes it, and the view it addresses
   * applies it and acknowledges by clearing it. Persisted snapshots are read
   * through `readInspectRequest`: a snapshot without the field and any
   * unrecognized value read as null, and the legacy `{ callId }` value reads as
   * a Trajectory call target.
   */
  inspect: InspectRequest | null
  /**
   * Whether the session's Activity popover is open. `reveal` closes it, and
   * so does leaving the session. The field is transient in the persisted
   * store, so a reload starts it closed.
   */
  activityOpen: boolean
}
