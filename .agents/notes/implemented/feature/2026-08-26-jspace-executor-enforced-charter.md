# Agent Note: J-Space executor-enforced charter

Status: implemented

## Problem

[W0 pressure results](../../proposed/testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md#pressure-results-2026-08-26) show the card as an offer the model may take up: Core was empty on every snapshot in all 20 engaged card sessions across w6 and w7, and 7 of 8 engaged w7 failures shipped on a verifier-blind "tests green" line. [Constraint capture](2026-08-26-jspace-constraint-capture.md) then required a Core line; w8 still failed the qty class with the six house rules held verbatim on Core (`off` 7/16 vs `on-core` 6/16). Visible prose does not survive contact with generation. The [contract plan](../../proposed/feature/2026-08-26-jspace-contract-and-harness-hardening.md) items 1–5 name the missing executor-run checks: typed commands the harness runs, not another presence check on Core.

## Decision

The charter is a typed list on the same `jspace/card` snapshot as Core, not Core itself. Core stays the two-item working-memory stage. Each entry is `kind: 'check'` (a foreground bash command with named `reads` and an optional content `failProbe`) or `kind: 'prose'` (reprinted; it does not pass ship). Folded checks carry `discrimination: 'demonstrated' | 'unverified'`. Commands stay on the snapshot so checkpoint and ship re-run without the model. The fold defaults a missing `charter` field to `[]` so older snapshots stay readable. `openGoal` keeps the charter across a Goal change; `jspace_note` does not edit it; `amendCharter` replaces the list.

Enablement is tool-Consumer `Config`, all default-off: `requireCharter`, `requireExecutableCharter` (implies `requireCharter`), `charterSeed`, `charterDiscrimination` (`'off'` / `'best-effort'` / `'required'`; `'required'` implies `requireExecutableCharter`), `charterCheckTimeoutMs` (default 30000), `maxCharterEntries` (default 12, max 32), `charterChecksMustBeReadOnly` (default true). Load throws on those implications, on a non-positive `charterCheckTimeoutMs`, on an out-of-range `maxCharterEntries`, and when `requireCharter` composes with seat `mode: 'always-open'`. A missing `ctx.fs` while discrimination is `'required'` fails at the first probe. A missing `bash` tool fails at the first charter run.

A non-empty charter always runs at checkpoint and at ship, regardless of `requireCharter`. Presence implies execution. Nested dispatch is `ctx.tools.execute` of the registered `bash` tool with the parent token of the in-flight `jspace_*` call (`callId` `${parent}:charter:${entryId}`). The path is not `ctx.shell.run`. Checks run sequentially. Ship always re-runs; `readsFingerprint` is recorded on `jspace/charter-run` and never gates a skip.

The mechanical floor rejects constant-success commands, reads that escape session cwd, vacuous globs, unparseable quotes, write-token commands when `charterChecksMustBeReadOnly` is true, and a `failProbe.path` outside `reads`. Glob expansion uses Node `fs.glob` resolved against session cwd. Discrimination applies the `failProbe` mutation, runs the command, then restores the original bytes (unlink for a created file; `writeText` for an edited one). Restore failure is harness I/O, not a charter refusal. `'required'` refuses when the command still passes, when policy denies the probe, when it times out, or when the glob has no subject.

Seeding writes `jspace/charter-proposal` from the first human `user` message during prompt-section evaluation (order 43, before `jspace:charter-seed` at 44), using the loop's claimed messages. The agent loop assembles the system prompt before `agent/pre-step`, so a pre-step-only seed would miss the first `request/header`. A prepended `agent/pre-step` listener remains as backup when assemble did not run. Extraction prefers a `## House rules` / `## Constraints` / `## Standing rules` section, else consecutive numbered items, else `[]`. Matching items upgrade through the constraint-survival-build catalog to helper commands `node tools/check-house-rules.mjs <rule> …` with `reads: ['src/m*.js']`. The prompt section `jspace:charter-seed` reprints the proposal until the card carries a charter. `kind: accept-proposal` expands first, then explicit adds; an id collision refuses. `jspace_checkpoint` / `jspace_ship` synthesize `check` / `by` when the model omits them (`charter e1,…` / `charter-run of N checks`). A passed `jspace/charter-run` is evidence-grade.

The fixture helper `bench/tasks/constraint-survival-build/fixture/tools/check-house-rules.mjs` implements the six house-rule checks. Model-authored-check measurement is out of scope.

Code Mode is unsupported for charter. pwsh charter dispatch is deferred. Approval UX is unchanged. Compaction pointers, close hygiene, max-turns, and default tool timeout remain in the [contract plan](../../proposed/feature/2026-08-26-jspace-contract-and-harness-hardening.md) (items 6–12). The `on-charter` bench arm overlay is not in this change; w9 does not start without it.

## Alternatives considered

**Keep house rules on Core and strengthen reprint.** Rejected by w8: verbatim Core prose did not change the qty failure class, and six rules cannot live in a two-item stage.

**Privileged `ctx.shell.run` from jspace.** Rejected: that skips `tools/pre-execute` (permission, sandbox), monotonic guards, and executor timeouts. Nested `ctx.tools.execute('bash')` is the only dispatch.

**Runtime heuristic for "this task has constraints."** Rejected in the contract plan: enablement is composition config. A classifier would be uncalibrated in the same way coverage-term gates were.

**Skip ship when `readsFingerprint` matches.** Rejected: the fingerprint is recorded and does not skip a re-run.

**Seed prose only and measure model-authored checks.** Rejected for the constraint-survival-build catalog: the fixture helper is the check that would have caught w7's qty class. A model-authored-only arm remains a valid later measurement, not this default.

**Put charter fields on the seat.** Rejected: `always-open` and `/j-space on` write a stock card with no model confirmation of the seed. The requirement is how the model drives the tools.

**Parallel check runs.** Rejected: sequential keeps output and parent-token accounting simple; `maxCharterEntries` 12 is the bound.

**Seed only on prepended `agent/pre-step`.** Rejected: the agent loop assembles the system prompt before `agent/pre-step`, so a pre-step seed misses the first `request/header`. Seeding during the order-43 section provider uses claimed messages at assemble time.

**A session-wide "allow charter checks" approval preset.** Deferred: inherit-policy is the sandbox promise; the preset is product work.

## Consequences

A deployment that sets `requireCharter` / `requireExecutableCharter` / `charterDiscrimination: 'required'` / `charterSeed` cannot open, checkpoint, or ship without executable checks that have been shown to fail a seeded violation, at the cost of nested bash at every checkpoint and at ship. Default-off compositions behave as before. Prose-only charters reprint and do not pass ship. Hollow `echo ok` and `node --test` checks fail the floor or discrimination.

Keyless coverage: `packages/jspace` unit and e2e suites, plus the `jspace-charter` / `jspace-charter-pass` headless snapshots. ACP fixtures do not pin the seed or refusals.

The [constraint-capture](2026-08-26-jspace-constraint-capture.md) Core presence gates stay in force and stay a separate decision. The contract plan stays proposed for items 6–12 and for graduating any of this to a shipped default; that graduation is the w9 McNemar contrast in the [W0 note](../../proposed/testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md#w9-pre-registration), which this change does not run.
