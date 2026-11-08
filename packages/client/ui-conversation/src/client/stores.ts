/**
 * Per-session chat store shared by conversation and details registrations.
 * The plugin creates its handle at apply time so identity follows the fiber.
 */
import { defineStore, type EngineStoreHandle } from '@shres-code/shres-code-client-runtime/client'
import type { ChatStoreState, InspectRequest, SelectionTarget } from './contract/views.ts'

/** Declared action shape used to give the exported factory a stable return type. */
type ChatActions = {
  select: (draft: ChatStoreState, target: SelectionTarget | null) => void
  setDraft: (draft: ChatStoreState, text: string) => void
  setView: (draft: ChatStoreState, view: string) => void
  setInspect: (draft: ChatStoreState, request: InspectRequest | null) => void
  setActivityOpen: (draft: ChatStoreState, open: boolean) => void
}

/** Session-local viewing state for Chat rows that may leave the DOM window. */
export interface ChatRowViewingState {
  /** Expanded disclosure keys; collapsed rows are omitted. */
  expanded: Record<string, true>
  /** Browser deadlines first observed for retry rows, keyed by Chat node key. */
  retryDeadlines: Record<string, number>
}

/** Writes exposed to Chat row renderers without exposing the store instance. */
type ChatRowViewingActions = {
  setExpanded: (draft: ChatRowViewingState, key: string, expanded: boolean) => void
  rememberRetryDeadline: (draft: ChatRowViewingState, key: string, deadline: number) => void
}

/**
 * Declares the per-session chat state and write surface.
 * @returns the store handle.
 */
export function createChatStore(): EngineStoreHandle<ChatStoreState, ChatActions> {
  return defineStore({
    // Anchored to the contract shape: consumers read the store through
    // PropsStore<ChatStore>'s SnapshotSelectorHook<ChatStoreState>, so init
    // and the contract cannot drift.
    init: (): ChatStoreState => ({ selection: null, draft: '', view: null, inspect: null, activityOpen: false }),
    persist: 'shres.conversation.chat',
    // The Activity popover is open for one visit only, so a reload never renders it open.
    transient: ['activityOpen'],
    actions: {
      select: (d, target: SelectionTarget | null) => { d.selection = target },
      setDraft: (d, text: string) => { d.draft = text },
      setView: (d, view: string) => { d.view = view },
      setInspect: (d, request: InspectRequest | null) => { d.inspect = request },
      setActivityOpen: (d, open: boolean) => { d.activityOpen = open },
    },
  })
}

/**
 * Declares transient per-session Chat row viewing state.
 *
 * The handle is mounted on each built-in keyed Chat renderer. Its session
 * instance survives virtual row unmounts while remaining independent of the
 * durable conversation store and of other sessions.
 *
 * @returns the row-viewing store handle.
 */
export function createChatRowViewingStore(): EngineStoreHandle<ChatRowViewingState, ChatRowViewingActions> {
  return defineStore({
    init: (): ChatRowViewingState => ({ expanded: {}, retryDeadlines: {} }),
    actions: {
      setExpanded: (draft, key: string, expanded: boolean) => {
        if (expanded) draft.expanded[key] = true
        else {
          if (draft.expanded[key] === undefined) return
          const { [key]: _removed, ...remaining } = draft.expanded
          draft.expanded = remaining
        }
      },
      rememberRetryDeadline: (draft, key: string, deadline: number) => {
        if (draft.retryDeadlines[key] === undefined) draft.retryDeadlines[key] = deadline
      },
    },
  })
}

/**
 * Build a collision-free viewing key under one Chat node.
 * @param nodeKey - stable Conversation Node identity.
 * @param part - row or sub-row discriminator within that node.
 * @returns the store key for the viewing state.
 */
export function chatRowViewingKey(nodeKey: string, part: string): string {
  return JSON.stringify([nodeKey, part])
}
