Title: Remote-control registry Remote namespace

Status: implemented

Kind: architecture

Date: 2026-08-29

## Problem

PR1's controller shipped CLI-only; the sidebar's Workspace region had no way to
read the remote registry, and no RPC existed for a client to ask which remote
hosts the serving daemon knows. The debated plan needed the GUI-registry slice
before sync, which meant choosing a wire seam for that projection.

## Decision

Expose the registry through a generated Typert Remote namespace,
`remoteControl/list`, exactly like `plugin-inventory`: a read-only
`TypertRemoteService` re-reading the registry file per call, mounted by the
web-app composition row and assembled into the Client via the `api/remotes`
contribution list (`ctx.remote.remoteControl`).

## Rationale

- The Typert face is the product-UI channel per docs/api-gateway.md; web-plugin
  client-slot RPC and untyped BFF routes were rejected by that document's
  assembly ownership and descriptor strictness, and a session-event feed is the
  wrong plane (registry roster is not model-visible).
- Per-call file reads are required freshness: the registry's only writer is the
  separate `shres` CLI process, so no in-process event or cache could observe
  its writes; lock + atomic replace make each read consistent.
- The namespace stays read-only permanently. Mutating/connect operations mount
  as a separate token-gated namespace: this service is served identically by
  local and tunneled remotes, and a leaf connect on a remote daemon cannot
  enforce the local user's gesture authority (the tokens-in-leaf-RPC rejection
  in the PR1 note).
- Registry divergence fails loud through the wire as a message-only error
  (`code: 'internal'`): degrading to an empty snapshot would silently hide
  remotes and invite overwrites; wire callers render the message and point at
  `shres remote list`.
- The empty invariant installer owns no runtime relationship: the gateway
  projects a durable file directly and keeps no long-lived state.

## Alternatives considered

A BFF-only `/api` route (unvalidated parallel seam), a web-plugin client-slot
register (package-private RPC, wrong product plane), and a session-event feed
(must not masquerade as Remote methods). All rejected per docs/api-gateway.md.

## Consequences

- `remoteControl/list` is a public wire contract from v0.1.0-rc.5; its shape is
  frozen until the UI consumer merges.
- The gateway's README documents the message-only wire error stance; threading
  typed error codes through the Typert Gateway is a separate, Typert-level PR
  if ever needed.
- `PRIVILEGED_METHODS` loopback-pins `remoteControl/list` alongside the
  `remoteAdmin` namespace; the pin decision is recorded in the
  [remoteAdmin note](2026-08-30-remote-admin-namespace.md).
- Known gap (accepted precedent, same shape as merged plugin-inventory): the
  mount is proven by unit harness plus the Loader smoke face, not a dedicated
  real-composition test of the patch row.

## Supersession audit

None. Extends `2026-08-29-remote-control-pr1.md` with the wire-face decision;
nothing in that note is contradicted.