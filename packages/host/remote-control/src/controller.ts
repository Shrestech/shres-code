/**
 * The remote controller: process orchestration over an injectable ssh runner
 * so every path is testable with fabricated output. PR1 owns the tunnel path
 * only — probe, forward, verify, install-fingerprint check; the daemon
 * ensure-running flow is PR2 and composes over these primitives.
 * @module @shres-code/shres-code-host-remote-control
 */

import type { RemoteEntry, TunnelSpec } from './types.ts'
import { RemoteControlError } from './errors.ts'
import { installationIdCommand, masterArgv, parseProbeVersion, probeCommand, tunnelArgv } from './ssh-args.ts'

/** Bounded probe loop: attempts before declaring the remote daemon absent. */
const PROBE_ATTEMPTS = 5
/** Delay between describe probes; short, since the master window already amortizes connection cost. */
const PROBE_RETRY_DELAY_MS = 250

/** One completed short ssh execution; nonzero exits and stderr are data. */
export interface SshResult {
  /** Process exit code. */
  exitCode: number
  /** Captured stdout (utf8). */
  stdout: string
  /** Captured stderr (utf8). */
  stderr: string
}

/**
 * Runner seam separating controller logic from process creation: tests inject
 * fabrications, the CLI passes a node adapter.
 */
export interface SshRunner {
  /**
   * Run one short ssh exec to completion.
   * @param args - full argv (including `ssh`).
   * @returns captured result.
   */
  run(args: readonly string[]): Promise<SshResult>
  /**
   * Spawn one long-lived ssh (master or forward) that outlives the call.
   * @param args - full argv (including `ssh`).
   * @returns child pid and a disposer killing the process tree.
   */
  spawn(args: readonly string[]): Promise<{ pid: number; dispose(): Promise<void> }>
}

/**
 * Probe the remote daemon over one ssh exec.
 * @param runner - process seam.
 * @param target - validated connect target.
 * @param remotePort - remote daemon loopback port.
 * @returns the daemon version, or null when the probe found nothing to parse.
 */
export async function probeDaemonVersion(
  runner: SshRunner,
  target: string,
  remotePort: number,
  controlPath?: string,
): Promise<string | null> {
  const forwardArgs = controlPath === undefined ? [] : ['-o', `ControlPath=${controlPath}`]
  const result = await runner.run(['ssh', ...forwardArgs, target, probeCommand(remotePort)])
  return parseProbeVersion(result.stdout)
}

/**
 * Read the remote installation id over one ssh exec; empty output maps to
 * null (first connect or missing file).
 * @param runner - process seam.
 * @param target - validated connect target.
 * @returns the installation id or null.
 */
export async function readInstallationId(runner: SshRunner, target: string, controlPath?: string): Promise<string | null> {
  const forwardArgs = controlPath === undefined ? [] : ['-o', `ControlPath=${controlPath}`]
  const result = await runner.run(['ssh', ...forwardArgs, target, installationIdCommand()])
  const id = result.stdout.trim()
  return id.length > 0 ? id : null
}

/** Knobs controlling how strictly {@link openTunnel} verifies the remote. */
export interface OpenTunnelOptions {
  /** Accept a daemon version other than the local one; the caller owes the warning output. */
  allowVersionSkew: boolean
  /** Local controller version compared against the daemon's describe. */
  localVersion: string
  /** Accept an installation id different from the recorded fingerprint. */
  forceFingerprint: boolean
}

/** Live tunnel handle and the daemon facts observed at open time. */
export interface LiveTunnel {
  /** Forward child pid (informational; `dispose` owns the kill). */
  pid: number
  /** Daemon version observed remotely before the forward opened. */
  version: string
  /** Installation id observed on the remote. */
  fingerprint: string
  /** Kill the forward and the master window; resolves even when one handle already exited. */
  dispose(): Promise<void>
}

/**
 * Open the alias's ControlMaster, probe the daemon, spawn the forward, verify
 * through the tunnel, and check the installation fingerprint on record. Any
 * failure after the master opened shuts the master window again; the
 * long-lived handles only survive on success.
 * @param runner - process seam.
 * @param spec - resolved tunnel specification (localPort already allocated).
 * @param entry - registry entry carrying the expected fingerprint.
 * @param options - verification knobs for the caller's strictness posture.
 * @returns the live tunnel to the caller, which owns the handle's lifetime.
 */
export async function openTunnel(runner: SshRunner, spec: TunnelSpec, entry: RemoteEntry, options: OpenTunnelOptions): Promise<LiveTunnel> {
  const master = await runner.spawn(masterArgv(spec))
  const forward = { dispose: (): Promise<void> => Promise.resolve(), pid: 0 }
  try {
    const version = await waitForVersion(runner, spec)
    if (!options.allowVersionSkew && version !== options.localVersion) {
      throw new RemoteControlError('version-mismatch', `remote daemon version ${version} does not match this controller ${options.localVersion}; upgrade the remote install or pass --allow-version-skew`)
    }
    const spawnedForward = await runner.spawn(tunnelArgv(spec))
    forward.pid = spawnedForward.pid
    forward.dispose = async () => spawnedForward.dispose()
    const throughVersion = await probeThroughTunnel(spec.localPort)
    if (throughVersion === null) {
      throw new RemoteControlError('tunnel-failed', `forward to 127.0.0.1:${String(spec.localPort)} did not answer host.describe; refusing to report connected`)
    }
    const fingerprint = await readInstallationId(runner, spec.target, spec.controlPath)
    if (fingerprint === null) {
      throw new RemoteControlError('fingerprint-mismatch', `remote returned no installation id; cannot bind alias ${spec.id} to an installation`)
    }
    if (entry.fingerprint !== null && entry.fingerprint !== fingerprint && !options.forceFingerprint) {
      throw new RemoteControlError('fingerprint-mismatch', `installation id changed for alias ${spec.id}: expected ${entry.fingerprint}, observed ${fingerprint}; pass --force-fingerprint if the host was reinstalled`)
    }
    return {
      pid: forward.pid,
      version,
      fingerprint,
      dispose: async () => { await Promise.allSettled([spawnedForward.dispose(), master.dispose()]) },
    }
  } catch (error) {
    // Tear-down is failure-isolated: one stuck handle must not leak the other.
    await Promise.allSettled([forward.dispose(), master.dispose()])
    throw error
  }
}


/**
 * Wait until the remote daemon answers (bounded), surfacing a typed failure
 * naming the deepest reached stage. PR2's ensure-running slots in here when
 * the probe stays silent.
 * @param runner - process seam.
 * @param spec - tunnel specification (target + remotePort).
 * @returns the observed daemon version.
 */
async function waitForVersion(runner: SshRunner, spec: TunnelSpec): Promise<string> {
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
    const version = await probeDaemonVersion(runner, spec.target, spec.remotePort, spec.controlPath)
    if (version !== null) return version
    await new Promise(resolveDelay => setTimeout(resolveDelay, PROBE_RETRY_DELAY_MS))
  }
  throw new RemoteControlError('probe-failed', `no host.describe answered on 127.0.0.1:${String(spec.remotePort)} on the remote; start the daemon first or pass the right --port`)
}

/**
 * Verify the forward end-to-end: a local HTTP probe through the tunnel must
 * answer `host.describe` before the controller reports connected.
 * @param localPort - allocated local tunnel port.
 * @returns the version seen through the tunnel, or null.
 */
async function probeThroughTunnel(localPort: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(localPort)}/api/host.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'remote-connect-verify', method: 'host.describe', payload: {} }),
      signal: AbortSignal.timeout(2000),
    })
    const body: unknown = await response.json()
    const value = (body as { result?: { value?: { version?: unknown } } }).result?.value
    const version: unknown = (value as { version?: unknown } | null | undefined)?.version
    return typeof version === 'string' && version.length > 0 ? version : null
  } catch {
    // Tunnel absent, refused, or slow: reported as no-answer, ownership of the reason stays with the caller's status output.
    return null
  }
}
