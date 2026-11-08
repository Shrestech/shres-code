/** Session-scoped viewing state for Cordis definition cards. */
import { defineStore, type CallId, type EngineStoreHandle } from '@shres-code/shres-code-client-runtime/client'

/** Source tabs available on one Cordis definition card. */
export type CordisSourceTab = 'client' | 'host'

/** Session viewing state keyed by the immutable Tool call id. */
interface CordisDefineViewState {
  sourceByCall: Record<CallId, CordisSourceTab>
}

/** Actions for the Cordis definition-card viewing store. */
type CordisDefineViewActions = {
  setSource: (draft: CordisDefineViewState, callId: CallId, source: CordisSourceTab) => void
}

/** Store handle mounted by the keyed `cordis_define` Tool view. */
export type CordisDefineViewStore = ReturnType<typeof createCordisDefineViewStore>

/**
 * Create session-scoped definition-card viewing state.
 *
 * @returns the store handle for one keyed `cordis_define` registration.
 */
export function createCordisDefineViewStore(): EngineStoreHandle<CordisDefineViewState, CordisDefineViewActions> {
  return defineStore({
    init: (): CordisDefineViewState => ({ sourceByCall: {} }),
    actions: {
      setSource: (draft, callId: CallId, source: CordisSourceTab) => {
        draft.sourceByCall[callId] = source
      },
    },
  })
}
