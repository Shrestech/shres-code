/**
 * Pure ssh argument builders and remote-command strings for the remote-control
 * package — the durable tunnel contract (`shres remote` CLI and the
 * `remoteAdmin` gateway run the same arguments; the runner owns the binary),
 * fully unit-tested. Never passes `-F none`: the user's ssh config
 * (ProxyJump, IdentityFile) must keep applying.
 * @module @shres-code/shres-code-host-remote-control
 */

import type { RemoteTarget, TunnelSpec } from './types.ts'

/** ControlMaster multiplexing window: one authentication per alias window. */
const CONTROL_PERSIST_SECONDS = 600
/** TCP keepalive cadence over the tunnel: matches defensive-pattern defaults. */
const SERVER_ALIVE_INTERVAL_SECONDS = 15
/** Dropped-attempts tolerance before the forward is considered dead. */
const SERVER_ALIVE_COUNT_MAX = 3

/**
 * Build the exact ControlMaster arguments for one alias target. The runner
 * supplies the ssh binary itself, so a configured wrapper command composes.
 * @param spec - resolved tunnel specification (only `target`/`controlPath` used).
 * @returns arguments for the multiplexing master connection.
 */
export function masterArgv(spec: Pick<TunnelSpec, 'target' | 'controlPath'>): string[] {
  return [
    '-M',
    '-o', `ControlPath=${spec.controlPath}`,
    '-o', 'ControlMaster=auto',
    '-o', `ControlPersist=${CONTROL_PERSIST_SECONDS}`,
    validateTarget(spec.target),
  ]
}

/**
 * Build the exact no-shell forward arguments for one tunnel.
 * `ExitOnForwardFailure` makes a lost remote listener fail the process instead
 * of listening dead; keepalives bound silent NAT/flow stalls. The controller
 * still passes the user's ssh config untouched (no `-F none`), so ProxyJump
 * composes.
 * @param spec - resolved tunnel specification.
 * @returns arguments for the long-lived `ssh -N -L` forward.
 */
export function tunnelArgv(spec: TunnelSpec): string[] {
  return [
    '-N',
    '-L', `${spec.localPort}:127.0.0.1:${spec.remotePort}`,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', `ServerAliveInterval=${SERVER_ALIVE_INTERVAL_SECONDS}`,
    '-o', `ServerAliveCountMax=${SERVER_ALIVE_COUNT_MAX}`,
    '-o', `ControlPath=${spec.controlPath}`,
    validateTarget(spec.target),
  ]
}

/**
 * Remote command probing the remote daemon's `host.describe` on loopback.
 * @param remotePort - remote daemon port.
 * @returns shell command string executed over `ssh` with a 2s curl timeout.
 */
export function probeCommand(remotePort: number): string {
  const body = '{"type":"client-request","rpcId":"remote-connect-probe","method":"host.describe","payload":{}}'
  return `curl -sS -m 2 -X POST http://127.0.0.1:${remotePort}/api/host.describe -H 'Content-Type: application/json' -d '${body}'`
}

/**
 * Remote command reading the installation id. An absent file yields empty
 * output, never a guess.
 * @returns shell command string executed over `ssh`.
 */
export function installationIdCommand(): string {
  return 'cat "$SHRES_HOME/.anonymous-user-id" 2>/dev/null || cat ~/.shres/.anonymous-user-id 2>/dev/null || true'
}

/**
 * Remote command checking whether a shres install exists at all: prints
 * `installed` when either the CLI binary is on PATH or a `~/.shres` home is
 * present, and nothing otherwise.
 * @returns shell command string executed over `ssh`.
 */
export function installationCheckCommand(): string {
  return 'command -v shres >/dev/null 2>&1 && echo installed || { [ -d "${SHRES_HOME:-$HOME/.shres}" ] && echo installed || true; }'
}

/**
 * Parse a `host.describe` response captured through the probe; failure is
 * data here (remote-down, wrong-port, garbage), so callers receive null.
 * @param stdout - combined probe output.
 * @returns the wire version string, or null when the response is not a describe body.
 */
export function parseProbeVersion(stdout: string): string | null {
  const start = stdout.indexOf('{')
  if (start < 0) return null
  try {
    const envelope: unknown = JSON.parse(stdout.slice(start))
    const value = (envelope as { result?: { value?: { version?: unknown } } }).result?.value
    const version: unknown = (value as { version?: unknown } | null | undefined)?.version
    return typeof version === 'string' && version.length > 0 ? version : null
  } catch (error) {
    // Truncated or torn probe output is an expected probe state, not a crash: report it as no-version.
    void error
    return null
  }
}

/**
 * Validate the connect target at every argv construction (the registry is a
 * durable file boundary): a target without `user@host`, whitespace, or a
 * leading dash (ssh would parse it as an option — there is no `--` terminator)
 * @param target - validated target.
 * @returns the same target for inline use.
 */
function validateTarget(target: RemoteTarget): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target)) throw new Error(`invalid remote target: ${target}`)
  return target
}
