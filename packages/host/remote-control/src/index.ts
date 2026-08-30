/**
 * Remote-control entry points: the pure CLI command implementations, the
 * controller core, and the read-only Remote gateway face. The CLI and
 * controller core stand alone so `shres remote` never boots a profile; the
 * gateway mounts only through its composition row.
 * @module @shres-code/shres-code-host-remote-control
 */

import RemoteControlGateway from './gateway.ts'

// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'

export { RemoteControlError } from './errors.ts'
export { resolveRegistryPath, resolveRunDir } from './home.ts'
export { RemoteControlGateway } from './gateway.ts'
export default RemoteControlGateway
export { loadRegistry, upsertEntry, removeEntry, asRemoteId, asRemoteTarget, asRemotePort, REGISTRY_VERSION } from './registry.ts'
export { nodeSshRunner } from './node-runner.ts'
export type { LiveTunnel, OpenTunnelOptions, SshRunner, SshResult } from './controller.ts'
export { openTunnel, probeDaemonVersion, readInstallationId } from './controller.ts'
export { allocateLoopbackPort } from './port.ts'
export { installationIdCommand, masterArgv, parseProbeVersion, probeCommand, tunnelArgv } from './ssh-args.ts'
export type { RemoteControlErrorCode, RemoteCliCommand, RemoteEntry, RemoteId, RemoteTarget, TunnelSpec } from './types.ts'
