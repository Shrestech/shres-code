/**
 * Loopback port allocation for tunnels: bind-verify-then-release, with a
 * re-check second pass because the kernel may hand the same ephemeral port
 * back to two successive probes.
 * @module @shres-code/shres-code-host-remote-control
 */
/**
 * Allocate one free loopback TCP port by binding `127.0.0.1:0`, observing the
 * assigned port, closing the listener, and re-verifying the port binds again.
 * The port is a race window by construction; the tunnel's own
 * `ExitOnForwardFailure` converts a stolen port into a loud failure.
 * @returns a loopback port that was free at call time.
 */
export declare function allocateLoopbackPort(): Promise<number>;
//# sourceMappingURL=port.d.ts.map