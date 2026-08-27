# Agent Note: Researcher tracker seam stage 1 — offline-first scaffold and live-HTTP round-trip

Status: implemented

## Problem

The researcher harness plan ([2026-08-24 long-horizon research](../../proposed/architecture/2026-08-24-researcher-harness-long-horizon-autonomous-research.md)) commits to an experiment-tracking capability seam as its first stage: Service Definition `ctx.tracker`, a provider, and model-facing tools, with a failure taxonomy (`auth`, `unreachable`, `quarantined-row`) the model sees verbatim and a durable local spool so a tracker outage loses zero run-records. Nothing in the harness today records an experiment run against the binding truth the plan assumes.

## Decision

Stage 1 builds the complete three-package seam under `packages/tracker/`, then completes its live-HTTP round-trip so a run provably lands end-to-end:

- **`@shres-code/shres-code-tracker`** — the Service Definition. `TrackerService` (abstract, `ctx.tracker`) exposes `logRun`/`logMetrics`/`queryRuns`; providers implement the persistence hooks `postRun`/`postMetrics`/`queryRuns`. `resolveLogRun(request): LogRunSpec` is the pure exported defaulting/validation step: it rejects missing `experiment`/`decisionRule`/`dataVersion`/`gitSha` with a named `TrackerError` and defaults `metrics`/`artifacts` to empty. `TrackerRunId` is branded; every run gets an id even when spooled. The failure taxonomy type `TrackerFailureReason` and the result union (`landed` | `spooled` + reason) let the tool surface why a post did not land. `logRun`/`logMetrics` write the log-only `ignorable` events `tracker/run` and `tracker/metrics` (declaration-merged into the session event map). `logRun` accepts the originating tool-call id, which the `tracker/run` event carries so every logged run is traceable to its `experiment_log_run` call.
- **`@shres-code/shres-code-tracker-shrestech`** — the Provider. `ShrestechTrackerService` mounts as `ctx.tracker`; config `baseUrl`/`lane` (required, empty-string fails loud) and optional `credentialRef`/`spoolPath`/`indexPath`. Missing `credentialRef` is spool-only mode, never an error. `TrackerSpool` is an append-only JSONL file over two paths (runs and metric appends); `replay()`/`replayMetrics()` drain and dedupe by run id. Live HTTP posts a run to `POST /api/runs` with the resolved spec plus run id and a bearer token resolved per operation through `ctx.credentials`; `sync()` drains both spools through `POST /api/sync` and records accepted runs in a derived landed-run index (`LandedRunsIndex`) so `queryRuns` answers without a network round-trip. A network failure or 5xx maps to `unreachable`, a 401/403 to `auth`, and any unexpected status fails loud. The token never appears in configuration, logs, or events.
- **`@shres-code/shres-code-tool-tracker`** — the Consumer. Registers `experiment_log_run`, `experiment_log_metrics`, `experiment_query` with a `generic` UI render intent, surfacing the spool reason verbatim. `experiment_log_run` threads its tool-call id into `logRun`.

Request/spec split follows `shres-shell`: the seam resolves once via `resolveLogRun` and provider `run()` paths never re-default. The `/api/sync` endpoint assumption — one `POST {runs, metrics}` returning `{ landedRunIds }`, with the server deduplicating by run id — is documented in the provider README and enforced by fail-loud shape validation at the durable→wire boundary.

## Alternatives considered

- **Route `logRun` through the tool consumer** (so the tool owns event-writing and call-correlation) — rejected: the seam's concrete methods own event-writing so validation and logging never vary by provider, matching the jspace precedent where the service writes and the tool passes the session. The tool still supplies the `callId` for the `tracker/run` event.
- **Return a bare `TrackerRunId` from `logRun`** — rejected: the model must see *why* a post did not land, so `logRun` returns a `TrackerRunResult` carrying the failure reason; the id is present in every arm.
- **Persist metrics with a direct POST per append** — rejected: metrics batch into the same `/api/sync` as runs, so a run and its metrics land atomically on one drain instead of splitting the transport contract.

## Consequences

Stage 1 now proves the live round trip: a run with a credential reference posts over real HTTP, a non-landing run is held durably with its taxonomy reason, `sync` drains runs and metrics together and re-enqueues only what did not land, and `queryRuns` answers from the derived index without a network call. The git run-record remains the binding truth; the landed index is derived and rebuildable. Per-file 100% coverage gates every src file; the spool drain/append, the transport mapping, and the index are covered through mocked fetch and temp-directory round-trips, plus an env-gated e2e test is available when `TRACKER_BASE_URL` is set.

The surface grew in the [researcher MVI](2026-08-28-researcher-mvi-ledger-verifier-protocol.md): runs carry an optional machine-readable `machineRule`, the service gained `getRun`/`getMetrics` retrieval hooks, and `verifyDecisionRule` re-executes the rule mechanically — the shrestech provider implements the retrieval from its spool and landed index.
