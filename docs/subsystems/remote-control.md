# Remote connect

Remote connect owns VS Code-style connect to a remote host over SSH: a durable alias registry, a hardened tunnel contract, the gesture-gated `remoteAdmin` mutation namespace, and the read-only `remoteControl` registry projection. The [package README](../../packages/host/remote-control/README.md) owns composition, config, and limitations; the [namespace and gate note](../../.agents/notes/implemented/architecture/2026-08-30-remote-admin-namespace.md) owns the trust model, and the [controller-core](../../.agents/notes/implemented/architecture/2026-08-29-remote-control-pr1.md) and [registry-namespace](../../.agents/notes/implemented/architecture/2026-08-29-remote-control-remote-face.md) notes own the underlying decisions. Source: [`packages/host/remote-control/src/types.ts`](../../packages/host/remote-control/src/types.ts).

## Durable registry records

`RemoteEntry` is one durable alias: the [branded](core.md#branded-ids) `RemoteId` alias (`[a-z0-9-]`, up to 64 characters), the branded `RemoteTarget` (`user@host`, validated against shell-hostile characters at every argv construction and read), the remote daemon's loopback `remotePort` (1..65535), the on-disk `version`, the nullable `fingerprint` (the remote installation id bound by a verified connect), and the `createdAt`/`lastConnectedAt` ISO timestamps. `RemoteEntryView` projects an entry to Remote clients without the on-disk version. `remoteControl/list` answers `RemoteRegistrySnapshot` by re-reading the file per call — the CLI is a separate process, so no cache can observe its writes; a missing file is the empty snapshot, and any malformed content fails loud as `registry-corrupt`. Writers (`shres remote`, `remoteAdmin/add|edit|remove`) serialize through a locked read-modify-write and commit with an atomic 0600/0700 replace, so GUI and CLI writes never lose each other.

## Tunnel contract

`TunnelSpec` is one fully resolved forward: alias, target, allocated local loopback port, remote daemon port, and the alias's ControlMaster socket path under the run directory. `SshRunner` is the process seam over ssh arguments — the runner owns the binary, so deployments and tests substitute the command; `nodeSshRunner` adapts Node child processes with a SIGTERM-then-SIGKILL disposer and an optional exit observation. `openTunnel` runs probe → forward → verify `host.describe` through the tunnel → installation-id check, disposes every handle it opened on any failure, and reports the observed daemon `version` and `fingerprint` on the `LiveTunnel` handle.

## Gesture-gated decisions

`remoteAdmin` is the only mutating surface: `begin` mints a `GestureGrant` (a 128-bit one-shot token with a fixed 120-second window, 32 grants outstanding at most), and each mutating method consumes the grant — bound to its verb and alias — before acting. `inspect` answers `RemoteInspectView` trust-modal facts (remote daemon version, installation id, the controller's own version, first-connect and recorded-fingerprint flags); `add`/`edit` answer `AdminEntryResult`; `remove` answers `RemoveOutcome`; `disconnect` answers `DisconnectOutcome`. `connect` answers `ConnectOutcome`: `connected` with the bound port, version, and fingerprint, or the decision data a trust modal needs — `version-mismatch` (observed against local), `fingerprint-mismatch` (observed against trusted), or `unreachable` with the stage that failed. Every method is loopback-pinned by Connection policy; the namespace adds no tools and no session events.

## Tunnel liveness projection

The webapp process that opened a tunnel owns its liveness in memory: one record per alias with the display state (`connecting`, `open`, `closed`, `error`), and a `run/<alias>.pid` marker per open forward. Every committed transition publishes the complete `TunnelStateView` through the `remote-control/tunnel-state` event — idempotent consumer reconciliation with no cursor — and `remoteAdmin/status` answers the full picture for a fresh page. A daemon restart reports every tunnel closed; cross-process adoption of another process's forward is a recorded deferral.
<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="remote-control-events"></a>

### `remote-control/*` events

<a id="remote-controltunnel-state--emit"></a>

#### `remote-control/tunnel-state` — emit

Full-state projection of one alias's GUI-owned tunnel after each committed transition (connecting, open, closed, error). The payload is the complete view, so consumers reconcile idempotently with no cursor; a fresh page fills its initial picture from `remoteAdmin/status`.

```ts cordis-catalog
/**
 * Full-state projection of one alias's GUI-owned tunnel after each
 * committed transition (connecting, open, closed, error). The payload is
 * the complete view, so consumers reconcile idempotently with no cursor;
 * a fresh page fills its initial picture from `remoteAdmin/status`.
 * @param view - the complete current state of the alias's tunnel.
 * @mode emit
 */
'remote-control/tunnel-state'(view: TunnelStateView): void
```

Source: [`packages/host/remote-control/src/types.ts:231`](../../packages/host/remote-control/src/types.ts)
<!-- END GENERATED cordis-surface -->
