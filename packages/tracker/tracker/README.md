# @shres-code/shres-code-tracker

The **`TrackerService`** (`ctx.tracker`) defines WHAT experiment tracking the harness has — log a run, append metrics, query runs — without binding the model contract to one tracker's API shape.

This package owns the Service Definition role of the experiment tracking capability. It is stage 1 of the researcher harness seam; the provider and tool roles live in sibling packages:

| Package | Role |
|---|---|
| `@shres-code/shres-code-tracker` (this) | Service Definition: the service contract, run/metrics/query vocabulary, the required-field validation and spec step, the failure taxonomy |
| `@shres-code/shres-code-tracker-shrestech` | Provider: durable local spool (stage 1), live shrestech-tracker HTTP (stage 2) |
| `@shres-code/shres-code-tool-tracker` | Consumer: the model-facing `experiment_log_run` / `experiment_log_metrics` / `experiment_query` tools |

The seam follows the [capability seam](../../../docs/glossary.md#capability-seam) definition: a Service Definition / Service Provider / Consumer trio, complete, never one role.

## Service API (`ctx.tracker`)

| Member | Semantics |
|---|---|
| `logRun(session, request)` | Validate the request, allocate a branded `TrackerRunId`, delegate to the provider, and write the log-only `tracker/run` event. Returns the post outcome — the id is always present, with a failure reason when the run was spooled. |
| `logMetrics(session, runId, metrics)` | Append a batched metric point list to a run's durable record and write the log-only `tracker/metrics` event. |
| `queryRuns(filter)` | Query the provider's authoritative run store; filters on experiment, git sha, and since are optional. |

Providers implement the abstract persistence hooks `postRun`, `postMetrics`, and `queryRuns`; the seam's concrete `logRun`/`logMetrics` own defaulting, id allocation, and event logging so validation and logging never vary by provider.

## Request/spec split

`logRun` accepts a `LogRunRequest` and resolves it through the pure, exported `resolveLogRun(request): LogRunSpec`. That step rejects every required field (`experiment`, `decisionRule`, `dataVersion`, `gitSha`) that is absent or blank with a named `TrackerError` (`TRACKER_REQUIRED_FIELD`), and defaults `metrics`/`artifacts` to empty lists. Providers and `run()` paths never re-default — they receive an already-resolved spec.

## Vocabulary

`LogRunRequest` (`experiment`, `hypothesis`, `decisionRule`, `dataVersion`, `gitSha`, `metrics?`, `artifacts?`) → `TrackerRunResult`. A result is either `{ kind: 'landed', runId }` or `{ kind: 'spooled', runId, reason }`; the `reason` is the provider-post failure taxonomy — `auth`, `unreachable`, `quarantined-row`, or `spooled` — surfaced verbatim so the model sees why a post did not land. `queryRuns` returns `TrackerRunSummary[]`, whose spooled entries carry the same reason.

## Session events

`logRun`/`logMetrics` write the log-only, `ignorable` events `tracker/run` and `tracker/metrics` (declared by declaration merging in `src/types.ts`). A run that is spooled still carries its id in the event, so a replay can follow the run to its spool entry.

## Model Experience

Indirectly, through `@shres-code/shres-code-tool-tracker`, which retains bounded run results and the exact spool reason while this seam contributes no prompt or schema itself.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Mechanical verdicts read the mounted provider** — `verifyDecisionRule` resolves the run and its metrics through `getRun`/`getMetrics`; after a sync drains the metric spool, landed metrics live server-side and `verifyDecisionRule` refuses with `metrics-missing` — the derived stores deliberately do not mirror server state.
