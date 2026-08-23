# tracker/ — experiment tracking capability family

This family provides provider-neutral experiment run, metric, and query operations plus the model-facing tools that consume them. It is stage 1 of the researcher harness: the provider speaks live HTTP, with a durable local spool guaranteeing that a tracker outage loses zero run-records or metric appends.

| Package | Role | ctx key |
|---|---|---|
| [`tracker/`](tracker/README.md) | Defines the run/metrics/query vocabulary, the required-field validation contract, and the failure taxonomy | `ctx.tracker` |
| [`tracker-shrestech/`](tracker-shrestech/README.md) | Provides shrestech-tracker persistence: live `POST /api/runs`, a bulk `POST /api/sync` drain, a durable local spool, and a derived landed-run index | registers on `ctx.tracker` |
| [`tool-tracker/`](tool-tracker/README.md) | Exposes experiment run logging, metric append, and query to the model | registers on `ctx.tools` |

The offline posture is a mode, not an error path: with no credential reference, or with the tracker unreachable, a run is held in a durable local spool carrying the failure-taxonomy reason until it syncs. The `tracker/run` event carries the tool-call id of the `experiment_log_run` call that produced it, so every logged run is traceable to its originating call.
