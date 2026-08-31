# `@shres-code/shres-code-host-remote-control`

SSH-tunnel controller for VS Code-style remote connect: a durable remote-alias registry, the hardened tunnel argument contract, daemon probes (ClientRequest envelope, `result.value.version`), installation-identity checks, the `shres remote` CLI, the read-only `remoteControl` Remote namespace, and the gesture-gated `remoteAdmin` mutation namespace that owns the webapp's tunnels. The CLI and core stand alone so `shres remote` never boots a profile; the gateways mount only through the web-app composition rows.

## Service API (Remote namespace + pure functions + CLI)

| Export | Purpose |
|---|---|
| `RemoteControlGateway` | Remote namespace `remoteControl` (`@Remote('list')`): re-reads the registry file per call — the CLI writer is a separate process, so no cache or event can observe its writes; a missing file is the empty snapshot. Read-only forever: the token-gated `remoteAdmin` namespace beside it owns every mutation, because leaf methods served by a tunneled remote daemon cannot enforce the local user's gesture authority. Wire errors surface as the Gateway's generic failure envelope (message only, no typed code) — wire callers render the message and point at `shres remote list`. |
| `RemoteAdminGateway` | Remote namespace `remoteAdmin` (`begin`/`inspect`/`connect`/`disconnect`/`add`/`edit`/`remove`/`status`), mounted from the `./admin` subpath as its own composition row: the only mutating surface. Each mutation spends a one-shot gesture token minted by `begin` and bound to its (verb, alias); every method is loopback-pinned through `PRIVILEGED_METHODS`. Connect decisions (version skew, fingerprint change, unreachable) answer as discriminated outcome data — the wire failure envelope is message-only and could not carry a connect-anyway decision. Config: `registryPath` / `runDir` / `sshCommand` overrides for overlays and hermetic tests. |
| `GestureLedger` | one-shot gesture tokens: 128-bit nonces, fixed 120s window, 32-outstanding cap (oldest evicted); consumption is delete-first, so a wrong-scope, expired, or replayed presentation never leaves a re-usable token |
| `loadRegistry` / `upsertEntry` / `removeEntry` | durable alias registry at `resolveRegistryPath()` (`$SHRES_HOME/remote/remotes.json`), single-writer via `withFileLock`, atomic replace at 0600/0700, schema version checked loud |
| `asRemoteId` / `asRemoteTarget` / `asRemotePort` | boundary validation for alias (`[a-z0-9-]`), `user@host`, and 1..65535 |
| `masterArgv` / `tunnelArgv` | exact ssh arguments (the runner owns the binary): ControlMaster (`ControlPersist=600`) and the no-shell forward with `ExitOnForwardFailure=yes`, `ServerAliveInterval=15/CountMax=3`; never `-F none` (user ProxyJump/config composes) |
| `probeCommand` / `parseProbeVersion` / `installationIdCommand` | remote one-liners and describe parsing; absent installation id returns null, never a guess |
| `openTunnel` | probe → forward → verify describe **through** the tunnel → fingerprint check; every failure after the master opened disposes it |
| `SshRunner` | process seam over ssh arguments; tests inject fabricated output, `nodeSshRunner` adapts Node child processes (another ssh command may be passed for wrappers and fixtures) |
| `nodeSshRunner` | the Node adapter: short execs piped-and-awaited, long-lived children with a SIGTERM-then-SIGKILL disposer and optional exit observation |
| `allocateLoopbackPort` | bind-verify-rebind port allocation; a stolen port becomes a loud `ExitOnForwardFailure` failure |
| `TunnelManager` | in-memory liveness authority for the process's own tunnels: one record per alias, `run/<alias>.pid` markers, and a full-state `remote-control/tunnel-state` publication on every committed transition; gateway teardown ends the process's tunnels |

CLI: `shres remote add|list|remove|connect` (see `shres remote --help`); `connect` stays foreground, prints the tunneled GUI URL, and disposes the forward + master on SIGINT.

## Model Experience

None, as the package registers no tools, injects no prompts, and writes no session events; the model never observes its output unless the user pastes CLI text.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- Tunnel liveness is per-process: `run/<alias>.pid` markers record each open forward, but a restarted daemon reports every tunnel closed and never adopts another process's marker or forward.
- A disconnect arriving while that alias's connect is still dialing answers `not-connected`; the in-flight open completes and a second disconnect closes it.
- No daemon ensure-running, auto-install, or degraded-mode lifecycle — the sidebar Remotes group composes over these primitives.
- Version comparison is exact-match with an `--allow-version-skew` warn path; a protocol version field is deferred until multi-origin clients exist.
- ControlMaster sockets live under `$SHRES_HOME/remote/run/`; NFS removes the lock/mtime assumptions the registry relies on — keep `$SHRES_HOME` on local disk.
