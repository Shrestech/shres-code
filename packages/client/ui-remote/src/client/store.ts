/**
 * The remote group's view store: the registry mirror, the per-alias tunnel
 * mirror, the degraded hint, the group fold, the trust-modal state machine,
 * and per-operation busy flags — one observable snapshot fed by the apply
 * closure (remoteControl/remoteAdmin reads, forwarded tunnel-state events)
 * and mutated only through the declared mutators.
 *
 * This is deliberately NOT a register-declared engine store: the framework
 * creates and owns those instances privately (SlotRegistry.resolveStore), so
 * an apply-side `$on` subscription could never reach the instance the
 * renderer reads. The plugin-closure observable fed through the inject
 * `hooks` compartment is the sanctioned channel for a registrant-private
 * reactive fact (the ui-message-feedback controller pattern); PR3's settings
 * page shares the same closure instance the same way.
 */
import { createSnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import type { ConnectOutcome, RemoteEntryView, RemoteInspectView, TunnelStateView } from '@shres-code/shres-code-api-remotes/client'

/**
 * The trust modal's phases: inspecting runs the read, confirm carries the
 * TOFU/skew decision data, connecting holds during the granted connect, and
 * failed renders a wire failure (or unreachable outcome) with retry.
 */
export type RemoteModalState =
  | { phase: 'closed' }
  | { phase: 'inspecting'; alias: string }
  | { phase: 'confirm'; alias: string; inspect: RemoteInspectView; outcome?: ConnectOutcome | undefined }
  | { phase: 'connecting'; alias: string }
  | { phase: 'failed'; alias: string; message: string }

/** Full view snapshot the section renders. All members are JSON-compatible. */
export interface RemoteViewState {
  /** Registry mirror, in registry order. */
  entries: RemoteEntryView[]
  /** Last committed tunnel state per alias (remoteAdmin/status + tunnel-state events). */
  tunnels: Record<string, TunnelStateView>
  /** True when the remote plane refused the reads (LAN-served GUI): the group renders the managed-on-host hint instead of rows. */
  degraded: boolean
  /** Whether the group body is folded under the header. */
  folded: boolean
  /** Trust-modal state machine. */
  modal: RemoteModalState
  /** In-flight mutation flags keyed by {@link busyKey} (or the add-form key). */
  busy: Record<string, boolean>
}

/** The verbs that key a per-alias busy flag. */
export type BusyVerb = 'connect' | 'disconnect' | 'edit' | 'remove'

/**
 * Busy-flag key for one alias-scoped verb.
 * @param verb - the in-flight mutation.
 * @param alias - the registry alias the mutation targets.
 * @returns `{verb}:{alias}`.
 */
export const busyKey = (verb: BusyVerb, alias: string): string => `${verb}:${alias}`

/** Busy-flag key of the add form (there is no alias to scope it to yet). */
export const BUSY_ADD = 'add'

/** Strictness knobs of a granted connect, as decided in the trust modal. */
export interface ConnectDecision {
  /** Accept a daemon version other than this app's ("Connect anyway"). */
  allowVersionSkew: boolean
  /** Accept an installation id different from the recorded fingerprint (explicit re-trust). */
  forceFingerprint: boolean
}

/** Observable snapshot source the renderer binds into the section's selector hook. */
export type RemoteViewStore = {
  getSnapshot(): RemoteViewState
  subscribe(fn: () => void): () => void
  /** Replace the registry mirror wholesale (list read or add/edit upsert result). */
  setEntries(entries: readonly RemoteEntryView[]): void
  /** Reconcile one alias's tunnel to the given full-state view. */
  applyTunnel(view: TunnelStateView): void
  setDegraded(degraded: boolean): void
  setFolded(folded: boolean): void
  setModal(modal: RemoteModalState): void
  setBusy(key: string, busy: boolean): void
}

/**
 * Fresh snapshot: empty mirrors, unfolded, closed modal.
 * @returns a new state value.
 */
function freshState(): RemoteViewState {
  return { entries: [], tunnels: {}, degraded: false, folded: false, modal: { phase: 'closed' }, busy: {} }
}

/**
 * Create the view store handle. Apply calls this once and closes the instance
 * into its inject factories; component tests call it directly (the sanctioned
 * zero-machinery path).
 * @returns the store.
 */
export function createRemoteViewStore(): RemoteViewStore {
  const store = createSnapshotStore<RemoteViewState>(freshState())
  return {
    getSnapshot: () => store.getSnapshot(),
    subscribe: fn => store.subscribe(fn),
    setEntries: (entries) => { store.update((draft) => { draft.entries = [...entries] }) },
    applyTunnel: (view) => { store.update((draft) => { draft.tunnels[view.alias] = view }) },
    setDegraded: (degraded) => { store.update((draft) => { draft.degraded = degraded }) },
    setFolded: (folded) => { store.update((draft) => { draft.folded = folded }) },
    setModal: (modal) => { store.update((draft) => { draft.modal = modal }) },
    setBusy: (key, busy) => {
      store.update((draft) => {
        if (busy) draft.busy[key] = true
        else Reflect.deleteProperty(draft.busy, key)
      })
    },
  }
}

/** The add/edit form draft the section's inline form collects. */
export interface RemoteDraft {
  alias: string
  target: string
  /** Omitted when the form field is cleared; the gateway resolves it to the daemon default. */
  remotePort?: number
}

/** Result of the add/edit flow: the upserted entry, or the wire failure message. */
export type AddEditResult = { ok: true; entry: RemoteEntryView } | { ok: false; message: string }

/** Result of the remove flow: done, refused-while-connected, or the wire failure message. */
export type RemoveResult =
  | { ok: true; removed: boolean }
  | { ok: false; kind: 'connected' }
  | { ok: false; kind: 'error'; message: string }

/**
 * Insert or replace one entry in a registry-order mirror (upsert by alias).
 * @param entries - current mirror.
 * @param entry - the entry as it now reads in the registry.
 * @returns the next mirror.
 */
export function upsertEntry(entries: readonly RemoteEntryView[], entry: RemoteEntryView): readonly RemoteEntryView[] {
  const index = entries.findIndex(existing => existing.id === entry.id)
  if (index < 0) return [...entries, entry]
  return entries.map((existing, at) => (at === index ? entry : existing))
}

/**
 * Drop one alias from a registry-order mirror.
 * @param entries - current mirror.
 * @param alias - the alias that left the registry.
 * @returns the next mirror.
 */
export function dropEntry(entries: readonly RemoteEntryView[], alias: string): readonly RemoteEntryView[] {
  return entries.filter(existing => existing.id !== alias)
}
