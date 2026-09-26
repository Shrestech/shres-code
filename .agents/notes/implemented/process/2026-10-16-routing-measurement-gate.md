# Agent Note: The routing measurement gate

Status: implemented

## Problem

The PR 16 routing measurement decides whether cold-point routing with a local judge reduces strong-model tokens without meaningful task loss, and default-on must stand on a gate that cannot drift, be silently relaxed, or pass on missing data. The earlier pilots drifted from their own preregistrations by recomputing results by hand, and their suites could not tell a measured zero from an uninstrumented default. The decision rules live in the preregistration, [`bench/routing/prereg-2026-10.md`](../../../../bench/routing/prereg-2026-10.md); this note records the build decisions and what they supersede (plan §5 details where they differ, notably arm N as a bench-only seeded engine and the idle-gap cap). It supersedes no other active Agent Note; bench pricing stays owned by [the priced-accounting note](2026-09-24-bench-priced-accounting.md).

## Decision

The gate is a module, not a convention. H1–H5, the Holm family, the screens, and the power reading live in `bench/analysis/routing-gate.js`; the replay's discrimination, calibration, the coverage and entry-rate denominators, and the operating-point search live in `bench/analysis/replay-metrics.js`; both are the executable authority and a changed rule is a new experiment name.

The ECE bin count and the operating-point tie-break are required explicit arguments of `computeReplayMetrics` with no defaults, and the result's `method` block (bin count, tie-break, row-semantics version) is what the registration records, so the method a calibration used is readable from the file it calibrated.

Calibration has exactly one writer and one machine flag. `bench/routing/write-registration.js` finalizes the registration atomically and one-shot: a passed replay gate writes `replayGate: 'passed'` plus the `enforced` block (`calibratedBy`, threshold, margin, `entryRate` = `realizedREntryRate` = the chosen point's eligible-row rate, seed) and generates the confirmatory R and N overlays into an output directory, never over the committed provisional overlays; a failed gate records the metrics and no calibrated id anywhere. `bench/routing/registration-phase.js` is the one reader of the lifecycle phase: `replayGate` (absent, `'failed'`, or `'passed'`) is the single authoritative flag, `status` is frozen at `"preregistered"` with the fixed `authorizes` note, and both the writer and the runner's confirmatory guard refuse any file where flag, status, and enforced block disagree.

Arm N's judge is a workspace package, `@shres-code/shres-code-judgment-bench-random`, following the engine-seam pattern: its draw is `hashDraw(seed, correlation)` — an FNV-1a mix of the seed with the ask's `sessionId` and `consultKey` — so every draw replays from the decision log alone, an ask without correlation fails closed `UNAVAILABLE`, and the package carries an invariant companion like the other engines.

Provisional pins never claim calibration. The committed arm overlays carry placeholder points with no `calibratedBy` (the router logs them as `point`, not `calibrated`), and the confirmatory guard requires the replay-qualified phase with exact overlay equality, including arm N's rate equal to arm R's realized eligible-row entry rate.

Idle gaps are capped, not discarded: L1/L2 realize `min(drawn, 20 minutes)` and keep the drawn value in the trial record, so the over-1-hour stratum is visibly truncated and the report names it unmeasured. Arm T never runs shadow with live children: it composes `initialMode: on` with no judgment service, main consults keep with `engine-absent` (or `warm-prefix`), and the audit requires zero main downgrades with at least one routed child per delegating task. Model ids are pinned by provenance: the strong arms hand-declare `anthropic/claude-opus-5-5` (metered-key API acceptance stays unproven until the owner-approved first run), and the cheap route is the proven `deepseek-v4-flash` billed through the `2026-09-26` alias snapshot row; published snapshots are never edited.

## Alternatives considered

Recomputing the gate math by hand in the report — rejected, because that is how the pilots drifted from their own preregistrations. Defaulting missing robustness counters to zero — rejected, because it would let an uninstrumented run pass its own gate; absent sources hold the screen null, and null refuses a PASS. A bench-relative plugin file for arm N's judge — rejected, because pinned overlays are path-free and emitted verbatim across machines, so only a workspace package follows the engine-seam pattern. Shipping `calibratedBy` on the provisional points — rejected, because in the router that key's presence alone marks a point calibrated, which would misrepresent a gate that has not run. Discarding over-cap gaps — rejected in favor of the recorded cap, so the truncation stays measured and named. Shadow with live children for arm T — rejected, because shadow promises no request is rewritten, children included. Trusting unproven model ids — rejected in favor of provenance pinning and the keyless pricing and composition preflights.

## Consequences

Every calibration fact is readable from the registration plus the overlays it generated, and the writer and runner share the phase reader, so flag, status, and enforced block cannot diverge silently. The measurement itself has not run: the replay front end's consult-input half waits on the router's `replayConsultInput` handoff (the pure row labeller and fixtures exist), and every real-spend run, the level choice, and default-on remain explicit owner decisions recorded outside the registration. Coverage that depends on stored experiment data (`bench/runs/**`) is data-local and passes only where that uncommitted data exists.
