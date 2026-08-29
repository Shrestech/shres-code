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
   * One-shot inspect handoff: chat writes the call to reveal, the trajectory
   * view consumes it and acknowledges by clearing. Read with `?? null` —
   * persisted snapshots from before this field rehydrate without it.
   */
  inspect: { callId: CallId } | null
}
