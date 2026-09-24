# Agent Note: Local Laya judgment with a supervised laya-mlx gateway

Status: implemented

## Problem

The model router consults `ctx.judgment` at the first step of every turn. With the TypeSafe provider, each consult sends up to 12,000 characters of recent conversation to a third-party API and waits a median of 704 ms on the request's critical path; in one live session on this branch, 17 consults produced 0 downgrades. The owner requires routing judgments to run locally, with no conversation data sent to a remote judge and no silent fallback to one. The existing [Shield judgment provider](../../../../packages/llm/judgment-shield/README.md) already speaks a loopback wire, but it deliberately neither starts nor supervises the model runtime ([owned Shield judgments](2026-09-23-owned-shield-judgments.md)), so a deployment had no shipped way to run a local judge.

## Decision

[`@shres-code/shres-code-judgment-laya`](../../../../packages/llm/judgment-laya/README.md) provides `ctx.judgment` by supervising one loopback gateway, [`python/laya-gateway`](../../../../python/laya-gateway/README.md), that runs a pinned Laya checkpoint through laya-mlx on Apple silicon. Answers travel over the existing Shield wire: `createShieldWireEngine` is extracted from `judgment-shield` into `src/client.ts`, and both providers bind the same client, so request caps, cancellation classification, bounded reads, and answer validation have one home. `judgment-shield` behavior is unchanged; its 42 existing tests pass at 100% coverage.

**Sequencing.** The routing redesign plan places this provider after an engine registry that lets a settings section switch engines at runtime. That registry does not exist yet, so this provider extends `JudgmentService` and a composition mounts it in place of `judgment-typesafe`. Its lifecycle state (`starting`, `ready`, `unavailable`, `not-installed`, `unsupported-host`, `stopped`) is already a published status with listeners, which is the shape a registry entry needs.

**Gateway.** `python -m laya_gateway serve` verifies every checkpoint file's size and SHA-256 against `manifests/<revision>.json`, loads the checkpoint, requires its `max_len` to equal the manifest's `checkpointContext`, binds `127.0.0.1` on port 0, and prints one readiness line carrying the port, model id, manifest digest, and token limits. It maps binary, choice, and score questions to Laya's `noul`, `choice`, and `score` types and renormalizes returned distributions. `/v1/judgments/fitted` judges the first state whose every question sequence and padded batch fit without truncation, measuring with laya-mlx's own sequence builder; a question head or option Laya would truncate refuses the ask as `head` or `option`, and the gateway re-measures the selected state immediately before inference. Requests must be JSON with a length and a Host header naming the gateway's own loopback address. Inference is serialized, and request bodies are never logged.

**Supervision.** Launch checks the host (darwin-arm64), the install marker against the current `uv.lock` digest and pin, and the virtual environment, in that order. `ready` is published only after the readiness line, a health check, and a smoke ask all report the pinned identity. A foreign model, manifest, or checkpoint context, or gateway exit code 3, is terminal; any other exit publishes `unavailable` before a restart is scheduled, fails in-flight asks at once, and restarts with exponential backoff inside a budget. Disposal clears listeners, cancels a running install step, fails in-flight asks, terminates the process tree, escalates to SIGKILL after the grace period, and waits for exit. The gateway environment is the subprocess seam's scrubbed parent plus `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, and `PYTHONNOUSERSITE=1`, with `PYTHONPATH`, `PYTHONHOME`, and `VIRTUAL_ENV` removed.

**Install and offline policy.** Installation happens only on request, through `/laya install` or `install()`: `uv venv --python 3.11`, `uv sync --frozen` against the hash-locked `uv.lock` (both with `UV_CACHE_DIR=<runtimeDir>/uv-cache`, `UV_PYTHON_INSTALL_DIR=<runtimeDir>/python`, and `UV_PYTHON_PREFERENCE=only-managed`, so the environment runs on a uv-managed CPython inside the runtime directory and the runtime directory holds everything an install downloads), a download of exactly the manifest's files at the pinned revision, SHA-256 verification (a mismatched download is deleted), and an atomically written marker. A user uv policy that forbids managed interpreters (`UV_PYTHON_DOWNLOADS=never`, `UV_NO_MANAGED_PYTHON=1`, or a `uv.toml`) makes the install fail with uv's error; the install neither overrides that policy nor falls back to a system Python. Startup never downloads. A missing or stale install reports `not-installed` and the router keeps its manual route; no remote engine answers instead.

**Pin.** The pinned checkpoint is `convaiinnovations/laya-typed-decisions@f9ab0b228f0fc0f14d873dbc99038f135c2da1b2` with a 1,024-token context; manifest SHA-256 `028fa5c43482cf63c5d1ef8725c9cf9b196def71e39b8ea85647b3bddcf8f3bc`; weights SHA-256 `4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e`. laya-mlx loads these upstream PyTorch weights directly and converts them in memory. The third-party MLX conversion `aac6fef/laya-typed-decisions-mlx` is therefore not used; its `benchmarks/results/hub-publication.json` names this same source revision (`f9ab0b22`), and its publication `f9e501c2` adds only documentation after its converted-weights commit `28416e78`. On 2026-09-24 the Hugging Face head of the pinned repository was `1a793eb5`, whose five pinned files match the manifest (the weights by LFS SHA-256, the rest by size); the commits since `f9ab0b22` change the model card only.

**Fidelity and latency on the owner's machine** (Apple M2 Max, 32 GiB, macOS 15.7.9, Python 3.11.14, mlx 0.32.2, laya-mlx 0.2.0):

| Check | Result |
|---|---|
| laya-mlx `benchmarks.validate` against upstream Laya `573e5b62` on MPS, FP32 | 63/63 argmax agreement, maximum probability error 3.4e-6 (tolerance 1e-4), 16/16 public results equal |
| Same, FP16 | 63/63 argmax agreement, maximum probability error 1.8e-3 (tolerance 2e-2) |
| Stability | 100 repeated calls deterministic, no memory growth |
| Gateway startup to readiness line | 1.09 s (FP16) |
| Routing-shaped fitted ask, 5-option route plus 5-level difficulty, 21-token state | gateway P50 41.2 ms, P95 45.5 ms; client P50 44.1 ms, P95 53.1 ms (FP16, n = 200) |
| Same with a 793-token state | gateway P50 271.6 ms, P95 286.0 ms; client P50 278.1 ms, P95 293.3 ms (FP16) |
| FP32, short and long states | client P50 50.9 ms and 337.4 ms |

The checkpoint ships a `choice:11+` temperature outside laya's calibrated range, which upstream clamps; confidence for choices with 11 or more options is uncalibrated. Routing accuracy is unmeasured: fidelity establishes that laya-mlx reproduces Laya, not that Laya routes well.

**Upstream tracking.** The gateway depends on the PyPI release `laya-mlx==0.2.0`, hash-locked in `uv.lock`. Its sdist and wheel were compared file by file with upstream commit `0a859518634112655cb97c745dbf04f5191aaf13` of `mizorewww/laya-mlx` (the port's v0.3.5 sync) and are identical, including `pyproject.toml`, `NOTICE`, and `LICENSE`. The `parthmstech/laya` and `parthmstech/laya-mlx` forks carry no commits of their own and serve only as patch staging. `pnpm run check:laya-upstream` reports drift between these pins and PyPI, the pinned Hugging Face repositories, and the upstream source heads; a pin bump is its own change carrying a fresh fidelity check and offline routing replay.

**Attribution.** `THIRD_PARTY_NOTICES.md` lists laya-mlx and huggingface-hub as direct gateway dependencies, and MLX, Laya, and the pinned checkpoint in a local-runtime section that reproduces laya-mlx's NOTICE verbatim. The generator fails when a checkpoint manifest names a repository without disclosure metadata, or when a runtime component's pin disappears from its owning file.

## Alternatives considered

**Supervise the gateway inside `judgment-shield`.** The Shield provider's contract is a pure wire client for a deployment-run service, and other deployments rely on that. Adding process ownership would change its lifecycle for every consumer; a separate provider that shares the extracted wire client keeps one wire implementation without changing that contract.

**Pin the third-party MLX conversion `aac6fef/laya-typed-decisions-mlx`.** It adds a converter's publication to the supply chain without adding capability: laya-mlx loads the upstream weights directly, and the fidelity check ran on exactly those weights.

**Download the checkpoint on first start.** An unrequested 850 MB download and network access at startup conflict with the local-first, explicit-install requirement, and would make startup time depend on the network.

**Fall back to TypeSafe when the local gateway is unavailable.** The owner requires that no conversation data reach a remote judge. An unavailable engine keeps the manual model, which is the router's existing failure policy.

**Build the environment on whichever Python the machine has.** A system or globally installed Python makes the install depend on that interpreter's patch version and on its continued presence: an OS upgrade or `uv python uninstall` elsewhere breaks the virtual environment, and deleting the runtime directory leaves the interpreter behind. Installing a uv-managed CPython into the runtime directory costs a 20–40 MB download on first install (CPython 3.11.15 occupies 75 MB on disk); it is paid for removability and reproducibility.

**Bind a fixed port.** A fixed port races with other processes and with a restarting gateway. Port 0 plus a readiness line reporting the bound port has no race.

**Depend on the forks.** They carry no commits of their own, so pinning them adds staleness without adding content; the PyPI release is verified byte-identical to the upstream commit.

## Consequences

A deployment on Apple silicon can route with no judgment egress and a per-consult cost of roughly 45 ms for short routing states, against a median of 704 ms for the remote engine. The price is an explicit install (Python packages and about 850 MB of weights), a supervised Python process, and a 1,024-token judgment window that holds far less conversation than the remote engine's 12,000 characters. Other hosts report `unsupported-host` and never spawn. Runtime engine switching waits for the engine registry and settings section.

## Testing

- Supervisor tests drive a fake gateway process through readiness, identity and manifest refusal, startup timeout, crash and restart, restart-budget exhaustion, in-flight ask failure on crash, disposal with SIGKILL escalation, and status-listener containment.
- Installation tests cover the preflight states, the install command sequence and marker, refusal of a mismatched manifest before any command runs, and command-runner cancellation versus deadline.
- A real Loader composition installs through `/laya install` with fake `uv` and interpreter scripts, then routes a turn with the gateway as `ctx.judgment` and checks the decision, the request header, and the fitted request the gateway received.
- `tests/laya.e2e.ts` installs the pinned checkpoint for real and answers a fitted routing ask through laya-mlx; it self-skips unless the host is Apple silicon and `LAYA_E2E_RUNTIME_DIR` is set.
- The gateway's pytest suite runs against a stub backend, with an `integration` mark that exercises real laya-mlx.
