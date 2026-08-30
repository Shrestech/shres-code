/**
 * Remote connect plugin, browser half. One registration: RemotesSection fills
 * the sidebar shell's `sidebar.remotes` hole (fold header, connected badge,
 * one row per registry alias, inline add form, trust modal, degraded hint).
 *
 * The apply closure owns the shared view store (createRemoteViewStore) and
 * feeds it from three channels: the initial remoteControl/remoteAdmin reads,
 * the forwarded `remote-control/tunnel-state` event, and the connection
 * reset resync. The inject face is plain callbacks over ctx.remote — the
 * gesture begin/spend pairs stay inside them, so components never see tokens.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { RemoteId, TunnelStateView } from '@shres-code/shres-code-api-remotes/client'
// Type-only: the generated Remote namespaces and the ctx.remote merge.
import type {} from '@shres-code/shres-code-api-remotes/client'
import type { ClientContext } from '@shres-code/shres-code-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@shres-code/shres-code-client-locale/client'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.remotes' hole).
import type {} from '@shres-code/shres-code-client-ui-sidebar/client'
import { createRemoteViewStore, dropEntry, upsertEntry } from './store.ts'
import type {
  AddEditResult, ConnectDecision, RemoteDraft, RemoveResult,
} from './store.ts'
import type { RemoteInspectView } from '@shres-code/shres-code-api-remotes/client'
import { RemotesSection, type RemoteInjected } from './RemotesSection.tsx'
import { en, type RemoteKey } from './locales.ts'

export type {
  AddEditResult, BusyVerb, ConnectDecision, RemoteDraft, RemoteModalState, RemoteViewState,
  RemoteViewStore, RemoveResult,
} from './store.ts'
export type { RemoteInjected, RemoteViewHooks, RemotesSectionProps } from './RemotesSection.tsx'
export type { RemoteKey } from './locales.ts'

declare module '@shres-code/shres-code-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The sidebar remote-host group's copy. */
    remote: RemoteKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'remote'

/** Services required by the sidebar registration and the two Remote namespaces. */
export const inject = ['slots', 'locale', 'remote', 'remote.remoteControl', 'remote.remoteAdmin']

/** Structural view of a generated Remote wire result (envelope ok/error). */
type WireResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/**
 * Unwrap one generated Remote call: the envelope's error becomes a thrown
 * Error carrying code and message (the Gateway's failure is message-only).
 * @param call - the in-flight call.
 * @returns the call's value.
 */
async function unwrap<T>(call: Promise<WireResult<T>>): Promise<T> {
  const result = await call
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

/** Human text of an unexpected flow failure. */
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register the remote group into the sidebar shell's declared hole.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-remote: dictionaries')

  const view = createRemoteViewStore()

  const listRemotes = async (): Promise<void> => {
    const result = await ctx.remote.remoteControl.list()
    if (!result.ok) {
      view.setEntries([])
      view.setDegraded(true)
      return
    }
    view.setDegraded(false)
    view.setEntries(result.value.entries)
  }

  const readStatus = async (): Promise<void> => {
    const result = await ctx.remote.remoteAdmin.status()
    if (!result.ok) {
      view.setDegraded(true)
      return
    }
    for (const tunnel of result.value.tunnels) view.applyTunnel(tunnel)
  }

  const connect = async (alias: string): Promise<void> => {
    view.setModal({ phase: 'inspecting', alias })
    const result = await ctx.remote.remoteAdmin.inspect({ alias })
    if (!result.ok) {
      view.setModal({ phase: 'failed', alias, message: result.error.message })
      return
    }
    view.setModal({ phase: 'confirm', alias, inspect: result.value })
  }

  const confirmConnect = async (alias: string, decision: ConnectDecision): Promise<void> => {
    // The confirm-phase body, captured before the phase flip: a decision
    // outcome re-enters confirm carrying the same inspect data.
    const previous = view.getSnapshot().modal
    view.setModal({ phase: 'connecting', alias })
    view.setBusy(`connect:${alias}`, true)
    try {
      const grant = await unwrap(ctx.remote.remoteAdmin.begin({ verb: 'connect', alias }))
      const outcome = await unwrap(ctx.remote.remoteAdmin.connect({
        token: grant.token,
        alias,
        allowVersionSkew: decision.allowVersionSkew,
        forceFingerprint: decision.forceFingerprint,
      }))
      if (outcome.status === 'connected') {
        // Same-tick badge: the authoritative mirror update still arrives as a
        // tunnel-state event; this only closes the gap before the push.
        view.applyTunnel({
          alias: alias as RemoteId,
          state: 'open',
          localPort: outcome.localPort,
          version: outcome.version,
          fingerprint: outcome.fingerprint,
          error: null,
          since: new Date().toISOString(),
        })
        window.open(`http://127.0.0.1:${String(outcome.localPort)}/`, '_blank', 'noopener')
        view.setModal({ phase: 'closed' })
        return
      }
      if (outcome.status === 'unreachable') {
        view.setModal({ phase: 'failed', alias, message: outcome.message })
        return
      }
      // Decision points re-enter confirm carrying the outcome, so the modal
      // can offer the explicit re-trust / connect-anyway the failure demands.
      let inspect: RemoteInspectView
      if (previous.phase === 'confirm') {
        inspect = previous.inspect
      } else {
        const again = await ctx.remote.remoteAdmin.inspect({ alias })
        if (!again.ok) {
          view.setModal({ phase: 'failed', alias, message: again.error.message })
          return
        }
        inspect = again.value
      }
      view.setModal({ phase: 'confirm', alias, inspect, outcome })
    } catch (error) {
      view.setModal({ phase: 'failed', alias, message: failureMessage(error) })
    } finally {
      view.setBusy(`connect:${alias}`, false)
    }
  }

  const disconnect = async (alias: string): Promise<void> => {
    view.setBusy(`disconnect:${alias}`, true)
    try {
      const grant = await unwrap(ctx.remote.remoteAdmin.begin({ verb: 'disconnect', alias }))
      const outcome = await unwrap(ctx.remote.remoteAdmin.disconnect({ token: grant.token, alias }))
      if (outcome.state === 'closed') {
        // Same-tick badge clear, as in confirmConnect; the event still rules.
        view.applyTunnel({
          alias: alias as RemoteId,
          state: 'closed',
          localPort: null,
          version: null,
          fingerprint: null,
          error: null,
          since: new Date().toISOString(),
        })
      }
    } catch (error) {
      view.setModal({ phase: 'failed', alias, message: failureMessage(error) })
    } finally {
      view.setBusy(`disconnect:${alias}`, false)
    }
  }

  const openTab = (localPort: number): void => {
    window.open(`http://127.0.0.1:${String(localPort)}/`, '_blank', 'noopener')
  }

  const addRemote = async (draft: RemoteDraft): Promise<AddEditResult> => {
    view.setBusy('add', true)
    try {
      const grant = await unwrap(ctx.remote.remoteAdmin.begin({ verb: 'add', alias: null }))
      const result = await ctx.remote.remoteAdmin.add({
        token: grant.token, alias: draft.alias, target: draft.target, remotePort: draft.remotePort,
      })
      if (!result.ok) return { ok: false, message: result.error.message }
      view.setEntries(upsertEntry(view.getSnapshot().entries, result.value.entry))
      return { ok: true, entry: result.value.entry }
    } catch (error) {
      return { ok: false, message: failureMessage(error) }
    } finally {
      view.setBusy('add', false)
    }
  }

  const editRemote = async (alias: string, draft: RemoteDraft): Promise<AddEditResult> => {
    view.setBusy(`edit:${alias}`, true)
    try {
      const grant = await unwrap(ctx.remote.remoteAdmin.begin({ verb: 'edit', alias }))
      const result = await ctx.remote.remoteAdmin.edit({
        token: grant.token, alias, target: draft.target, remotePort: draft.remotePort,
      })
      if (!result.ok) return { ok: false, message: result.error.message }
      view.setEntries(upsertEntry(view.getSnapshot().entries, result.value.entry))
      return { ok: true, entry: result.value.entry }
    } catch (error) {
      return { ok: false, message: failureMessage(error) }
    } finally {
      view.setBusy(`edit:${alias}`, false)
    }
  }

  const removeRemote = async (alias: string): Promise<RemoveResult> => {
    view.setBusy(`remove:${alias}`, true)
    try {
      const grant = await unwrap(ctx.remote.remoteAdmin.begin({ verb: 'removeEntry', alias }))
      const outcome = await unwrap(ctx.remote.remoteAdmin.removeEntry({ token: grant.token, alias }))
      if (outcome.status !== 'removed') return { ok: false, kind: 'connected' }
      view.setEntries(dropEntry(view.getSnapshot().entries, alias))
      return { ok: true, removed: outcome.removed }
    } catch (error) {
      return { ok: false, kind: 'error', message: failureMessage(error) }
    } finally {
      view.setBusy(`remove:${alias}`, false)
    }
  }

  const injected = (): RemoteInjected => ({
    hooks: { view },
    connect,
    confirmConnect,
    cancelModal: () => { view.setModal({ phase: 'closed' }) },
    disconnect,
    openTab,
    addRemote,
    editRemote,
    removeRemote,
    setFolded: (folded) => { view.setFolded(folded) },
  })

  // A committed transition reconciles the mirror; an open also re-reads the
  // registry, because a verified connect stamps lastConnectedAt/fingerprint.
  ctx.effect(
    () => ctx.remote.$on('remote-control/tunnel-state', (tunnel: TunnelStateView) => {
      view.applyTunnel(tunnel)
      if (tunnel.state === 'open') void listRemotes()
    }),
    'ui-remote: tunnel-state subscription',
  )
  // A reconnect rebuilds the whole client face: re-read both mirrors.
  ctx.effect(
    () => ctx.on('connection/reset', () => {
      void listRemotes()
      void readStatus()
    }),
    'ui-remote: reconnect resync',
  )

  ctx.slots.inject('sidebar.remotes', () => ctx.slots.register({
    name: 'sidebar.remotes',
    inject: injected,
    locale: NS,
  }, RemotesSection))

  void listRemotes()
  void readStatus()
}
