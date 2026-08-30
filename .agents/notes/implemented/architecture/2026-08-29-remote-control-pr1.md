# Agent Note: Remote control PR1 — registry, tunnel contract, CLI

Status: implemented

Kind: architecture
Date: 2026-08-29



## Problem

Remote connect needs a durable controller: alias registry, hardened tunnel argv, identity checks, and a CLI that boots no profile. Lack of a wired `describe.version` also makes controller-daemon skew undetectable.

## Decision

VS Code-style remote connect rides an SSH-tunnel + loopback carrier: the remote daemon runs the web composition and serves dist on its loopback; the local controller opens a hardened `ssh -N -L` forward and the browser navigates to the tunneled origin. The port-agnostic loopback fence admits the origin unchanged, so the client needs zero carrier changes. PR1 ships the controller core: the `remote/remotes.json` registry (single-writer lock + atomic replace + loud schema check), the frozen ssh argv contract (ControlMaster with `ControlPersist=600`; forward with `ExitOnForwardFailure=yes`, keepalives `15/3`; **never `-F none`**, so user ProxyJump composes), a bind-verify-rebind port allocator, daemon describe probes, the installation-id check via `$SHRES_HOME/.anonymous-user-id` (layered under ssh host-key pinning: host key proves the host, the id proves the same installation — catching port-reuse/wrong-daemon misdirection that looks healthy), and the `shres remote add|list|remove|connect` CLI over a launcher-owned dispatch with a node runner adapter.

## Rationale

Tunnel trust extends the remote's loopback trust to the local loopback; that is sound only because holding the SSH key already implied a remote shell. Sync and consent run through the [remoteAdmin namespace](2026-08-30-remote-admin-namespace.md) at the controller's own dispatch seam with gesture-minted authority, and the remote's leaf RPC semantics stay untouched. `host.describe.version` now reports the running package's manifest version (workspace invariant pins it to every app's version), so controller↔daemon skew becomes exact-match-refusable pre-first-tag with an `--allow-version-skew` warn path; a protocol version field waits for multi-origin clients. Reconnect remains the client's existing full-rebuild resync by design; a `since` cursor stays a deliberate future decision, not a resume patch.

## Alternatives considered

See the negative guarantees above; the losing alternatives remain tempting in exactly the stated forms.

## Consequences

The supervision contract (flags, ports, disposal, jobs ownership) is the durable contract future PRs compose: PR2 slots ensure-running between probe and forward, and the [remoteAdmin namespace](2026-08-30-remote-admin-namespace.md) mounts the gesture-gated mutation face beside the read-only projection, sharing this registry.

- tmux/nohup backed persistence: rejected — detached shells cannot survive reboot and could not back a persistence claim; the daemon lifecycle belongs to PR2's ensure-running path.
- Fixed default ports: rejected — local ports are allocated and stored per remote; daemon ports come from the registry.
- Tokens inside the remote's leaf RPC methods: rejected — the fence is a reachability policy, not authentication, and the remote's own GUI already calls those methods.
- Model tools for remote operations: rejected forever — remote changes are user-gesture-driven only.

## Supersession audit

Grep over `.agents/notes/**/*` found no active note owning remote-connect, tunnel, or ssh-registry decisions; the transport-independent WebSocket carrier note is complementary, not superseding.
