/**
 * Types for the remote-control package: alias identifiers, durable registry
 * entries, the resolved tunnel specification, and the CLI command set.
 * @module @shres-code/shres-code-host-remote-control
 */

import type { Branded } from '@shres-code/shres-code-brand'

/** A remote alias — opaque registry key validated as `[a-z0-9-]{1,64}`. */
export type RemoteId = Branded<'RemoteId'>

/** `user@host` connect target, validated against shell-hostile characters. */
export type RemoteTarget = Branded<'RemoteTarget'>

/** One durable remote alias entry persisted in `remote/remotes.json`. */
export interface RemoteEntry {
  /** Stable alias key; also the ControlMaster socket and PID-marker name. */
  id: RemoteId
  /** `user@host` target. */
  target: RemoteTarget
  /** Remote daemon loopback port the tunnel forwards to. */
  remotePort: number
  /** On-disk schema version of the registry file. */
  version: number
  /** Remote installation id (`$SHRES_HOME/.anonymous-user-id`), null until first connect. */
  fingerprint: string | null
  /** Creation timestamp (ISO 8601). */
  createdAt: string
  /** Last verified-connect timestamp (ISO 8601), null before the first connect. */
  lastConnectedAt: string | null
}

/** Fully-resolved forward for one tunnel, explicit per the resolve-then-run seam. */
export interface TunnelSpec {
  /** Alias the tunnel belongs to. */
  id: RemoteId
  /** `user@host` target. */
  target: RemoteTarget
  /** Allocated local loopback port to bind. */
  localPort: number
  /** Remote daemon port on the remote's loopback. */
  remotePort: number
  /** ControlMaster socket path for this alias, owned by `remote/run/`. */
  controlPath: string
}

/** Error codes thrown by this package's typed failures. */
export type RemoteControlErrorCode =
  | 'invalid-alias'
  | 'invalid-target'
  | 'invalid-port'
  | 'registry-corrupt'
  | 'unknown-alias'
  | 'probe-failed'
  | 'tunnel-failed'
  | 'version-mismatch'
  | 'fingerprint-mismatch'

/** Parsed `shres remote` subcommand set (launcher-owned union). */
export type RemoteCliCommand =
  | { kind: 'remote-add'; alias: string; target: string; remotePort: number }
  | { kind: 'remote-list' }
  | { kind: 'remote-remove'; alias: string }
  | { kind: 'remote-connect'; alias: string; localPort?: number; allowVersionSkew: boolean; forceFingerprint: boolean }
