# @shres-code/shres-code-tool-tracker

The model-facing **Consumer** for the experiment tracking seam (`ctx.tracker`). It registers three tools — `experiment_log_run`, `experiment_log_metrics`, and `experiment_query` — and owns their schemas, prompt guidance, and presentation, never provider selection or persistence.

## Tools

| Tool | Semantics |
|---|---|
| `experiment_log_run` | Log one run with its required `experiment`, `hypothesis`, `decisionRule`, `dataVersion`, and `gitSha` (plus optional `metrics`/`artifacts`). Requires an owning agent session (the run is logged to it). Returns the run id and land/spool status. The run's `tracker/run` event carries this call's tool-call id. |
| `experiment_log_metrics` | Append a batched `metrics` list to one run by `runId`. Requires an owning agent session. |
| `experiment_query` | Query runs by `experiment`, `gitSha`, and `since`, returning run ids and their land/spool status. |

## Failure taxonomy surfacing

A run that does not land returns a `spooled` status carrying the provider-post failure taxonomy (`auth`, `unreachable`, `quarantined-row`, or `spooled`) verbatim. The model-facing output and the rendered text both include the exact reason, so the model sees why a post did not land rather than a generic failure.

## UI render intent

Decided up front: **generic**. All three tools present via `presentCall` returning a `card: 'generic'` view; there is no terminal/diff or location rendering.

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`experiment_log_run`, `experiment_log_metrics`, and `experiment_query` schemas](../../../docs/tool-catalog.md#shres-codeshres-code-tool-tracker).

#### Token effect

Fixed schema cost on every request where the tools are visible.

#### KV Cache effect

Prefix-stable while the definitions and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Success returns exactly `Logged experiment run <runId>.`, `Run <runId> did not land at the tracker; held in the local spool (reason: <reason>).`, `Appended <n> metric point(s) to run <runId>.`, `No experiment runs found.`, or a list headed `Experiment runs:` of `- <runId> <experiment> <decisionRule> @ <gitSha>` lines with optional `(not landed: <reason>)`. `experiment_log_run` and `experiment_log_metrics` reject a caller without an owning agent session.

#### Token effect

Call arguments remain until compaction. Result text is small and scales with the query hit list.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **No concurrency-safety opt-in** — the tools make no `isConcurrencySafe` claim; sequential execution is the safe default until run-logging is proven idempotent.
