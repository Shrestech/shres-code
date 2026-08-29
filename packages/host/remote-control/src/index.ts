/**
 * Remote-control entry points: the pure CLI command implementations and the
 * package's deferred-plugin exports. The Cordis service face mounts together
 * with its composition row in a later PR; the CLI and controller core stand
 * alone so `shres remote` never boots a profile.
 * @module @shres-code/shres-code-host-remote-control
 */

import { shresHomePath } from '@shres-code/shres-code-home-paths'
import { resolve } from 'node:path'
import { asRemoteId } from './registry.ts'
import type { RemoteId } from './types.ts'

export { RemoteControlError } from './errors.ts'
export { loadRegistry, saveRegistry, upsertEntry, removeEntry, asRemoteId, asRemoteTarget, asRemotePort, REGISTRY_VERSION } from './registry.ts'
export type { LiveTunnel, OpenTunnelOptions, SshRunner, SshResult } from './controller.ts'
export { openTunnel, probeDaemonVersion, readInstallationId } from './controller.ts'
export { allocateLoopbackPort } from './port.ts'
export { installationIdCommand, masterArgv, parseProbeVersion, probeCommand, tunnelArgv } from './ssh-args.ts'
export type { RemoteControlErrorCode, RemoteCliCommand, RemoteEntry, RemoteId, RemoteTarget, TunnelSpec } from './types.ts'

/**
 * Resolve the registry path: explicit override wins, else the harness home's
 * `remote/remotes.json`.
 * @param configured - caller-supplied override (tests, isolated homes).
 * @returns absolute registry file path.
 */
export function resolveRegistryPath(configured?: string): string {
  return configured ?? shresHomePath('remote', 'remotes.json')
}

/**
 * Resolve the run directory holding ControlMaster sockets and PID markers.
 * @param configured - caller-supplied override (tests, isolated homes).
 * @returns absolute run directory path.
 */
export function resolveRunDir(configured?: string): string {
  return configured ?? shresHomePath('remote', 'run')
}

/**
 * Brand an alias from CLI input, shared by every subcommand.
 * @param alias - raw alias string.
 * @returns the branded remote id.
 */
export function parseAlias(alias: string): RemoteId {
  return asRemoteId(alias)
}

/** PID marker file for one live tunnel, used by `remove`-time liveness checks. */
export function pidMarkerPath(runDir: string, id: RemoteId): string {
  return resolve(runDir, `${id}.pid`)
}
