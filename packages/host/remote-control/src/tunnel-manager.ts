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

/** One alias's live or last-known tunnel, process-private. */
interface TunnelRecord {
  /** Alias key. */
  id: RemoteId
  /** Resolved forward specification of the latest attempt. */
  spec: TunnelSpec
  /** Live handle while state is `open`; null while connecting or after exit. */
  tunnel: LiveTunnel | null
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
  connecting(id: RemoteId, spec: TunnelSpec): void {
    this.#records.set(id, { id, spec, tunnel: null, state: 'connecting', since: this.#now(), localPort: null, version: null, fingerprint: null, error: null })
    this.#publish(id)
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
    this.#records.set(id, {
      id,
      spec,
      tunnel,
      state: 'open',
      since: this.#now(),
      localPort: spec.localPort,
      version,
      fingerprint,
      error: null,
    })
    await writeFileAtomic(join(this.#options.runDir, `${id}.pid`), `${tunnel.pid}\n`, { mode: 0o600, dirMode: 0o700 })
    this.#publish(id)
  }

  /**
   * Commit a failed connect attempt with its display message and publish;
   * the controller already tore its handles down.
   * @param id - alias whose attempt failed.
   * @param spec - resolved specification of the attempt.
   * @param message - human-readable failure for the alias's row.
   */
  failed(id: RemoteId, spec: TunnelSpec, message: string): void {
    this.#records.set(id, { id, spec, tunnel: null, state: 'error', since: this.#now(), localPort: null, version: null, fingerprint: null, error: message })
    this.#publish(id)
  }

  /**
   * Observe the forward child's own exit: drop the handle, clear the PID
   * marker, and publish the closed state. A stale observation (unknown alias,
   * already replaced by another attempt, or a disposer-driven exit) is a no-op.
   * @param id - alias whose forward exited.
   * @param _exitCode - the child's exit code; the closed state carries no error.
   */
  async exited(id: RemoteId, _exitCode: number | null): Promise<void> {
    const record = this.#records.get(id)
    if (record === undefined || record.tunnel === null || record.state !== 'open') return
    record.tunnel = null
    record.state = 'closed'
    record.since = this.#now()
    await this.#removeMarker(id)
    this.#publish(id)
  }

  /**
   * Disconnect the alias's live tunnel: dispose the caller's own handles,
   * clear the PID marker, and publish the closed state.
   * @param id - alias to disconnect.
   * @returns true when a live handle existed and was disposed.
   */
  async disconnect(id: RemoteId): Promise<boolean> {
    const record = this.#records.get(id)
    if (record === undefined || record.tunnel === null) return false
    await record.tunnel.dispose()
    record.tunnel = null
    record.state = 'closed'
    record.since = this.#now()
    await this.#removeMarker(id)
    this.#publish(id)
    return true
  }

  /**
   * Whether the alias currently owns a verified-open tunnel.
   * @param id - alias to query.
   * @returns true while the alias's handle is live.
   */
  isLive(id: RemoteId): boolean {
    const record = this.#records.get(id)
    return record !== undefined && record.tunnel !== null
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
    const live = [...this.#records.values()].flatMap(record => record.tunnel === null ? [] : [{ record, tunnel: record.tunnel }])
    await Promise.all(live.map(async ({ record, tunnel }) => {
      await tunnel.dispose()
      record.tunnel = null
      record.state = 'closed'
      record.since = this.#now()
      await this.#removeMarker(record.id)
      this.#publish(record.id)
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

  /** Publish the alias's current view through the sink. */
  #publish(id: RemoteId): void {
    const record = this.#records.get(id)
    if (record !== undefined) this.#options.publish(this.#viewOf(record))
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
