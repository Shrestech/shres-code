# Agent Note: Researcher MVI — ledger seam, decision-rule verifier, and the autoresearch protocol

Status: implemented

## Problem

The researcher harness plan ([2026-08-24 long-horizon research](../../proposed/architecture/2026-08-24-researcher-harness-long-horizon-autonomous-research.md)) staged an autonomous researcher as tracker seam first, with the decision ledger, a mechanical verdict check, and a protocol composition to follow. The debate synthesis that preceded this change (architect/reviewer seat review of that proposal) fixed two amendments the shipped design had to honor: a "supported" verdict requires mechanical decision-rule re-execution before any reviewer interpretation, and the reviewer seats never hold gate authority — the harness's own [long-horizon uplift](../../proposed/feature/2026-08-25-long-horizon-harness-uplift.md) classifies judge-style verification as a gaming surface. Nothing in the tree recorded decisions, re-executed decision rules, or composed the cycle.

## Decision

Three pieces ship behind the researcher preset, each attached at documented extension points with no `agent-loop` change:

- **`packages/ledger/`** — the decision-ledger seam: `ctx.ledger` (`FileLedgerService`, JSONL store + query), `resolveRecord(request): LedgerSpec` enforcing the evidence contract (accepted/rejected require run ids that resolve through `ctx.tracker`; deferred cites none), branded `LedgerEntryId`, the ignorable `ledger/decision` event, and `tool-ledger` (`ledger_record_decision`, `ledger_query`). Request/spec split follows the tracker seam; failure reasons surface verbatim.
- **Tracker verifier** — `LogRunRequest` gains an optional `machineRule { metric, op, threshold }`, and `TrackerService.verifyDecisionRule(runId)` re-executes it against the run's logged metrics, returning satisfied/unsatisfied/refused with `refused` reasons (`run-not-found`, `no-machine-rule`, `metrics-missing`, `metric-not-in-run`). `experiment_verify_decision_rule` exposes it to the model. A run without a machine rule can never produce a mechanical `satisfied` — the fail-loud path pushes callers to log machine rules, not a guesser.
- **`packages/research/protocol`** — the `autoresearch` settings namespace (master `enabled`, default false, wired through `installSettingsSection` + live `sync()`/`watch()` semantics like the jspace consumers), the `research:protocol` prompt section (the cycle + verdict discipline), and the `tools/pre-execute` design-defense gate: while enabled and `requireDesignDefense: 'per-epoch'`, the gated tools refuse until the current Goal epoch — the jspace card's `goalOpenedSeq` when the seat is active, session start otherwise — holds a completed non-error call from every `debateTools` seat. The `./invariant` companion re-walks the log behind every denial and fails when a cited tool actually holds a completed call.

`apps/cli/config/agent-presets/researcher/` composes them on top of the full standard agent-plane surface (the host plane carries no model-facing tools): researcher persona, protocol (enabled), tracker + ledger in one shared realm (the ledger resolves cited runs through the tracker; spool-only provider — no credential, no token), `tool-goal`, and three `tool-subagent` instances (aegis/ward fork, stride spawn). J-Space stays host-owned to avoid the duplicate settings registration; the epoch anchor degrades to session start without it. The full-surface correction and its exact-catalog pin are recorded in [the full-agent-surface note](../bug-fix/2026-08-28-researcher-preset-full-agent-surface.md).

## Enforcement split

The gate proves a debate happened; the probe-downgrade rule for unresolved challenges stays prompt text. The mechanical verdict check is enforced where the log can prove it, with one honest boundary: `experiment_verify_decision_rule` is a `verifierTools` candidate, so a deployment setting `requireVerifiedEvidence: true` makes `jspace_ship` refuse an epoch with no completed verifier call — but evidence-grade means the verifier RAN, not that it returned `satisfied` (jspace grades the call, not the result payload). A deployment that needs satisfied-ness itself pins it at the snapshot/analysis layer until a result-aware evidence class exists. The snapshot pins the full chain: the run carries a machine rule, the verify call returns `satisfied`, and the checkpoint cites the verify call. Reviewer seats grade interpretation and contamination only, recorded on the card, never as gate authority.

## Alternatives considered

**Reviewer-seat verdicts as gate authority.** Rejected: the uplift plan's analysis and the forensics corpus classify judge gates as gaming surfaces; a reviewer ratifying evidence is a rubber stamp the model can farm. Reviewers inform; re-executed decision rules decide.

**Gating the tracker/ledger tools themselves off with the toggle.** Rejected: they are inert plumbing without the protocol loop, and per-consumer self-gating would spread toggle logic across packages for no enforcement gain. The toggle gates the protocol layer — section and gate — which is the researcher mode.

**Fork-only debate seats in the preset with a different model per seat.** Deferred to deployment: `agentOptions.model` is per-instance config, but no portable second-model default exists; the preset pins providers and tool names and leaves model diversity as an explicit deployment choice, documented in the preset.

## Consequences

A researcher session can now run the full micro-cycle — hypothesis on the card, seat debate enforced before any run is logged, runs with machine rules verified mechanically, decisions in the ledger with resolvable evidence, all under a user-owned toggle — with every model-visible surface reconstructable from the log and both new stores durable outside the session. The keyless `researcher-micro-cycle` headless snapshot replays one complete cycle (card → stub seat debate → spooled run with a machine rule → `experiment_verify_decision_rule` interpolating the minted run id through a `{{fromRequest}}` placeholder → ledger decision → evidence-grade checkpoint citing the log-run call → passing ship under `requireVerifiedEvidence`). The remaining researcher-harness stages (jspace v2 project scope, budget seam, autonomy guards) build on this surface.

## Testing

Per-file 100% coverage on `packages/ledger/*`, `packages/research/protocol/src`, and the touched tracker trees; the protocol package adds a real-Loader composition test, a settings-flip test through `FileSettingsProvider`, and gate tests that cover epoch re-arm, custom seat names, and the invariant's spurious-deny rejection. Catalogs (`gen-tool-catalog`, `gen-doc-graphs`, `gen-cordis-catalog`) and `verify-type-equiv` are regenerated and green. `packages/test-support/research-stubs` provides the keyless aegis/ward seats; `pnpm run test:snapshot -t researcher` replays the cycle with no API key. The `experiment_log_run` schema carries `machineRule` so the model — not only direct service callers — can log mechanically checkable runs; a review pass caught the original omission (schema dropped the field, the snapshot pinned the resulting refusal as success, and listing the plain log-run tool as a verifier laundered the gate) and folded the fixes in: pass-through schema, verifier-only verifierTools in the snapshot, and this corrected claim.

## Related

- [Researcher harness proposal](../../proposed/architecture/2026-08-24-researcher-harness-long-horizon-autonomous-research.md) — the staged plan this change advances.
- [J-Space evidence-grade checkpoints](../feature/2026-08-25-jspace-evidence-grade-checkpoints.md) — the executed-verifier class the verdict check plugs into.
- [Tracker seam stage 1](2026-08-24-researcher-tracker-seam-scaffold.md) — the seam the verifier extends.
- [Preset plugins resolve from the app dependency surface](../bug-fix/2026-08-28-preset-plugins-app-dependency-surface.md) — the dependency-declaration and gate fix that made this preset mountable outside the snapshot lane.
