/**
 * In-memory authority over the tunnels the local webapp process opened: one
 * record per alias, a PID marker under the run directory per open forward,
 * and a full-state publication on every committed transition. The durable
 * registry file stays write-through-only (fingerprint, lastConnectedAt);
 * this manager is the sole owner of liveness, and a daemon restart honestly
 * shows every tunnel closed until cross-process PID adoption exists.
 * @module @shres-code/shres-code-host-remote-control/tunnel-manager
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@shres-code/shres-code-atomic-write'
import type { LiveTunnel } from './controller.ts'
import type { RemoteId, TunnelSpec, TunnelStateView } from './types.ts'

/** Construction dependencies of the tunnel manager. */
export interface TunnelManagerOptions {
  /** Run directory receiving the per-alias PID markers. */
  runDir: string
  /** Publication sink for committed tunnel-state views (the cordis event). */
  publish: (view: TunnelStateView) => void
}

/** The facts and the live handle that exist exactly while a tunnel is open. */
interface OpenTunnel {
  /** Live handle owned since the verified open. */
  tunnel: LiveTunnel
  /** Local loopback port bound at open. */
  localPort: number
  /** Daemon version observed at open time. */
  version: string
  /** Installation id observed at open time. */
  fingerprint: string
}

/** One alias's live or last-known tunnel, process-private. */
interface TunnelRecord {
  /** Alias key. */
  id: RemoteId
  /** Resolved forward specification of the latest attempt. */
  spec: TunnelSpec
  /** Present exactly while state is `open`. */
  open: OpenTunnel | null
  /** Display state after the last committed transition. */
  state: TunnelStateView['state']
  /** ISO timestamp of the last committed transition. */
  since: string
  /** Local port bound by the verified open; retained on closed for display. */
  localPort: number | null
  /** Daemon version observed at open time. */
  version: string | null
  /** Installation id observed at open time. */
  fingerprint: string | null
  /** Human-readable failure for state `error`; null otherwise. */
  error: string | null
}

/** Tunnel liveness owner for the remoteAdmin gateway. */
export class TunnelManager {
  readonly #options: TunnelManagerOptions
  readonly #records = new Map<RemoteId, TunnelRecord>()

  /** @param options - run directory and publication sink. */
  constructor(options: TunnelManagerOptions) {
    this.#options = options
  }

  /**
   * Commit a connect attempt: the alias is dialing, no handle exists yet.
   * @param id - alias being connected.
   * @param spec - resolved specification of the attempt.
   */
  async connecting(id: RemoteId, spec: TunnelSpec): Promise<void> {
    // A dialing attempt displaces an open record just like a second open
    // would; the orphaned handle must be disposed or its forward keeps the
    // ControlMaster alive past ControlPersist.
    const displaced = this.#records.get(id)?.open ?? null
    if (displaced !== null) await displaced.tunnel.dispose()
    const record: TunnelRecord = { id, spec, open: null, state: 'connecting', since: this.#now(), localPort: null, version: null, fingerprint: null, error: null }
    this.#records.set(id, record)
    this.#publish(record)
  }

  /**
   * Commit a verified open: attach the live handle, write the alias's PID
   * marker, and publish. Only called after the controller's probe → forward →
   * verify chain succeeded.
   * @param id - alias connected.
   * @param spec - resolved specification that opened.
   * @param tunnel - the live handle this manager now owns.
   * @param version - daemon version observed at open time.
   * @param fingerprint - installation id observed at open time.
   */
  async opened(id: RemoteId, spec: TunnelSpec, tunnel: LiveTunnel, version: string, fingerprint: string): Promise<void> {
    // A concurrent granted connect can commit while this attempt dialed; the
    // displaced handle must be disposed or its forward keeps the ControlMaster
    // alive past ControlPersist.
    const displaced = this.#records.get(id)?.open ?? null
    if (displaced !== null) await displaced.tunnel.dispose()
    const record: TunnelRecord = {
      id,
      spec,
      open: { tunnel, localPort: spec.localPort, version, fingerprint },
      state: 'open',
      since: this.#now(),
      localPort: spec.localPort,
      version,
      fingerprint,
      error: null,
    }
    this.#records.set(id, record)
    await writeFileAtomic(join(this.#options.runDir, `${id}.pid`), `${tunnel.pid}\n`, { mode: 0o600, dirMode: 0o700 })
    this.#publish(record)
  }

  /**
   * Commit a failed connect attempt with its display message and publish;
   * the controller already tore its handles down.
   * @param id - alias whose attempt failed.
   * @param spec - resolved specification of the attempt.
   * @param message - human-readable failure for the alias's row.
   */
  failed(id: RemoteId, spec: TunnelSpec, message: string): void {
    const record: TunnelRecord = { id, spec, open: null, state: 'error', since: this.#now(), localPort: null, version: null, fingerprint: null, error: message }
    this.#records.set(id, record)
    this.#publish(record)
  }

  /**
   * Observe the forward child's own exit: drop the handle, clear the PID
   * marker, and publish the closed state. The attempt identity makes stale
   * observations no-ops: unknown alias, an alias already dialing again, a
   * handle displaced by a later open, or a disposer-driven exit after
   * disconnect already committed the closed state.
   * @param id - alias whose forward exited.
   * @param spec - the attempt's resolved specification (identity of the exit).
   * @param _exitCode - the child's exit code; the closed state carries no error.
   */
  async exited(id: RemoteId, spec: TunnelSpec, _exitCode: number | null): Promise<void> {
    const record = this.#records.get(id)
    const open = record?.open ?? null
    if (record === undefined || open === null || record.spec !== spec) return
    record.open = null
    record.state = 'closed'
    record.since = this.#now()
    await this.#removeMarker(id)
    this.#publish(record)
  }

  /**
   * Disconnect the alias's live tunnel: dispose the caller's own handles,
   * clear the PID marker, and publish the closed state.
   * @param id - alias to disconnect.
   * @returns true when a live handle existed and was disposed.
   */
  async disconnect(id: RemoteId): Promise<boolean> {
    const record = this.#records.get(id)
    const open = record?.open ?? null
    if (record === undefined || open === null) return false
    // Clear the record before disposing: the disposer-driven exit observation
    // must see a committed closed state and no-op, keeping one event per
    // committed transition.
    record.open = null
    record.state = 'closed'
    record.since = this.#now()
    await open.tunnel.dispose()
    await this.#removeMarker(id)
    this.#publish(record)
    return true
  }

  /**
   * Whether the alias currently owns a verified-open tunnel.
   * @param id - alias to query.
   * @returns true while the alias's handle is live.
   */
  isLive(id: RemoteId): boolean {
    return (this.#records.get(id)?.open ?? null) !== null
  }

  /**
   * The connected-outcome facts of the alias's verified-open tunnel.
   * @param id - alias to query.
   * @returns the facts, or null when no verified-open tunnel exists.
   */
  openOutcome(id: RemoteId): { localPort: number; version: string; fingerprint: string } | null {
    const open = this.#records.get(id)?.open ?? null
    return open === null ? null : { localPort: open.localPort, version: open.version, fingerprint: open.fingerprint }
  }

  /**
   * The alias's current full-state view.
   * @param id - alias to project.
   * @returns the view, or null when this process never touched the alias.
   */
  view(id: RemoteId): TunnelStateView | null {
    const record = this.#records.get(id)
    return record === undefined ? null : this.#viewOf(record)
  }

  /**
   * Every tracked alias's current view, in tracking order.
   * @returns the full-state views.
   */
  views(): TunnelStateView[] {
    return [...this.#records.values()].map(record => this.#viewOf(record))
  }

  /**
   * Dispose every live handle and clear the PID markers (plugin teardown).
   * The webapp process owns its tunnels: unloading the gateway ends them, and
   * the closed states are published like any other committed transition.
   */
  async disposeAll(): Promise<void> {
    const live = [...this.#records.values()].flatMap(record => record.open === null ? [] : [{ record, open: record.open }])
    await Promise.all(live.map(async ({ record, open }) => {
      await open.tunnel.dispose()
      record.open = null
      record.state = 'closed'
      record.since = this.#now()
      await this.#removeMarker(record.id)
      this.#publish(record)
    }))
  }

  /** Project one record into its wire view. */
  #viewOf(record: TunnelRecord): TunnelStateView {
    return {
      alias: record.id,
      state: record.state,
      localPort: record.localPort,
      version: record.version,
      fingerprint: record.fingerprint,
      error: record.error,
      since: record.since,
    }
  }

  /** Publish the record's current view through the sink. */
  #publish(record: TunnelRecord): void {
    this.#options.publish(this.#viewOf(record))
  }

  /** Remove the alias's PID marker; absence is the expected post-exit state. */
  async #removeMarker(id: RemoteId): Promise<void> {
    await rm(join(this.#options.runDir, `${id}.pid`), { force: true })
  }

  /** The current wall-clock instant as ISO 8601. */
  #now(): string {
    return new Date().toISOString()
  }
}
