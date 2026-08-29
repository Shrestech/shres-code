# `@shres-code/shres-code-host-remote-control`

SSH-tunnel controller for VS Code-style remote connect: a durable remote-alias registry, the hardened tunnel argv contract, daemon probes (ClientRequest envelope, `result.value.version`), installation-identity checks, and the `shres remote` CLI. The Cordis plugin face mounts with its composition row in a later PR; the CLI and core stand alone so `shres remote` never boots a profile.

## Service API (pure functions + CLI)

| Export | Purpose |
|---|---|
| `loadRegistry` / `upsertEntry` / `removeEntry` | durable alias registry at `resolveRegistryPath()` (`$SHRES_HOME/remote/remotes.json`), single-writer via `withFileLock`, atomic replace at 0600/0700, schema version checked loud |
| `asRemoteId` / `asRemoteTarget` / `asRemotePort` | boundary validation for alias (`[a-z0-9-]`), `user@host`, and 1..65535 |
| `masterArgv` / `tunnelArgv` | exact ssh argv: ControlMaster (`ControlPersist=600`) and `ssh -N -L` with `ExitOnForwardFailure=yes`, `ServerAliveInterval=15/CountMax=3`; never `-F none` (user ProxyJump/config composes) |
| `probeCommand` / `parseProbeVersion` / `installationIdCommand` | remote one-liners and describe parsing; absent installation id returns null, never a guess |
| `openTunnel` | probe → forward → verify describe **through** the tunnel → fingerprint check; every failure after the master opened disposes it |
| `SshRunner` | process seam; tests inject fabricated output, the CLI passes a node adapter |
| `allocateLoopbackPort` | bind-verify-rebind port allocation; a stolen port becomes a loud `ExitOnForwardFailure` failure |

CLI: `shres remote add|list|remove|connect` (see `shres remote --help`); `connect` stays foreground, prints the tunneled GUI URL, and disposes the forward + master on SIGINT.

## Model Experience

### Request context and condition

#### What the model sees

Zero token effect: the package registers no tools, injects no prompts, and writes no session events; the model never observes its output unless the user pastes CLI text.

#### Model Experience context

The CLI prints the tunneled GUI URL; agents called through the tunnel behave exactly as local sessions — no model-visible surface originates here.

## Known Limitations and Deferred Work

- Tunnel liveness between CLI and future host-face consumers is not shared cross-process in PR1 (PID marker planned with the plugin face).
- No daemon ensure-running, auto-install, or degraded-mode lifecycle — PR2 composes over these primitives.
- Version comparison is exact-match with an `--allow-version-skew` warn path; a protocol version field is deferred until multi-origin clients exist.
- ControlMaster sockets live under `$SHRES_HOME/remote/run/`; NFS removes the lock/mtime assumptions the registry relies on — keep `$SHRES_HOME` on local disk.
