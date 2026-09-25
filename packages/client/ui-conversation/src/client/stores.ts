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

/**
 * Read the chat store's persisted `activityOpen` field. The store rehydrates
 * localStorage JSON without validation, and a snapshot written before the
 * field existed carries none, so only a stored `true` reads as open.
 * @param value - the store's `activityOpen` field as rehydrated.
 * @returns whether the Activity popover is open.
 */
export function readActivityOpen(value: unknown): boolean {
  return value === true
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
    actions: {
      select: (d, target: SelectionTarget | null) => { d.selection = target },
      setDraft: (d, text: string) => { d.draft = text },
      setView: (d, view: string) => { d.view = view },
      setInspect: (d, request: InspectRequest | null) => { d.inspect = request },
      setActivityOpen: (d, open: boolean) => { d.activityOpen = open },
    },
  })
}
