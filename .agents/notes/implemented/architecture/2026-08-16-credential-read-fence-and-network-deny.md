# Agent Note: Credential read fence and default-deny sandbox network

Status: implemented

English | [中文](2026-08-16-credential-read-fence-and-network-deny.zh.md)

## Problem

The in-process filesystem fence confined writes but let every mode read any path the host process can open, so a model-controlled `read` of `$ROOS_HOME/.credentials.yaml` (or a `*.credentials.yaml` alias) exfiltrated provider keys. Separately, Seatbelt and Landlock confined file effects while leaving outbound TCP open; only bwrap was assumed to isolate the network, and even that profile omitted `--unshare-net`. A confined child could therefore fetch arbitrary hosts on macOS and on Linux Landlock, and also on Linux bwrap until this change.

## Decision

**Always-on credential fence in `roos-fs-sandbox`.** `readText` / `streamText` / `readBytes` / `writeText` / `editText` go through `checkedTarget()` and re-canonicalize. Under every mode except `danger-full-access`, the backend denies `$ROOS_HOME/.credentials.yaml`, any `*.credentials.yaml` basename (case-insensitive), and each validated `denyReadPaths` entry with `FS_SANDBOX_DENIED`. The home document is also matched by resolved identity so a workspace symlink cannot bypass the fence. Mutations are denied so `before`/`after` cannot leak those files. `read` / `read_image` stamp the session's standing policy so a session `danger-full-access` fold lifts the fence.

**Validated `network: 'allow' | 'deny'` on `ctx.sandboxPolicy`, default `deny`.** `resolve()` always carries the field. `sandboxNetwork()` treats an omitted hand-built policy field as `deny`. Seatbelt adds `(deny network-outbound)`; bwrap adds `--unshare-net` and the functional bwrap probe uses that same profile so a netns-incapable host falls back to Landlock. Landlock filesystem grants stay as they were, and the launcher denies TCP bind/connect when the kernel ABI supports those accesses. `network: allow` lifts the Seatbelt/bwrap rules and passes `--allow-net` to `landlock-run`.

**Landlock ≥ 6.7 (ABI 4) is required for a full TCP deny.** The launcher adds `handled_access_net` only after `landlock_create_ruleset` reports ABI ≥ 4 (and retries without the net attribute on `E2BIG`/`EINVAL`). An older kernel keeps the filesystem ruleset and the existing probe reports `partial` instead of failing the wrap.

## Alternatives considered

- **Deny only the exact `$ROOS_HOME/.credentials.yaml` path** — a workspace copy named `provider.credentials.yaml`, or a symlink with a harmless display path, would still leak. The basename glob plus identity match closes those aliases.
- **Kernel-only network deny, no policy field** — Seatbelt/Landlock would change with no operator escape, and bwrap could not opt back in. A validated config field is the deployment knob; a `DEFAULT_*` constant is not configurability.
- **Fail the Landlock wrap when ABI < 4** — Linux hosts that already use Landlock for files would lose confinement entirely. Reporting `partial` keeps file effects and tells the consumer the TCP promise is incomplete.
- **Put `network` only on `sandbox-local` Config** — bash and other consumers that construct a `SandboxPolicy` from `ctx.sandboxPolicy.resolve()` would not see it. The policy home is the one owner of per-call confinement inputs.

## Consequences

Reading or mutating the managed credentials document through `ctx.fs` requires `danger-full-access`. Extra deny paths are a plugin config, not a session override. Outbound network is now denied by default on macOS Seatbelt, Linux bwrap (`--unshare-net` is new), and Linux Landlock when ABI ≥ 4; operators that need child network set `network: allow` on `sandbox-policy`. Windows ACL is unchanged. Landlock kernels below 6.7 still confine files and probe `partial`. The assembled-application snapshot harness has no recorded credential-read-denial scenario yet; the model-facing marker is pinned by the `roos-tool-fs` sandboxed transcript test instead.
