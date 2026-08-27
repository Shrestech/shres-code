# Agent Note: Bench report multi-arm comparisons, pressure stratum, and forensics

Status: implemented

## Problem

The bench ladder grew to six arms, a `pressure` task stratum, and forensics plus compaction trial metrics, but the report builder still paired only `off` vs `on`, dropped unknown strata to `long`, and omitted the new aggregates from arm summaries. The static dashboard therefore could not show `on-adaptive`, pressure tasks, or dangling-card / session-query / compaction columns.

## Decision

`ReportData` carries `comparisons[]`: one `off` vs treatment record per non-baseline arm in the experiment directory, each labeled with `treatment` and holding its McNemar grade, accuracy delta, and per-task `pairs`. The singular `comparison` field and the top-level `pairs` array are gone; this is a pre-release format change with no compatibility shim.

The report catalog accepts `pressure` as a stratum. `summarizeArm` / `summarizeCell` add forensics and compaction aggregates (`meanDanglingCard`, `meanVerifiedCheckpointShare`, `meanSessionQueryCalls`, `totalNoopNoteRefusals`, `totalCompactionCount`, `pressureFiredRate`, and the matching cell fields). The UI renders one hero banner and one scatter/delta pair per comparison, colors and filters the pressure stratum, and shows the new columns on the arms table. The demo generator emits `on-adaptive`, the four pressure tasks, and non-zero compaction metrics.

## Alternatives considered

**Keep a singular `comparison` plus a treatment picker.** Rejected: a live experiment already runs `off` against several treatments at once; burying all but `on` would hide the ladder the suite exists to measure.

**Leave aggregation in `report/build.js` and leave `bench/stats/aggregate.js` unchanged.** Rejected: `summarizeArm` / `summarizeCell` already own the ReportCell and ReportArmSummary fields; a second fold would drift.

**A `pairsByTreatment` map next to the old `comparison` object.** Rejected: an array of labeled records matches how the UI walks treatments and needs no leftover singleton.

## Consequences

Every consumer of `ui/data.js` must read `comparisons[]`. An experiment that lacks an `off` directory produces an empty `comparisons` array and still builds. The demo experiment now includes six arms and the pressure stratum so the dashboard can be exercised without an API key.

## Testing

`node --test bench/tests/*.test.js` covers a two-arm build (one comparison), a three-arm pressure-stratum build (off vs on and off vs on-adaptive, with forensics totals), `validateReportData` rejecting a non-array `comparisons` field and a baseline `treatment: "off"`, and the UI fixture against the new payload. `node bench/demo/generate.js && node bench/report/build.js --experiment demo` rebuilds `bench/ui/data.js` without error.

## Related

- [Five-arm bench ladder and forensics metrics](2026-08-25-bench-arm-ladder-and-forensics-metrics.md) — owns the arm overlays and trial-level forensics fields this report projects.
- [Forced-compaction pressure overlays](2026-08-25-forced-compaction-pressure-overlays.md) — owns `compactionCount` / `pressureFired` and the experiment-level overlay.
- [J-Space chain gym and report UI v2](2026-08-18-jspace-chain-gym-and-report-v2.md) — owns the zero-build dashboard this extends.
