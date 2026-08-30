# Agent Note: remoteAdmin namespace — gesture gate and tunnel liveness

Status: implemented

Kind: architecture

Date: 2026-08-30

## Problem

The web GUI could only read the remote registry: `remoteControl/list` served the roster while connect, disconnect, and registry curation had no host surface (the `shres remote` CLI was the only writer), and tunnel liveness had no owner at all — the registry file is durable truth, not a liveness authority. The /api trust fence is a reachability policy, not authentication, so a browser-visible Connect needed an authority model that proves a local gesture without claiming to authenticate anyone, and tunneled remote daemons serve this same package, so they must not inherit the local machine's mutation authority.

## Decision

The remote plane splits into two namespaces served from one package: `remoteControl` stays read-only forever with its `list` shape frozen as the public wire contract, and `remoteAdmin` mounts from the package's `./admin` subpath as its own composition row as the only mutating surface — `begin`/`inspect`/`connect`/`disconnect`/`add`/`edit`/`remove`/`status`.

The gesture gate lives in the `remoteAdmin` operations, not the apiproxy carrier: scope validation needs the verb/alias semantics the carrier must not learn, and the operation that spends a token is the one that enforces it. `begin` mints a one-shot 128-bit token bound to its (verb, alias) with a fixed 120-second window and a 32-token outstanding cap (oldest evicted); each mutating method consumes the grant as its first act — delete before effect — so replays, double-clicks, and wrong-scope presentations fail closed. The carrier keeps only the reachability class it already owns: every remote-plane method is loopback-pinned in `PRIVILEGED_METHODS`, `remoteControl/list` included because registry targets (`user@host`) are reconnaissance-grade like `settings.describe` beside them. That pin closes the decision the remote-face note had left to the UI PR.

The gate's honest properties: machine-and-process binding (tokens exist only in the serving daemon's memory, and a token minted locally never traverses the ssh tunnel because the local GUI's mutating calls are same-origin to the local daemon only), one gesture equals one mutation, and scope binding. It is not XSS defense, not local-process defense, and not authentication; model tools for remote operations stay rejected, and the namespace adds no tools and no session events.

What a compromised tunneled daemon can and cannot do — it mounts the same composition and therefore both namespaces, but only against its own machine and registry:

| Capability | A compromised tunneled daemon |
|---|---|
| Serve its own GUI and lie in responses | CAN — host-key and installation-identity territory of `openTunnel`'s probe → forward → verify chain |
| Invoke its own `remoteAdmin` | CAN — mutations on itself are equivalent to it running the CLI; its own trust domain |
| Read its own registry | CAN |
| Read or write the LOCAL registry, open or close LOCAL tunnels | CANNOT |
| Mint LOCAL tokens | CANNOT — tokens exist only in the local daemon's process memory, and `begin` is loopback-pinned |
| Reach the local /api at all | CANNOT — the tunnel is `ssh -N -L` (local-listen only), and a cross-origin POST always attaches an `Origin` whose host differs from `Host`, which the fence refuses; `sec-fetch-site: cross-site` is refused outright |

Expected connect decisions answer as discriminated-outcome data — version skew, fingerprint change, and unreachable with its stage — because the Gateway's wire failure envelope is message-only and could not carry a connect-anyway decision; `openTunnel`'s typed failures carry structured facts so outcomes map without message parsing, while caller misuse and transport failures stay wire errors.

The gateway owns tunnel liveness in an in-memory manager: one record per alias, `run/<alias>.pid` markers written on a verified open, and a full-state `remote-control/tunnel-state` cordis event on every committed transition — idempotent client reconciliation with no cursor — forwarded through the api-remotes allowlist, with `remoteAdmin/status` as the read channel for fresh pages. The registry stays a durable file written only through the locked read-modify-write, so GUI and CLI writers serialize.

The `SshRunner` seam receives ssh arguments without the binary; the extracted `nodeSshRunner` prepends a configurable ssh command. The admin gateway's `registryPath`/`runDir`/`sshCommand` config fields are the deployment-varying seams, and `sshCommand` doubles as the hermetic test seam. This split fixes the prior argv, which embedded a literal leading `ssh` that the node adapter passed straight to `execFile`, so every real execution ran `ssh ssh …`.

## Alternatives considered

**Tokens in the apiproxy carrier.** Rejected: the carrier would have to learn verb/alias scope semantics that belong to the namespace, and a decision enforced anywhere but the spending operation can be bypassed by callers of that operation.

**Throwing typed errors for connect decisions.** Rejected: the Gateway maps business throws to its generic message-only failure envelope, so a thrown version-mismatch would be unrenderable as a connect-anyway decision.

**Eventing the registry on change.** Rejected: the registry is durable truth written by separate processes, not liveness; tunnel state belongs to the process that opened the tunnel, which is the only authority that can observe a child exit.

**Sharing tunnel authority with the tunneled daemon.** Rejected: a token minted by daemon A is meaningless on daemon B by construction, and that property is what bounds the compromise table above; any shared form would widen it.

## Consequences

`remoteControl/list` keeps its frozen shape; the new plane lives beside it, and a LAN-served GUI loses the whole remote plane (loopback pin) until a real authentication layer exists. Tunnel lifetime is the webapp process: a restart honestly reports every tunnel closed, PID markers are recorded but never adopted cross-process, and a disconnect racing a still-dialing connect answers `not-connected` while the in-flight open completes. The connected tab is the tunneled origin opened in a new tab (the client PR); a same-tab origin switch was rejected because it needs cross-origin /api and an Origin-fence exemption for a cross-port loopback caller — a security-shape change for a cosmetic win. /api stays POST-only, pinned end-to-end.

## Testing

Package unit suites with a fabricated runner cover gesture one-shot/scope/TTL/eviction semantics, the full connect outcome matrix, add/edit/remove through a temp-home registry, manager transitions including child-exit observation and marker cleanup, and the node adapter over `process.execPath`. The real-composition e2e (`apps/web/tests/remote-admin.e2e.ts`) drives begin → add → `remoteControl/list` reflects → edit → remove through the HTTP carrier, refuses spent, missing, and out-of-scope tokens, pins GET non-dispatch, and expects 403 for a declared non-loopback authority on both namespaces. The connection package's pin test covers every new loopback pin.

## Supersession audit

Extends [remote control PR1](2026-08-29-remote-control-pr1.md) — the controller core whose consequences deferred gesture authority to a later PR — and [the remote face](2026-08-29-remote-control-remote-face.md), whose read-only-forever rule stands unchanged while its deferred `PRIVILEGED_METHODS` decision is closed here. A grep over the active tree found no other note owning remote mutation, gesture, or tunnel-liveness decisions; nothing is superseded.
