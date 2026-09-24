# UI contract — bench/ui/

Static, zero-build, zero-dependency report. `index.html` loads `data.js` (generated, gitignored) then ES modules. Hash routing (`#summary`, `#matrix`, `#charts`, `#trials`); filter and sort state lives in the URL hash query so a view is shareable by link. All rendering is DOM/SVG built in JS — no framework, no canvas, no fetch.

## Data

`data.js` sets `globalThis.BENCH_REPORT` to a `ReportData` record (see `bench/schema/report-data.js`, validated at generation time). UI code reads that global; it never fetches.

`ReportData.comparisons` is an array of `off` vs treatment pairings, one record per non-`off` arm in the experiment (`treatment`, `grade`, `deltaAccuracy`, `mcnemarP`, `pairs`). There is no singular `comparison` field and no top-level `pairs` array.

`ReportData.verdicts` is optional: the pre-registered Jev verdict block, one record per hypothesis (`{ id, rule, arms, status, outcome, reason, observed, threshold, ci95, trials, facts }`), graded by `report/verdicts.js` from the embedded trials. A record is either `evaluable` with `outcome`, `ci95`, and `trials`, or `not-evaluable` with a `reason` and no outcome; the schema rejects anything in between. Each arm's `results.json` carries the subset whose `arms` name it.

Extended fields the UI tolerates (both optional):

- `tasks[].stratum` may be `"chain"` (multi-session tasks) or `"pressure"` (memory-pressure tasks), in addition to `long` / `short` / `adversarial`.
- `trials[]` may carry `phases`: `{ phaseIndex, sessionFile, resumedFrom, exitCode, timedOut, metrics: TrialMetrics, startedAt, endedAt }[]` — the per-phase breakdown of one chain trial (`resumedFrom: null` means a cold start) — and `integrity`: `{ violations: string[] }`, present only when non-empty.
- Arm summaries may carry forensics and compaction aggregates (`meanDanglingCard`, `meanVerifiedCheckpointShare`, `meanSessionQueryCalls`, `totalNoopNoteRefusals`, `totalCompactionCount`, `pressureFiredRate`, and the matching cell fields). A `null` mean means the arm excludes that metric.
- Arm summaries and cells may also carry the Jev routing/compaction aggregates (`meanCacheHitShare`, `cacheHitShareNullTrials`, `meanCacheUnreportedShare`, `meanModelTransitions`, `routingDecisionTrials`, `meanDowngradedShare`, `meanKeptStrongShare`, `meanDowngradedStreakLongest`, `totalDowngradedRuns`, `totalRoutingHintCount`, `compactionVerificationTrials`, `totalJevCompactionAcceptedBelowThreshold`, `totalJevSelectionDegraded`). A `null` mean or total means no trial in the group recorded that datum; the three trial counts are never null. The headline arm table renders a fixed column set and does not show these.

The hero banner's bootstrap interval and the matrix subtotals are recomputed in the UI from embedded trials. serve.js roots the static report at `bench/ui`, so the browser cannot import `bench/stats`; `model.js` mirrors the seeded mulberry32 PRNG, the paired percentile bootstrap, the Wilson interval, and the outcome pairing from `bench/stats/{intervals,paired}.js` and must stay algorithm-equivalent to them.

## Palette (styles.css custom properties)

- Layered surfaces: `--bg` (page), `--surface` (panel), `--surface-2` (raised), `--surface-3` (hover/inset); borders `--border` / `--border-strong`; chart gridlines `--grid`.
- Ink: `--text`, `--muted`, `--faint`.
- Arm colors: `--arm-off: #8fa1ba` (slate), `--arm-on: #4c8dff` (blue); extra arms cycle `--arm-x1..x4` (`#c084fc`, `#22d3ee`, `#fb923c`, `#f472b6`).
- Outcome scale: `--heat-bad: #f87171`, `--heat-mid: #fbbf24`, `--heat-good: #34d399`. Matrix cells interpolate red→amber→green by pass rate (model.js mirrors the anchors numerically — keep them in sync); missing data is neutral gray with `—`.
- Semantic: `--warn` (integrity badge, demo chrome), `--ok`, `--info` (chain badge).
- Scales: spacing `--space-1..6`, radius `--radius-sm/md/lg`, shadows `--shadow-1/2`, type `--font-xs..2xl`. Every chart color comes from these properties.

## charts.js API (SVG builders; pure functions returning SVGElement)

```js
/** Grouped bars with CI whiskers. series: [{name, color, values: number[], ci?: [number,number][]}] */
export function groupedBarChart({ categories, series, yLabel, yMax, formatValue }) -> SVGElement

/** Paired scatter; one point per task, x = off value, y = on value; diagonal tie line. */
export function pairedScatter({ points /* [{id, x, y}] */, xLabel, yLabel }) -> SVGElement

/** Radar over strata or metric groups. series: [{name, color, values}] */
export function radarChart({ axes /* string[] */, series, max }) -> SVGElement

/** Horizontal delta chart: one bar per category centered on 0, colored by sign. */
export function deltaChart({ items /* [{id, delta, ci: [number,number]}] */, xLabel }) -> SVGElement

/** Axis-less sparkline for stat cards. series: [{name, color, values: number[]}]; shared y domain, optional yMin/yMax pins. */
export function sparkline({ series, width, height, yMin, yMax, formatValue }) -> SVGElement
```

Charts must render axis labels (sparkline excepted), a legend (sparkline excepted), and tooltips via `<title>`. Sizes are viewBox-based and scale with the container.

## Shell (index.html + app.js)

Sticky top bar: brand, then `#experiment-meta` (experiment name, generated-at, `demo` badge, comparison grade chip — populated by app.js, hidden without a usable payload), then the view nav as a segmented control. `#demo-banner` still shows for `demo: true` payloads. `document.title` tracks the active route and experiment.

## Views (app.js routes)

1. **Summary** — one hero comparison banner per treatment arm (grade chip, Δ accuracy with paired-bootstrap CI, McNemar p with wins/losses/ties, token overhead ratio), stat cards with mini sparklines (cumulative per-arm accuracy trend; per-trial token spend), and the per-arm table (`accuracy% ± stderr`, Wilson CI text + inline CI bar, total tokens, mean turns, duration, delta vs `off`, dangling-card rate, verified-checkpoint share, mean session-query calls, noop-note refusals, compaction count, pressure-fired rate).
2. **Matrix** — tasks (rows, grouped by stratum — long, short, adversarial, chain, pressure — with a pooled subtotal row per stratum) × arms (columns); cell = heat-colored pass rate with `m/n`; bold the best arm per row when its interval excludes the other's point estimate; chain tasks carry a `⟲ chain` badge and pressure tasks a `pressure` badge; click a cell to jump to filtered Trials.
3. **Charts** — grouped bars with CIs per task; one paired scatter pair (pass rate and tokens) and one delta chart per comparison; per-stratum radar; plus, when chain tasks exist, a **Chain phases** section: a chain-task picker (`phaseTask` in the hash query) with grouped bars of per-phase mean input tokens and duration per arm.
4. **Trials** — filterable table of every trial (arm, task, stratum, trial index, resolved, failure mode, tokens, turns, duration). Column headers sort (click cycles asc → desc → none; `sort`/`dir` in the hash query, ties fall back to task/trial-index/arm order). Trials with `integrity.violations` carry a warning badge and a highlighted row. The expander shows verifier command/exit/detail, session file, metric summaries including forensics and compaction, any violations, and — for trials with `phases` — a per-phase table (tokens with an inline bar, turns, duration, exit code, timed-out, `resumedFrom` shown as `cold` when null).

Accessibility: charts carry `role="img"` and an accessible name; tables are real `<table>` elements; sortable headers expose `aria-sort`; the inline CI bar is `role="img"` with a label.
