# @shres-code/shres-code-judgment-laya

Local engine for the typed-judgment seam, registered in `ctx.judgmentEngines` as `laya` for [judgment-dispatch](../judgment-dispatch/README.md) to route asks to. The package supervises one loopback [`shres-laya-gateway`](../../../python/laya-gateway/README.md) process that runs a pinned [Laya](https://github.com/NandhaKishorM/laya) checkpoint through [laya-mlx](https://github.com/mizorewww/laya-mlx) on Apple silicon, and answers every ask over the Shield judgment wire through [`createShieldWireEngine`](../judgment-shield/README.md#wire-client). Judgment state never leaves the machine.

Installation is explicit: `/laya install` (or `install()`) creates a uv-managed virtual environment, syncs the gateway's hash-locked dependencies, downloads the pinned checkpoint, verifies every file's SHA-256 against the checked-in manifest, and writes an install marker. Every uv command runs with `UV_CACHE_DIR=<runtimeDir>/uv-cache`, `UV_PYTHON_INSTALL_DIR=<runtimeDir>/python`, and `UV_PYTHON_PREFERENCE=only-managed`: the virtual environment uses a uv-managed CPython installed inside `runtimeDir`, never a system or globally installed Python, and uv's global cache is not used. Deleting `runtimeDir` removes everything an install added, and `uv python uninstall` elsewhere cannot break it. The first install downloads that interpreter, about 20–40 MB (CPython 3.11 occupies about 75 MB on disk). The install honours the user's own uv policy: when the environment or a `uv.toml` forbids managed interpreters (`UV_PYTHON_DOWNLOADS=never`, `UV_NO_MANAGED_PYTHON=1`), `uv venv` fails and `/laya install` reports uv's error; the install never falls back to a system Python. Startup never downloads; the gateway runs with `HF_HUB_OFFLINE=1`. Until the gateway is ready, every ask fails `UNAVAILABLE`, so a consumer such as the model router keeps its manual route.

## Config

Every field is validated at load; unknown keys fail by name. Relative paths, a revision that is not a 40-character sha, and out-of-range limits fail by name.

| Key | Default | Effect |
|---|---|---|
| `model.repo` | required | Hugging Face repository of the pinned checkpoint. |
| `model.revision` | required | 40-character commit sha; the gateway project must hold `manifests/<revision>.json`. |
| `model.manifestSha256` | required | SHA-256 of that manifest's exact bytes. Install refuses a different manifest; the gateway must report the same digest in its readiness line and health check. |
| `checkpointContext` | required | `512` or `1024`; the gateway must report the same `maxSequenceTokens`. |
| `dtype` | `float16` | laya-mlx precision, `float16` or `float32`. |
| `runtimeDir` | `<SHRES_HOME>/runtimes/laya-gateway` | Holds the virtual environment, its uv-managed Python (`python/`), uv's package cache (`uv-cache/`), the install marker, and the gateway's working directory; created with mode 0700. |
| `hfHome` | `<runtimeDir>/hf` | Hugging Face home; the verified checkpoint lives in `<hfHome>/checkpoints/`. |
| `gatewayProject` | the repository's `python/laya-gateway` | Gateway project with `pyproject.toml`, `uv.lock`, and manifests. Set it when the package runs outside a repository checkout. |
| `uvPath` | `uv` | `uv` executable, an absolute path or a name on PATH. |
| `python` | `3.11` | Version of the uv-managed CPython installed into `<runtimeDir>/python` for the virtual environment. |
| `batchSize` | `16` | Questions per gateway inference batch; `maxBatchTokens` is `checkpointContext × batchSize`. |
| `startupTimeoutMs` | `120000` | Deadline for the readiness line; at most `600000`. |
| `requestTimeoutMs` | `2000` | Deadline for one judgment request, health check, or startup smoke ask. |
| `shutdownGraceMs` | `5000` | SIGTERM-to-SIGKILL grace when the gateway stops. |
| `installTimeoutMs` | `1800000` | Deadline for each install step, including the checkpoint download. |
| `maxRequestBytes` | `262144` | Request body cap, enforced by the provider before HTTP and by the gateway. |
| `maxResponseBytes` | `4194304` | Response body cap; at most 64 MiB. |
| `restart.maxRestarts` / `windowMs` / `backoffMs` / `maxBackoffMs` | `5` / `600000` / `1000` / `30000` | Crash restarts allowed per sliding window, with exponential backoff between them. |

`requestTimeoutMs` is this provider's backstop: it bounds every ask from a consumer that sets no deadline of its own, the health check, and the startup smoke ask, which is the first inference after the checkpoint loads. The model router's `judgmentDeadlineMs` (default `1500`) sits below this default, so the router cuts a slow routing ask and its decision records `engineFailure.code: 'DEADLINE'`. A timeout here reports `UNAVAILABLE`, the code this provider also uses for a gateway that is not ready or has exited, so it is the less specific classification of a slow ask. Keep `requestTimeoutMs` above the router's deadline.

## Composition

Mount the provider beside the dispatcher and select it with `defaultEngine: laya`, or with `judgment.engine: laya` in settings when another engine is the composition default. The subprocess service must be composed, and `/laya` registers when the command service is.

```yaml
- name: '@shres-code/shres-code-subprocess-local'
- name: '@shres-code/shres-code-judgment-dispatch'
  config:
    defaultEngine: laya
- name: '@shres-code/shres-code-judgment-laya'
  config:
    model:
      repo: convaiinnovations/laya-typed-decisions
      revision: 'f9ab0b228f0fc0f14d873dbc99038f135c2da1b2'
      manifestSha256: '028fa5c43482cf63c5d1ef8725c9cf9b196def71e39b8ea85647b3bddcf8f3bc'
    checkpointContext: 1024
- name: '@shres-code/shres-code-model-router'
  config:
    initialMode: off
    # candidates, thresholds, and instructions as the router README describes
```

The pinned checkpoint is the 1,024-token `laya-typed-decisions` model; its manifest is `python/laya-gateway/manifests/f9ab0b228f0fc0f14d873dbc99038f135c2da1b2.json`. Laya's routing accuracy is unmeasured, so routing thresholds tuned against another engine do not transfer.

## Lifecycle

The provider starts supervising when its service initializes. A launch checks, in order, that the host is darwin-arm64 (`unsupported-host` otherwise, without spawning), that the install marker matches the current `uv.lock` digest and pin (`not-installed` otherwise), and that the virtual environment exists. The gateway is spawned through `ctx.subprocess` with the scrubbed parent environment plus the Hugging Face offline switches; `PYTHONPATH`, `PYTHONHOME`, and `VIRTUAL_ENV` are removed.

Status becomes `ready` only after the gateway prints a readiness line naming the pinned model, manifest digest, and checkpoint context, answers `GET /healthz` with the same identity, and answers a smoke ask. A foreign model, manifest, or context, or gateway exit code 3 (manifest or checkpoint mismatch), leaves the provider `unavailable` without a restart. Any other exit publishes `unavailable` before a restart is scheduled; in-flight asks fail `UNAVAILABLE` at once. Restarts beyond the budget leave the provider `unavailable` until `/laya restart`. Each exit records `exitCode`, `signal`, `timedOut`, and the last 8 KiB of stderr independently.

Disposal clears status listeners, cancels a running install step, fails in-flight asks, sends SIGTERM to the gateway process tree, escalates to SIGKILL after `shutdownGraceMs`, and resolves once the tree has exited.

| Surface | Contract |
|---|---|
| `status()` / `onStatus(listener)` | Current and published `starting`, `ready`, `unavailable`, `not-installed`, `unsupported-host`, or `stopped`, with a detail naming the next action. Listener exceptions are logged. |
| Registry entry `laya` | Descriptor `egress: 'none'`, `calibration: 'calibrated'`, fitting, `host: 'darwin-arm64'`. Its status is the gateway status, except that `stopped` reports `unavailable` with the same detail; every gateway status change is announced to the registry's subscribers. The dispatcher answers an ask only while the status is `ready`. |
| `lastExit()` | The last exit's recorded facts. |
| `install(signal?)` | Stops the gateway, installs, and starts it again whether or not the install succeeded. Concurrent calls share one install. |
| `restart()` | Stops the gateway, resets the restart budget, and launches. |
| `/laya [status\|install\|restart]` | The same operations from the conversation UI; the command is not sent to the model. |
| Remote `laya.gatewayStatus` / `laya.installGateway` / `laya.restartGateway` | The same operations for configuration surfaces. `gatewayStatus` returns `LayaGatewayView`: the state and detail, the pinned `modelId`, `checkpointContext`, `dtype`, whether an install is running, and the last exit's code, signal, and deadline flag while the gateway is not ready (never its stderr). `installGateway` runs under the engine's lifetime, not the caller's connection; `restartGateway` returns the view once the restart began. Status changes also announce `judgment/engines-updated`. |

## Model Experience

### Judgment ask

#### What the model sees

The local gateway receives the redacted `state` and the consumer's `questions`, including each question's `instructions` and its choice options, score levels, or binary criteria. The pinned Laya checkpoint encodes the question head and state into at most `checkpointContext` tokens; the fitted ask judges the first offered state that fits without truncation. This provider contributes one fixed startup smoke question, `Is this text a startup check?` about the state `startup check`, and no other question wording, threshold, or conversation text.

#### Token effect

Each ask is one independent local inference whose input is bounded by `checkpointContext`. No conversation-model tokens are spent; the returned probabilities are not conversation tokens.

#### KV Cache effect

The ask is independent of the conversation model request and neither reads nor extends a conversation prefix. laya-mlx reuses encoded question prefixes inside the gateway process; a gateway restart discards them.

## Known Limitations and Deferred Work

- **Apple silicon only** — laya-mlx runs on darwin-arm64. Other hosts report `unsupported-host` and never spawn; they use a remote engine or a separately run Shield-wire gateway. A supervised CPU or CUDA gateway is deferred.
- **Routing accuracy is unmeasured** — the pinned checkpoint is a development baseline for routing; the owning plan's offline replay decides operating points. Confidence from the `choice:11+` temperature bucket is clamped upstream and uncalibrated.
- **Host is checked when a selection is written** — the dispatcher rejects a settings write that selects `laya` on another host; a composition whose `defaultEngine` is `laya` on another host reports `unsupported-host` for every ask.
- **Gateway project location** — the default `gatewayProject` is the repository copy; a published install must set it, because npm packages do not ship `python/`.
- **Install needs the network once** — `/laya install` downloads Python packages and about 850 MB of weights. After a verified install, launches run offline.
