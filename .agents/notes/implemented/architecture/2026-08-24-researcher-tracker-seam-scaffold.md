# Agent Note: Researcher tracker seam stage 1 — offline-first scaffold

Status: implemented

## Problem

The researcher harness plan ([2026-08-24 long-horizon research](../../proposed/architecture/2026-08-24-researcher-harness-long-horizon-autonomous-research.md)) commits to an experiment-tracking capability seam as its first stage: Service Definition `ctx.tracker`, a provider, and model-facing tools, with a failure taxonomy (`auth`, `unreachable`, `quarantined-row`) the model sees verbatim and a durable local spool so a tracker outage loses zero run-records. Nothing in the harness today records an experiment run against the binding truth the plan assumes.

## Decision

Stage 1 scaffolds the complete three-package seam under `packages/tracker/`, all offline-first with no live HTTP (that is stage 2):

- **`@shres-code/shres-code-tracker`** — the Service Definition. `TrackerService` (abstract, `ctx.tracker`) exposes `logRun`/`logMetrics`/`queryRuns`; providers implement the persistence hooks `postRun`/`postMetrics`/`queryRuns`. `resolveLogRun(request): LogRunSpec` is the pure exported defaulting/validation step: it rejects missing `experiment`/`decisionRule`/`dataVersion`/`gitSha` with a named `TrackerError` and defaults `metrics`/`artifacts` to empty. `TrackerRunId` is branded; every run gets an id even when spooled. The failure taxonomy type `TrackerFailureReason` and the result union (`landed` | `spooled` + reason) let the tool surface why a post did not land. `logRun`/`logMetrics` write the log-only `ignorable` events `tracker/run` and `tracker/metrics` (declaration-merged into the session event map).
- **`@shres-code/shres-code-tracker-shrestech`** — the Provider. `ShrestechTrackerService` mounts as `ctx.tracker`; config `baseUrl`/`lane` (required, empty-string fails loud) and optional `credentialRef`/`spoolPath`. Missing `credentialRef` is spool-only mode, never an error. `TrackerSpool` is an append-only JSONL file; `replay()` drains and dedupes by run id. `attemptPost` returns `'unreachable'` until stage 2 swaps in real HTTP.
- **`@shres-code/shres-code-tool-tracker`** — the Consumer. Registers `experiment_log_run`, `experiment_log_metrics`, `experiment_query` with a `generic` UI render intent, surfacing the spool reason verbatim.

Request/spec split follows `shres-shell`: the seam resolves once via `resolveLogRun` and provider `run()` paths never re-default.

## Alternatives considered

- **Route `logRun` through the tool consumer** (so the tool owns event-writing and call-correlation) — rejected: the seam's concrete methods own event-writing so validation and logging never vary by provider, matching the jspace precedent where the service writes and the tool passes the session.
- **Return a bare `TrackerRunId` from `logRun`** — rejected: the model must see *why* a post did not land, so `logRun` returns a `TrackerRunResult` carrying the failure reason; the id is present in every arm.

## Consequences

Stage 2 (live `POST /api/runs` and `/api/sync`) replaces `attemptPost` with real transport, persists metrics, and adds a tracker-derived `queryRuns` index over landed runs. Per-file 100% coverage gates each src file; the spool's drain/append contract is covered through temp-directory round-trips.
