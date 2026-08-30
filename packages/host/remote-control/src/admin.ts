/**
 * The remoteAdmin Remote namespace: the ONLY mutating surface of the remote
 * registry and tunnels, gated by one-shot gesture tokens, and the owner of
 * every tunnel this webapp process opens. It rides the same registry file
 * (and the same locked read-modify-write) as the CLI, and answers decision
 * points as discriminated-outcome data because the Gateway's wire failure is
 * message-only and cannot carry a Connect-anyway decision.
 * @module @shres-code/shres-code-host-remote-control/admin
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Service } from '@shres-code/cordis'
import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { TypertRemoteService, Remote } from '@shres-code/shres-code-typert-protocol'
import { openTunnel, probeDaemonVersion, readInstallationId, type SshRunner } from './controller.ts'
import { RemoteControlError } from './errors.ts'
import { GestureLedger } from './gesture.ts'
import { resolveRegistryPath, resolveRunDir } from './home.ts'
import { nodeSshRunner } from './node-runner.ts'
import { allocateLoopbackPort } from './port.ts'
import { asRemoteId, asRemotePort, asRemoteTarget, loadRegistry, REGISTRY_VERSION, remoteEntryView, removeEntry, upsertEntry } from './registry.ts'
import { TunnelManager } from './tunnel-manager.ts'
import type { RemoteEntry } from './types.ts'
import type {
  AdminBeginRequest, AdminConnectRequest, AdminDisconnectRequest, AdminEntryRequest, AdminEntryResult,
  AdminGestureVerb, AdminInspectRequest, AdminRemoveRequest, AdminStatusResult, ConnectOutcome,
  DisconnectOutcome, GestureGrant, RemoteInspectView, RemoveOutcome, TunnelSpec,
} from './types.ts'

export type {
  AdminBeginRequest, AdminConnectRequest, AdminDisconnectRequest, AdminEntryRequest, AdminEntryResult,
  AdminGestureVerb, AdminInspectRequest, AdminRemoveRequest, AdminStatusResult, ConnectOutcome,
  DisconnectOutcome, GestureGrant, RemoteEntryView, RemoteInspectView, RemoveOutcome, TunnelStateView,
} from './types.ts'

/**
 * Deployment-varying choices of the admin surface. Every field is optional;
 * the constructor resolves defaults through the owning resolvers so an
 * overlay (or a test) can pin the registry, run directory, and ssh binary.
 */
export interface AdminConfig {
  /** Registry file override; defaults to the harness home's remote/remotes.json. */
  registryPath?: string
  /** Run-directory override (ControlMaster sockets, PID markers); defaults to the harness home's remote/run. */
  runDir?: string
  /** ssh binary or wrapper to execute; defaults to plain `ssh`. Doubles as the hermetic test seam. */
  sshCommand?: string
}

/** Loader validation for {@link AdminConfig}. */
export const Config: z<AdminConfig> = z.object({
  registryPath: z.string(),
  runDir: z.string(),
  sshCommand: z.string(),
})

/**
 * Read this controller's own manifest version — the local side of the skew
 * check. The workspace pins every app's manifest to the same version, so the
 * package manifest answers for the running build. The candidates cover every
 * face this module runs in: the `./admin` row's lib/types artifact sits two
 * levels under the package root, the src/test face and the bundled lib face
 * sit one.
 * @returns the version string.
 */
function readControllerVersion(): string {
  for (const candidate of ['../../package.json', '../package.json'] as const) {
    try {
      return (createRequire(import.meta.url)(candidate) as { version: string }).version
    } catch {
      // A candidate depth without a readable manifest: try the next face depth.
    }
  }
  // Both depths missing means the module runs outside any manifest-bearing tree.
  /* v8 ignore next 2 -- fail loud instead of answering a wrong version to the skew check. */
  throw new Error('remote-control package manifest not found beside the running module')
}

/** ISO timestamp of the current instant. */
function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Serve the mutating remote surface as the `remoteAdmin` Remote namespace.
 * The gesture gate lives HERE, in the operations that spend it: scope
 * validation needs the business verb/alias semantics the apiproxy carrier
 * must not learn. The carrier keeps only the reachability class it already
 * owns — every method of this namespace is loopback-pinned through
 * PRIVILEGED_METHODS. Model tools stay rejected forever: this namespace adds
 * no tools and no session events.
 */
export class RemoteAdminGateway extends TypertRemoteService {
  static inject = []

  /** Loader validation for the admin configuration. */
  static Config: z<AdminConfig> = Config

  private readonly registryPath: string
  private readonly runDir: string
  private readonly localVersion: string
  private readonly runner: SshRunner
  private readonly gestures = new GestureLedger()
  private readonly tunnels: TunnelManager

  /**
   * @param ctx - Host context carrying the cordis event bus.
   * @param config - deployment overrides; every field optional.
   * @param runner - process-seam injection point; production builds the node
   *   adapter over the configured ssh command, tests fabricate the runner.
   */
  constructor(ctx: Context, config?: AdminConfig, runner?: SshRunner) {
    super(ctx, 'remoteAdmin')
    this.registryPath = resolveRegistryPath(config?.registryPath)
    this.runDir = resolveRunDir(config?.runDir)
    this.runner = runner ?? nodeSshRunner(config?.sshCommand ?? 'ssh')
    this.localVersion = readControllerVersion()
    this.tunnels = new TunnelManager({
      runDir: this.runDir,
      publish: (view) => { this.ctx.emit('remote-control/tunnel-state', view) },
    })
  }

  /** The gateway owns its tunnels' lifetime: unmounting ends them. */
  protected [Service.init](): void {
    this.ctx.effect(() => () => this.tunnels.disposeAll(), 'remote-admin.tunnelTeardown')
  }

  /**
   * Mint one one-shot gesture grant bound to the (verb, alias) mutation.
   * @param request - the gesture to authorize.
   * @returns the token and its deadline.
   */
  @Remote('begin')
  begin(request: AdminBeginRequest): GestureGrant {
    if (request.alias === null && request.verb !== 'add') {
      throw new RemoteControlError('gesture-refused', `verb "${request.verb}" needs an alias to act on`)
    }
    if (request.verb === 'add' && request.alias !== null) {
      throw new RemoteControlError('gesture-refused', 'add authorizes a not-yet-existing alias; pass alias null')
    }
    const minted = this.gestures.mint(request.verb, request.alias, Date.now())
    return { token: minted.token, expiresAt: new Date(minted.expiresAt).toISOString() }
  }

  /**
   * Observe one alias for the trust modal: one-shot describe probe plus
   * installation-id read. A read, but loopback-pinned because it fires ssh.
   * @param request - the alias to observe.
   * @returns the trust-modal facts; daemonVersion null means unreachable.
   */
  @Remote('inspect')
  async inspect(request: AdminInspectRequest): Promise<RemoteInspectView> {
    const entry = await this.entry(request.alias)
    const daemonVersion = await probeDaemonVersion(this.runner, entry.target, entry.remotePort)
    const installationId = await readInstallationId(this.runner, entry.target)
    return {
      target: entry.target,
      daemonVersion,
      installationId,
      localVersion: this.localVersion,
      firstConnect: entry.fingerprint === null,
      trustedFingerprint: entry.fingerprint,
    }
  }

  /**
   * Open the alias's tunnel through the CLI's probe → forward → verify →
   * fingerprint chain, record the verified identity, and own the handle.
   * Every expected verification failure answers as outcome data.
   * @param request - the granted connect with its strictness knobs.
   * @returns the connect outcome the trust modal branches on.
   */
  @Remote('connect')
  async connect(request: AdminConnectRequest): Promise<ConnectOutcome> {
    this.requireGesture(request.token, 'connect', request.alias)
    const entry = await this.entry(request.alias)
    const live = this.tunnels.view(entry.id)
    if (live !== null && live.state === 'open' && live.localPort !== null && live.version !== null && live.fingerprint !== null) {
      // One alias carries one GUI tunnel: another granted connect reports the
      // live one instead of stacking a second forward beside it.
      return { status: 'connected', localPort: live.localPort, version: live.version, fingerprint: live.fingerprint }
    }
    const spec = await this.spec(entry)
    this.tunnels.connecting(entry.id, spec)
    try {
      const tunnel = await openTunnel(this.runner, spec, entry, {
        allowVersionSkew: request.allowVersionSkew,
        localVersion: this.localVersion,
        forceFingerprint: request.forceFingerprint,
        onForwardExit: (exitCode) => { void this.tunnels.exited(entry.id, exitCode) },
      })
      await upsertEntry(this.registryPath, { ...entry, fingerprint: tunnel.fingerprint, lastConnectedAt: nowIso() })
      await this.tunnels.opened(entry.id, spec, tunnel, tunnel.version, tunnel.fingerprint)
      return { status: 'connected', localPort: spec.localPort, version: tunnel.version, fingerprint: tunnel.fingerprint }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.tunnels.failed(entry.id, spec, message)
      if (!(error instanceof RemoteControlError)) throw error
      switch (error.code) {
        case 'version-mismatch':
          return { status: 'version-mismatch', observed: error.facts['observed'] ?? null, local: this.localVersion }
        case 'fingerprint-mismatch':
          return { status: 'fingerprint-mismatch', observed: error.facts['observed'] ?? null, trusted: entry.fingerprint }
        case 'probe-failed':
          return { status: 'unreachable', stage: 'probe', message: error.message }
        case 'tunnel-failed':
          return { status: 'unreachable', stage: 'tunnel', message: error.message }
        // Caller misuse (unknown alias, bad input) and future codes stay wire
        // errors: the Gateway renders their message, and there is no connect
        // decision to carry.
        default: throw error
      }
    }
  }

  /**
   * Disconnect the alias's live tunnel.
   * @param request - the granted disconnect.
   * @returns the display outcome; a not-connected alias is data, not an error.
   */
  @Remote('disconnect')
  async disconnect(request: AdminDisconnectRequest): Promise<DisconnectOutcome> {
    this.requireGesture(request.token, 'disconnect', request.alias)
    const closed = await this.tunnels.disconnect(asRemoteId(request.alias))
    return { state: closed ? 'closed' : 'not-connected' }
  }

  /**
   * Insert one alias into the registry (fingerprint starts empty; the first
   * verified connect binds it).
   * @param request - the granted add with the new entry's fields.
   * @returns the entry as it now reads.
   */
  @Remote('add')
  async add(request: AdminEntryRequest): Promise<AdminEntryResult> {
    this.requireGesture(request.token, 'add', null)
    const entry: RemoteEntry = {
      id: asRemoteId(request.alias),
      target: asRemoteTarget(request.target),
      remotePort: asRemotePort(request.remotePort),
      version: REGISTRY_VERSION,
      fingerprint: null,
      createdAt: nowIso(),
      lastConnectedAt: null,
    }
    await upsertEntry(this.registryPath, entry)
    return { entry: remoteEntryView(entry) }
  }

  /**
   * Rewrite one alias's target or port, preserving the bound fingerprint and
   * connect history.
   * @param request - the granted edit with the rewritten fields.
   * @returns the entry as it now reads.
   */
  @Remote('edit')
  async edit(request: AdminEntryRequest): Promise<AdminEntryResult> {
    this.requireGesture(request.token, 'edit', request.alias)
    const current = await this.entry(request.alias)
    const entry: RemoteEntry = {
      ...current,
      target: asRemoteTarget(request.target),
      remotePort: asRemotePort(request.remotePort),
    }
    await upsertEntry(this.registryPath, entry)
    return { entry: remoteEntryView(entry) }
  }

  /**
   * Remove one alias; refused with outcome data while its tunnel is live so
   * the UI disconnects first.
   * @param request - the granted remove.
   * @returns the removal outcome.
   */
  @Remote('remove')
  async remove(request: AdminRemoveRequest): Promise<RemoveOutcome> {
    this.requireGesture(request.token, 'remove', request.alias)
    const id = asRemoteId(request.alias)
    if (this.tunnels.isLive(id)) return { status: 'connected' }
    return { status: 'removed', removed: await removeEntry(this.registryPath, id) }
  }

  /**
   * The full tunnel-state picture for a fresh page load (the push channel is
   * the forwarded tunnel-state event).
   * @returns every tracked alias's view.
   */
  @Remote('status')
  status(): AdminStatusResult {
    return { tunnels: this.tunnels.views() }
  }

  /** Spend one gesture or refuse the mutation loudly. */
  private requireGesture(token: string, verb: AdminGestureVerb, alias: string | null): void {
    if (!this.gestures.consume(token, verb, alias, Date.now())) {
      throw new RemoteControlError('gesture-refused', `no unspent gesture token for ${verb} on "${alias ?? '<new alias>'}"; call remoteAdmin/begin first`)
    }
  }

  /** Load one registry entry, refusing unknown aliases as a caller error. */
  private async entry(alias: string): Promise<RemoteEntry> {
    const entries = await loadRegistry(this.registryPath)
    const entry = entries.get(asRemoteId(alias))
    if (entry === undefined) {
      throw new RemoteControlError('unknown-alias', `remote "${alias}" is not registered; add it first`)
    }
    return entry
  }

  /** Resolve the alias's forward specification: loopback port plus run-dir socket. */
  private async spec(entry: RemoteEntry): Promise<TunnelSpec> {
    const localPort = await allocateLoopbackPort()
    return {
      id: entry.id,
      target: entry.target,
      remotePort: entry.remotePort,
      localPort,
      controlPath: join(this.runDir, `${entry.id}.sock`),
    }
  }
}

export default RemoteAdminGateway
