/** Harness home resolution for the remote-control surface.
 * @module @shres-code/shres-code-host-remote-control/home
 */
/**
 * Resolve the registry path: explicit override wins, else the harness home's
 * `remote/remotes.json`.
 * @param configured - caller-supplied override (tests, isolated homes).
 * @returns absolute registry file path.
 */
export declare function resolveRegistryPath(configured?: string): string;
/**
 * Resolve the run directory holding ControlMaster sockets and PID markers.
 * @param configured - caller-supplied override (tests, isolated homes).
 * @returns absolute run directory path.
 */
export declare function resolveRunDir(configured?: string): string;
//# sourceMappingURL=home.d.ts.map