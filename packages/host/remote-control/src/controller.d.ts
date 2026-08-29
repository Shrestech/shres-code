/**
 * The remote controller: process orchestration over an injectable ssh runner
 * so every path is testable with fabricated output. PR1 owns the tunnel path
 * only — probe, forward, verify, install-fingerprint check; the daemon
 * ensure-running flow is PR2 and composes over these primitives.
 * @module @shres-code/shres-code-host-remote-control
 */
import type { RemoteEntry, TunnelSpec } from './types.ts';
/** One completed short ssh execution; nonzero exits and stderr are data. */
export interface SshResult {
    /** Process exit code. */
    exitCode: number;
    /** Captured stdout (utf8). */
    stdout: string;
    /** Captured stderr (utf8). */
    stderr: string;
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
    run(args: readonly string[]): Promise<SshResult>;
    /**
     * Spawn one long-lived ssh (master or forward) that outlives the call.
     * @param args - full argv (including `ssh`).
     * @returns child pid and a disposer killing the process tree.
     */
    spawn(args: readonly string[]): Promise<{
        pid: number;
        dispose(): Promise<void>;
    }>;
}
/**
 * Probe the remote daemon over one ssh exec.
 * @param runner - process seam.
 * @param target - validated connect target.
 * @param remotePort - remote daemon loopback port.
 * @returns the daemon version, or null when the probe found nothing to parse.
 */
export declare function probeDaemonVersion(runner: SshRunner, target: string, remotePort: number, controlPath?: string): Promise<string | null>;
/**
 * Read the remote installation id over one ssh exec; empty output maps to
 * null (first connect or missing file).
 * @param runner - process seam.
 * @param target - validated connect target.
 * @returns the installation id or null.
 */
export declare function readInstallationId(runner: SshRunner, target: string, controlPath?: string): Promise<string | null>;
/** Knobs controlling how strictly {@link openTunnel} verifies the remote. */
export interface OpenTunnelOptions {
    /** Accept a daemon version other than the local one; the caller owes the warning output. */
    allowVersionSkew: boolean;
    /** Local controller version compared against the daemon's describe. */
    localVersion: string;
    /** Accept an installation id different from the recorded fingerprint. */
    forceFingerprint: boolean;
}
/** Live tunnel handle and the daemon facts observed at open time. */
export interface LiveTunnel {
    /** Forward child pid (informational; `dispose` owns the kill). */
    pid: number;
    /** Daemon version observed remotely before the forward opened. */
    version: string;
    /** Installation id observed on the remote. */
    fingerprint: string;
    /** Kill the forward and the master window; resolves even when one handle already exited. */
    dispose(): Promise<void>;
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
export declare function openTunnel(runner: SshRunner, spec: TunnelSpec, entry: RemoteEntry, options: OpenTunnelOptions): Promise<LiveTunnel>;
//# sourceMappingURL=controller.d.ts.map