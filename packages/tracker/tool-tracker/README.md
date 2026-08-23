# @shres-code/shres-code-tool-tracker

The model-facing **Consumer** for the experiment tracking seam (`ctx.tracker`). It registers three tools — `experiment_log_run`, `experiment_log_metrics`, and `experiment_query` — and owns their schemas, prompt guidance, and presentation, never provider selection or persistence.

## Tools

| Tool | Semantics |
|---|---|
| `experiment_log_run` | Log one run with its required `experiment`, `hypothesis`, `decisionRule`, `dataVersion`, and `gitSha` (plus optional `metrics`/`artifacts`). Requires an owning agent session (the run is logged to it). Returns the run id and land/spool status. |
| `experiment_log_metrics` | Append a batched `metrics` list to one run by `runId`. Requires an owning agent session. |
| `experiment_query` | Query runs by `experiment`, `gitSha`, and `since`, returning run ids and their land/spool status. |

## Failure taxonomy surfacing

A run that does not land returns a `spooled` status carrying the provider-post failure taxonomy (`auth`, `unreachable`, `quarantined-row`, or `spooled`) verbatim. The model-facing output and the rendered text both include the exact reason, so the model sees why a post did not land rather than a generic failure.

## UI render intent

Decided up front: **generic**. All three tools present via `presentCall` returning a `card: 'generic'` view; there is no terminal/diff or location rendering.

## Model Experience

Tool results retain bounded run data — the run id, the filter fields, and the exact spool reason — while schemas and descriptions carry the required `decision_rule`/`data_version`/`git_sha` ritual. The seam's `tracker/run` and `tracker/metrics` events (written by the service) keep every logged run reconstructable from the session log.

## Known Limitations and Deferred Work

- **`experiment_query` reads only the provider's stage-1 spool view** — it cannot see landed runs until the tracker-derived index lands with stage 2.
- **No concurrency-safety opt-in** — the tools make no `isConcurrencySafe` claim; sequential execution is the safe default until run-logging is proven idempotent.
