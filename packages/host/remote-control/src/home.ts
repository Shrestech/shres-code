/** Harness home resolution for the remote-control surface.
 * @module @shres-code/shres-code-host-remote-control/home
 */

import { shresHomePath } from '@shres-code/shres-code-home-paths'

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