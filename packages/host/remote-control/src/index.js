/**
 * Remote-control entry points: the pure CLI command implementations, the
 * controller core, and the read-only Remote gateway face. The CLI and
 * controller core stand alone so `shres remote` never boots a profile; the
 * gateway mounts only through its composition row.
 * @module @shres-code/shres-code-host-remote-control
 */
import RemoteControlGateway from "./gateway.js";
export { RemoteControlError } from "./errors.js";
export { resolveRegistryPath, resolveRunDir } from "./home.js";
export { RemoteControlGateway } from "./gateway.js";
export default RemoteControlGateway;
export { loadRegistry, upsertEntry, removeEntry, asRemoteId, asRemoteTarget, asRemotePort, REGISTRY_VERSION } from "./registry.js";
export { openTunnel, probeDaemonVersion, readInstallationId } from "./controller.js";
export { allocateLoopbackPort } from "./port.js";
export { installationIdCommand, masterArgv, parseProbeVersion, probeCommand, tunnelArgv } from "./ssh-args.js";
//# sourceMappingURL=index.js.map