# @shres-code/shres-code-tracker-shrestech

The shrestech-tracker **Service Provider** for the experiment tracking seam (`ctx.tracker`). It implements the seam's persistence hooks (`postRun`, `postMetrics`, `queryRuns`) over a durable local spool and a live HTTP transport, plus a `sync` bulk drain and a derived landed-run index.

This package owns the Service Provider role of the experiment tracking capability. It is offline-first by design: the durable local spool guarantees no run or metric append is lost when the tracker is unreachable, and a run with no credential reference is held locally without error.

## Config

| Field | Required | Default | Semantics |
|---|---|---|---|
| `baseUrl` | yes | — | Tracker base URL. An empty string fails loud at mount. |
| `lane` | yes | — | Per-lane scope; lanes carry distinct bearer credentials. An empty string fails loud at mount. |
| `credentialRef` | no | — | Reference to a credential in `ctx.credentials`. **Absent = spool-only mode**: runs are held locally and never posted, and that is not an error. |
| `spoolPath` | no | `$SHRES_HOME/tracker/<lane>.spool.jsonl` | Durable run-spool file location. |
| `indexPath` | no | `$SHRES_HOME/tracker/<lane>.landed.jsonl` | Durable landed-run index location. |

Misconfiguration fails loud at mount only for empty `baseUrl`/`lane`. A missing `credentialRef` is never an error — it selects spool-only mode, the offline posture the plan requires for rented GPU pods that never hold tokens. A `credentialRef` set without a loaded credentials service fails loud at the first post, the earliest resolvable point.

## Live HTTP

A run with a credential reference is posted with a real HTTP request:

- **`POST {baseUrl}/api/runs`** with the resolved run spec plus the run id, carrying `Authorization: Bearer <token>`. The token is resolved per operation through `ctx.credentials` from `credentialRef` and never appears in configuration, logs, or events.

Outcome mapping matches the seam's `TrackerFailureReason` taxonomy: a network failure or any 5xx maps to `unreachable`, a 401/403 to `auth`, and any other unexpected status fails loud (thrown) rather than being silently swallowed. A landed post is recorded in the derived index and never spooled; an `unreachable`/`auth` post is held in the run spool with that reason.

## The spool

`TrackerSpool` backs two append-only JSONL files: the run spool (flattened spec plus reason and enqueue time) and the metric spool (run id plus points). `enqueue`/`enqueueMetrics` append; `peek`/`peekMetrics` read without draining; `replay`/`replayMetrics` read, deduplicate by run id (keeping the most recent), and drain.

## Bulk sync drain

`sync()` drains both spools and posts **`POST {baseUrl}/api/sync`** with the replayed runs and metric appends. A successful sync marks the runs the response's `landedRunIds` array names as landed (recorded in the derived index) and drops their metric appends; runs the server rejects — and the metric appends belonging to them — are re-enqueued to the spool so no run or metric is lost or double-posted. On a network failure / 5xx / 401 / 403 the whole batch is re-enqueued. Runs are never sent twice: `replay` drains before the post, and the server deduplicates by run id.

## Metric persistence

`postMetrics` holds each metric batch in the metric spool and drains it with the run spool on the next `sync`, so metrics persist exactly when their run lands. The endpoint assumption — one `/api/sync` that accepts `{ runs, metrics }` and returns `{ landedRunIds }` — is fixed in the provider; a payload or response that does not match it fails loud with a `TrackerError` rather than silently dropping data.

## The landed-run index

`LandedRunsIndex` is an append-only JSONL file recording every run the transport confirmed landed, so `queryRuns` returns landed runs with no network round-trip. The tracker (and the git run-record in production) remains the binding truth; this index is derived from run/sync outcomes and is rebuildable — `reset()` wipes it for a clean re-derivation.

## Query semantics

`queryRuns` merges landed runs from the index (no `reason`) with pending runs from the run spool (with their `reason`), filtering by `experiment`, `gitSha`, and `since` (against `landedAt` for landed runs and `enqueuedAt` for spooled runs).
