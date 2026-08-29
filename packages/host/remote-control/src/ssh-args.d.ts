/**
 * Pure ssh argv builders and remote-command strings for the remote-control
 * package — the durable tunnel contract (`shres remote` CLI and any future
 * host face run the same argv), fully unit-tested. Never passes `-F none`:
 * the user's ssh config (ProxyJump, IdentityFile) must keep applying.
 * @module @shres-code/shres-code-host-remote-control
 */
import type { TunnelSpec } from './types.ts';
/**
 * Build the exact ControlMaster argv for one alias target.
 * @param spec - resolved tunnel specification (only `target`/`controlPath` used).
 * @returns argv for the multiplexing master connection.
 */
export declare function masterArgv(spec: Pick<TunnelSpec, 'target' | 'controlPath'>): string[];
/**
 * Build the exact no-shell forward argv for one tunnel. `ExitOnForwardFailure`
 * makes a lost remote listener fail the process instead of listening dead;
 * keepalives bound silent NAT/flow stalls. The controller still passes the
 * user's ssh config untouched (no `-F none`), so ProxyJump composes.
 * @param spec - resolved tunnel specification.
 * @returns argv for the long-lived `ssh -N -L` forward.
 */
export declare function tunnelArgv(spec: TunnelSpec): string[];
/**
 * Remote command probing the remote daemon's `host.describe` on loopback.
 * @param remotePort - remote daemon port.
 * @returns shell command string executed over `ssh` with a 2s curl timeout.
 */
export declare function probeCommand(remotePort: number): string;
/**
 * Remote command reading the installation id. An absent file yields empty
 * output, never a guess.
 * @returns shell command string executed over `ssh`.
 */
export declare function installationIdCommand(): string;
/**
 * Parse a `host.describe` response captured through the probe; failure is
 * data here (remote-down, wrong-port, garbage), so callers receive null.
 * @param stdout - combined probe output.
 * @returns the wire version string, or null when the response is not a describe body.
 */
export declare function parseProbeVersion(stdout: string): string | null;
//# sourceMappingURL=ssh-args.d.ts.map