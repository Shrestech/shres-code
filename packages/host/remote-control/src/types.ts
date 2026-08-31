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

/** Default loopback port of the remote `shres web` daemon (`packages/boot/cmdline` webserver defaults). */
export const DEFAULT_REMOTE_DAEMON_PORT = 3080

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
  | 'gesture-refused'
  | 'removed-while-connecting'
  | 'no-remote-install'
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

/** One registry entry projected to remote RPC clients. */
export interface RemoteEntryView {
  /** Registry alias. */
  id: RemoteId
  /** SSH connect target, `user@host`. */
  target: RemoteTarget
  /** Daemon port on the remote loopback. */
  remotePort: number
  /** Installation identity bound by a verified connect, null until first `connect`. */
  fingerprint: string | null
  /** ISO timestamp of the last verified connect, null when never connected. */
  lastConnectedAt: string | null
  /** ISO creation timestamp. */
  createdAt: string
}

/** Read-only registry snapshot served over the `remoteControl` Remote namespace. */
export interface RemoteRegistrySnapshot {
  entries: RemoteEntryView[]
}

/** The verbs a user gesture can authorize; each mutating `remoteAdmin` method consumes exactly one. */
export type AdminGestureVerb = 'connect' | 'disconnect' | 'add' | 'edit' | 'removeEntry'

/** Full-state projection of one alias's GUI-owned tunnel, published on every committed transition. */
export interface TunnelStateView {
  /** Alias the tunnel belongs to. */
  alias: RemoteId
  /** Display state after the last committed transition. */
  state: 'connecting' | 'open' | 'closed' | 'error'
  /** Allocated local loopback port, null before the forward bound. */
  localPort: number | null
  /** Daemon version observed at open time, null before a verified open. */
  version: string | null
  /** Installation id observed at open time, null before a verified open. */
  fingerprint: string | null
  /** Human-readable failure for state `error`; null otherwise. */
  error: string | null
  /** ISO 8601 timestamp of the last committed transition. */
  since: string
}

/**
 * Connect decision data: every expected verification failure is a variant the
 * trust modal branches on, never a wire error — the Gateway's generic failure
 * envelope is message-only and could not carry an "allow version skew" decision.
 */
export type ConnectOutcome =
  | { status: 'connected'; localPort: number; version: string; fingerprint: string }
  | { status: 'version-mismatch'; observed: string | null; local: string }
  | { status: 'fingerprint-mismatch'; observed: string | null; trusted: string | null }
  | { status: 'unreachable'; stage: 'probe' | 'tunnel' | 'removed' | 'uninstalled'; message: string }

/** Disconnect decision data: a not-connected alias is a display state, not an error. */
export type DisconnectOutcome =
  | { state: 'closed' }
  | { state: 'not-connected' }

/** Remove decision data: a live tunnel refuses removal so the UI disconnects first. */
export type RemoveOutcome =
  | { status: 'removed'; removed: boolean }
  | { status: 'connected' }

/** Wire request for `remoteAdmin/begin`: the gesture to authorize. */
export interface AdminBeginRequest {
  /** The mutation verb to authorize. */
  verb: AdminGestureVerb
  /** The alias the verb targets; null only for `add`, which names a new alias. */
  alias: string | null
}

/** Wire grant from `remoteAdmin/begin`: spendable on exactly one matching mutation. */
export interface GestureGrant {
  /** 128-bit hex nonce. */
  token: string
  /** ISO 8601 deadline after which the grant is dead. */
  expiresAt: string
}

/** Wire request for `remoteAdmin/inspect`. */
export interface AdminInspectRequest {
  /** Alias to observe. */
  alias: string
}

/** Wire request for `remoteAdmin/connect`. */
export interface AdminConnectRequest {
  /** Grant from `begin({ verb: 'connect', alias })`. */
  token: string
  /** Alias to connect. */
  alias: string
  /** Accept a daemon version other than this controller's. */
  allowVersionSkew: boolean
  /** Accept an installation id different from the recorded fingerprint. */
  forceFingerprint: boolean
}

/** Wire request for `remoteAdmin/disconnect`. */
export interface AdminDisconnectRequest {
  /** Grant from `begin({ verb: 'disconnect', alias })`. */
  token: string
  /** Alias to disconnect. */
  alias: string
}

/** Wire request for `remoteAdmin/add` and `remoteAdmin/edit`. */
export interface AdminEntryRequest {
  /** Grant bound to `add` (alias null) or `edit` (this alias). */
  token: string
  /** Alias to insert or rewrite. */
  alias: string
  /** `user@host` connect target. */
  target: string
  /** Remote daemon loopback port; omitted resolves to {@link DEFAULT_REMOTE_DAEMON_PORT} at the gateway. */
  remotePort?: number
}

/** Wire request for `remoteAdmin/removeEntry`. */
export interface AdminRemoveRequest {
  /** Grant from `begin({ verb: 'removeEntry', alias })`. */
  token: string
  /** Alias to remove. */
  alias: string
}

/** One inserted or rewritten registry entry. */
export interface AdminEntryResult {
  /** The entry as it now reads in the registry. */
  entry: RemoteEntryView
}

/** Full tunnel-state picture for a fresh page load. */
export interface AdminStatusResult {
  /** Every alias this process tracks, in tracking order. */
  tunnels: TunnelStateView[]
}

/** One alias's trust-modal facts: remote observations plus what this controller knows. */
export interface RemoteInspectView {
  /** Registry target the probes ran against. */
  target: RemoteTarget
  /** Daemon version answered by the describe probe; null means unreachable. */
  daemonVersion: string | null
  /** Installation id read from the remote; null when absent. */
  installationId: string | null
  /** This controller's own version, the local side of the skew check. */
  localVersion: string
  /** True when no fingerprint is on record yet (trust-on-first-use decision). */
  firstConnect: boolean
  /** Fingerprint bound by a previous verified connect, null before the first. */
  trustedFingerprint: string | null
}

declare module '@shres-code/cordis' {
  interface Events {
    /**
     * Full-state projection of one alias's GUI-owned tunnel after each
     * committed transition (connecting, open, closed, error). The payload is
     * the complete view, so consumers reconcile idempotently with no cursor;
     * a fresh page fills its initial picture from `remoteAdmin/status`.
     * @param view - the complete current state of the alias's tunnel.
     * @mode emit
     */
    'remote-control/tunnel-state'(view: TunnelStateView): void
  }
}
