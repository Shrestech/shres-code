# @shres-code/shres-code-tracker-shrestech

The shrestech-tracker **Service Provider** for the experiment tracking seam (`ctx.tracker`). It implements the seam's persistence hooks (`postRun`, `postMetrics`, `queryRuns`) over a durable local spool.

This package owns the Service Provider role of the experiment tracking capability. Stage 1 is offline-first by design: it defines the provider interface and a durable local spool, with **no live HTTP**. Live shrestech-tracker transport is stage 2.

## Config

| Field | Required | Default | Semantics |
|---|---|---|---|
| `baseUrl` | yes | — | Tracker base URL. An empty string fails loud at mount. |
| `lane` | yes | — | Per-lane scope; lanes carry distinct bearer credentials. An empty string fails loud at mount. |
| `credentialRef` | no | — | Reference to a credential in `ctx.credentials`. **Absent = spool-only mode**: runs are held locally and never posted, and that is not an error. |
| `spoolPath` | no | `$SHRES_HOME/tracker/<lane>.spool.jsonl` | Durable spool file location. |

Misconfiguration fails loud at mount only for empty `baseUrl`/`lane`. A missing `credentialRef` is never an error — it selects spool-only mode, the offline posture the plan requires for rented GPU pods that never hold tokens.

## Offline posture

A run post goes one of two ways in stage 1:

- **No credential reference** → spool-only: the run is appended to the durable local spool with reason `spooled` and never posted.
- **Credential reference present** → the run is attempted; with no live transport (stage 1) the attempt reports the tracker as `unreachable` and the run is spooled with that reason.

Either way the run is never lost and carries a failure-taxonomy reason the model sees verbatim. `replay()` drains the spool (deduplicating by run id, keeping the most recent) for a stage-2 sync path.

## The spool

`TrackerSpool` is an append-only JSONL file. `enqueue` appends one run post (flattened spec plus reason and enqueue time); `peek` reads current entries without draining; `replay` reads, deduplicates by run id, and drains. Because stage 1 has no authoritative landed store, `queryRuns` returns only runs still held in the spool.

## Known Limitations and Deferred Work

- **No live HTTP transport** — `attemptPost` always reports the tracker as `unreachable`; every post is spooled until stage 2 lands the real `POST /api/runs` and `/api/sync` path.
- **`postMetrics` is a no-op** — metrics are kept in the seam's session event log until the transport persists them.
- **`queryRuns` sees only pending spooled runs** — the tracker-derived index (which also holds landed runs) is stage 2.
- **Spool credentials are read through `ctx.credentials` in stage 2** — the reference is named here but no credential is resolved yet.
