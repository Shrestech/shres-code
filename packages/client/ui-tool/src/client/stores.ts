/** Session-scoped viewing state shared by Tool renderers that can unmount. */
import { defineStore, type CallId, type EngineStoreHandle } from '@shres-code/shres-code-client-runtime/client'

/** Expanded calls for one session. Collapsed calls are omitted immediately. */
export interface ToolDisclosureState {
  expanded: Record<CallId, true>
}

/** Actions for the Tool disclosure store. */
type ToolDisclosureActions = {
  setExpanded: (draft: ToolDisclosureState, callId: CallId, expanded: boolean) => void
}

/** Handle used by every Tool call renderer in one client composition. */
export type ToolDisclosureStore = ReturnType<typeof createToolDisclosureStore>

/**
 * Declares the per-session Tool disclosure store.
 *
 * Session-scoped expanded calls survive virtualized row unmounts; collapsing a
 * call removes its id immediately.
 *
 * @returns a store handle mounted by the Tool view registration.
 */
export function createToolDisclosureStore(): EngineStoreHandle<ToolDisclosureState, ToolDisclosureActions> {
  return defineStore({
    init: (): ToolDisclosureState => ({ expanded: {} }),
    actions: {
      setExpanded: (draft, callId: CallId, expanded: boolean) => {
        if (expanded) draft.expanded[callId] = true
        else {
          draft.expanded = Object.fromEntries(
            Object.entries(draft.expanded).filter(([id]) => id !== callId),
          )
        }
      },
    },
  })
}
