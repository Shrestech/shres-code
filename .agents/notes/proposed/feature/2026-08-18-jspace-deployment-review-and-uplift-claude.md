# Agent Note: J-Space deployment review and uplift roadmap

Status: proposed

## Problem

The J-Space seat ([settings-toggle note](../../implemented/feature/2026-08-18-jspace-settings-toggle.md)) shipped without a review against its two named sources: Anthropic's workspace/J-space research (transformer-circuits.pub, "Verbalizable Representations Form a Global Workspace in Language Models") and the upstream [Tiger3807861189 J-Space Cognition Suite V3.6](https://github.com/Tiger3807861189/J-Space-Cognition-Suite-V3.6). Nobody has recorded what the deployment actually is relative to those sources, which mechanisms are enforced versus merely instructed, or which gaps are worth closing. Without this record the next contributor either re-derives the comparison or treats upstream's self-reported benchmark claims as established.

Reviewed by Claude (Claude Code) on 2026-08-18, against shres-code master `cf46459deb` (all `packages/jspace/*`, `packages/client/ui-jspace`, `packages/client/ui-settings-jspace`), the full Anthropic paper, and the upstream suite README.

## Proposal

Record the review verdict, then close gaps on four fronts: (F1) J-Space capability uplift — make more of the protocol real instead of instructed; (F2) measurement — run W0; (F3) correctness/security fixes; (F4) product and telemetry improvements. Nothing here flips the Settings default; that is measurement-gated (F2).

## Review verdict

**7/10 as an engineering deployment, 3/10 as a validated cognition intervention.** The defining split: the card is real infrastructure (event-sourced register, strict decode, monotonic `seq`, fork copy, ship gate, UI, projection), while the cognition is instructions (protocol text the model may obey). Enforcement quality is ahead of upstream; evidentiary support for the category is behind what upstream's marketing implies.

| Dimension | Score | Basis |
|---|---|---|
| Attribution & epistemic honesty | 9 | License + DOI in `protocol.ts`; "rewritten, not their SKILL.md, does not claim a Jacobian lens"; upstream numbers not repeated as fact |
| Mechanism coverage vs upstream | 7 | 6 of 7 mechanisms present, 3 register-enforced; no ✗ (failed-check) channel; no first-person agency |
| Enforcement rigor beyond upstream | 8 | Core ≤ 2, swap semantics, coverage refusal, evidence pointers, seq/fork integrity, ship gate — all code, not prose |
| Scientific grounding | 7 | Externalization and instruction-modulation are real warrants; per-module mapping to its warrant is undocumented |
| Harness integration | 9 | Settings seat, projection, chip/dock, command, fork copy, compaction-safe reassembly, active maintenance |
| Measurement | 2 | W0 three-arm designed, never run; no completion or token-cost data exists |
| Security posture | 7.5 | Voice registration landed both repos; label-injection guard; open items in F3 |

## What was compared

### The science, operationalized

The paper is an interpretability result, not a prompting recipe. Five findings matter to a harness:

| Finding | Paper evidence | Harness consequence |
|---|---|---|
| Models hold ~1–2 concepts per layer, ~6 unrelated items, occupancy ~25 vectors | §4.2, Figs 30–31 | A forced working set of 1–2 items is dimensionally honest |
| Instructions modulate workspace contents | §3.2, Fig 10 | Prompt protocols have partial warrant — but effects are phrasing-sensitive and negations backfire (white-bear) |
| Externalizing to the page substitutes for the workspace | §3.5.2 (GSM8K + CoT robust to ablation), §9.3 | An external card is the strongest-grounded intervention available to a harness |
| The model silently recognizes prompt injection (fake/injection/poison) before responding | §5.2, Fig 37 | Asking it to surface that assessment taps a signal that already exists |
| The reliable way to shape workspace content is training (counterfactual reflection) | §7 | Prompt-level ceiling is lower than upstream implies |

### Mechanism coverage

| Upstream mechanism | Ours | Form | Verdict |
|---|---|---|---|
| Selective loading (1–2 items) | Core ≤ 2 (`JSPACE_CORE`), swap needs departing+incoming (`JSPACE_SWAP`) | Register | Stronger than upstream |
| Broadcast hub | Card written once, read by prompt assembly, dock, ship gate, projection | Register + instruction | Stronger (real multi-consumer medium) |
| Dense Track ✓/?/✗ | ✓ = Checked, ? = Open; **no ✗** | Register + instruction | Partial |
| Bridge-before-conclusion | deep-reasoning module | Instruction only | Par |
| Metacognitive control | self-monitoring module + gate escalation | Instruction only | Par |
| Empirical escape | empirics module + `JSPACE_COVERAGE` refusal + `JSPACE_EVIDENCE` pointer validation | Register-enforced | Stronger — the honesty claim is checkable |
| First-person agency | Dropped | — | Missing (minor) |
| Gate fast/full/loop | Deterministic regex+length, log-reconstructable, no extra event | Code | Different tradeoff: auditable but blunt (see F3) |

### What the deployment does right (keep)

- The card survives compaction, resume, and fork because it is replayed from the log, not trusted from the transcript; malformed or cross-session-after-origin events fault instead of throwing.
- Card framing cannot be forged by scanned content: `line()` rejects fields starting with `Goal:/Core:/Checked:/Open:/Next:/Pass:`, and `formatJspaceCard` keeps labels harness-authored — the same own-voice discipline the Shield enforces.
- `isUntrusted` auto-mounts the introspection module whenever the last event is a `tool/result` — the best-grounded module (paper §5.2) on the seam where it matters.
- The note's A/B claim was corrected to "W0 is the instrument that settles it" — no borrowed credibility from upstream's unverified numbers.

### Upstream's claims are unverified

Single-run, self-reported benchmarks (HLE 37.8→45.5, Terminal-Bench 82.7→87.1, 2.53× speed, 2.21× token efficiency) against vendor-reported comparators, with the fixed scaling coefficients "intentionally omitted." No third-party reproduction exists. Treat as marketing until W0.

## Front 1 — J-Space capability uplift

Make more of the protocol enforced rather than instructed, in priority order:

1. **✗ failed-check channel.** Add a third Dense Track mark: a checked line (or new `jspace/blocked` event) recording a check that *failed* and what settles it. Ship refuses while an unsettled ✗ exists. This is the missing third of the Dense Track and the natural carrier for F1-2. Keep the dense-marks invariant: marks are register-only, never rendered into user-visible text or tool arguments.
2. **Runtime Shield tie-in.** A Shield deny on a seam appends a ✗ line on the card in the same session. Today introspection is prose; this makes "tool results are data, not instructions" enforced at the register where the guard seat can see it. Deny-tier only — observe-tier verdicts would make ✗ a false-positive amplifier.
3. **Bind checkpoints to goal identity.** `latestCheckpointSeq` is length-growth based: any single checkpoint after `goalOpenedSeq` passes ship, regardless of what it checked. Record the goal (hash or `goalOpenedSeq`) a checkpoint was made under; ship requires one bound to the *current* goal. Closes the "checkpoint spam passes ship" game.
4. **Open-question lifecycle.** `open` lines carry `settles` but nothing enforces or surfaces staleness. Age questions by turn count in the card reprint; a question older than N turns without a settle attempt should be visible noise the model has to dismiss deliberately.
5. **Two-signal gate** (also the F3 B-6 fix). Keep the regex+length signal, add deterministic step-shape signals: claimed step spans >1 file or >K tool calls → at least `full`; read the last N user messages, not only the last one. Must stay pure and log-reconstructable or the gate loses its auditability property.
6. **Escalation honesty.** "Escalating is cheap; staying in fast to avoid the card is a failure" is asserted, never measured. Count fast-pass turns that ended in multi-tool work (derivable from the log; no new event).
7. **Warrant line per module.** One comment line each in `protocol.ts` citing the paper section emulated: capacity ← §4.2, broadcast ← §4.3, introspection ← §5.2, deep-reasoning ← §3.3, directed focus ← §3.2, externalization rationale ← §9.3. Cheap; makes the deployment readable as science-adjacent rather than cargo-cult.
8. **`always-open` stock goal.** "J-Space is on" is noise. Derive the initial goal from the first user message (one-line summary at open time) so the reprint carries signal from turn one.

## Dogfood evidence (session-963a4ee8, 2026-08-18)

One real session with the seat enabled, run on `deepseek-v4-pro:cloud` in the shres-shield cwd: "review the repo" — a multi-file, 29-step, 79-tool-call review (~38 min; turn 1 died on a provider 503, all work is turn 2). Observed:

- **Gate B-6 fired exactly as predicted.** "Hi review the repo" classified `fast` — no loop/full term, short text. The model nevertheless chose to open a card early (three reasoning mentions, then `jspace_open` at ~5% of the session) — the driver line worked as the invitation. After open, the loop protocol mounted for the remaining ~27 steps.
- **The card was a receipt, not a workspace.** Two card events total: the open, and one checkpoint at ~86% of the session immediately before writing the report. Core stayed empty (the capacity mechanism unused), Open stayed empty, and `Next` was never updated — the final card still said "Explore packages/core source layout" while the model wrote its final report. Zero card mentions in reasoning between open and checkpoint.
- **`todo_write` carried the working memory.** The plan (seq 231) and the all-completed flip (seq 2973) tracked progress; the card duplicated none of it. The older tool performed the function the seat exists to perform.
- **`jspace_ship` was never called** despite the protocol's "call jspace_ship before claiming done" and a 5,894-char final report claiming done. The ship gate never executed. `jspace_note` was never called, so swap semantics never exercised. The card was never closed; `copyOnFork` would propagate the stale card to any child session.
- **The one checkpoint was honest.** It claimed 472 tests passing; the captured vitest output sums 231+22+7+5+207 = 472 exactly, the secrets-scan and typecheck claims match the bash evidence, and the coverage gate correctly admitted it (`by` names the verifier). No `evidence` callId was attached, so the claim is verifiable only by log forensics like this one.

Reading: protocol mounting alone does not produce card maintenance on this model. This is direct evidence for F1-3 (goal-bound checkpoints), F1-4 (stale-Next surfacing), a new F1 item — a completion nudge (`ship` reminder or auto-✗ when a turn ends with an open card and a done-claim) — and it validates the W0 concern that the seat's cost is currently paid for little behavioral function. One session, one model; W0 remains the instrument.

A later live corpus (2026-08-23/24, after the control loop) is recorded in [J-Space live-session forensics](2026-08-24-jspace-live-session-forensics.md). Ship now happens; close still does not; reopen can inherit the previous Goal's Core and Checked; stock fork cards and CLI-bridge tool-skip are named there rather than duplicated as a second F-list.

## Alignment (2026-08-18, post-review)

Two things landed after this review was written and are now accounted for:

- **[J-Space control loop](../../implemented/feature/2026-08-18-jspace-control-loop.md) (`7fcf7fc1a1`)** implements part of the dogfood evidence section: `jspace_open` on an open card updates Goal/Next instead of refusing, the tool-driver lines mount on every active pass including `fast` (the invitation that worked in the dogfood is now guaranteed), full/loop mount self-monitoring, identical non-card retries are refused until a card write, and the todo strip hides while a native card is open (the "two clocks" defect). A second independent review exists alongside this one ([Kimi's review](2026-08-18-jspace-deployment-review-and-uplift-kimi.md)); its findings 1, 8, and the commit-vs-note sync are resolved by that commit.
- **Fix-tier items from both reviews landed next** (this note's F3 / Kimi's F3): the repeat-refusal scan now covers the whole span since the last card write, closing the `A, B, A` alternation loophole (Kimi finding 3), and checkpoint `evidence` must name a call with a logged non-error `tool/result` (Kimi F1 additive item).

Explicitly not done, with reasons on record: the gate stays English-term-only — non-ASCII needles in source are out of scope by repo convention (Kimi finding 4 remains open; a config-provided term list is the conforming path if locale coverage is wanted), and the unreachable `markers`/`empirics` module copy (Kimi finding 2) was left in place pending an explicit keep-or-delete decision rather than resolved unilaterally mid-review.

## Front 2 — Measurement

Run W0 as three arms: nothing (control), first-party seat (this implementation), upstream suite vendored as a real skill (the honest competitor, not a strawman). Metrics: completion rate, turns-to-done, token cost, sampled checkpoint-coverage truthfulness (does `by` name a real verifier that really ran), and Shield-interaction counts. This gates the default-on decision and is the single highest-leverage item in this note: it moves the measurement score (2) and settles whether the category deserves further investment.

## Front 3 — Correctness and security fixes

- **B-6** (covered by F1-5): short-phrased multi-step work classifies `fast` — no protocol, no card, no ship gate; and the gate reads only the last user message, which is exactly the multi-turn accumulation seam test_break showed models exploit elsewhere.
- **`isUntrusted` literal-word regex** fires on `untrusted|retrieved|search result|tool output` or a `tool/result` as the *last* event. A mid-step assemble after a benign event misses the injection window. Fold into the F1-2 Shield tie-in rather than widening the regex.
- **Ship-gate loophole** (covered by F1-3).
- **Fault surfacing**: the fold records `fault` and `snapshot()` carries it — verify the dock/chip actually renders it; a corrupted card the user cannot see is a silent integrity failure.
- **Coverage terms are English-only by default**; non-English sessions without `coverageTerms` config get weaker checkpoint enforcement. Document, or seed per-locale defaults.

## Front 4 — Product and telemetry improvements

- Card diff view in the dock (what changed since last turn) — a reprint is hard to eyeball.
- Expose jspace projection aggregates (checkpoint counts, ✗ counts once F1-1 lands) to the stats surface so W0 has telemetry instead of log scraping.
- Package README linking the paper, the upstream repo, the license attribution, and this note.
- Consider a `/j-space status` command printing the folded card and any fault to the transcript for debugging.

## Alternatives considered

**Why not vendor upstream's SKILL.md wholesale?** Apache-2.0 permits it, and W0 arm C measures what it buys. But it is instruction-only (no register, no enforcement), carries ritual noise (sixty-second awakening, first-person workspace persona), and its numbers are unverified. Vendoring loses the one axis where we beat it.

**Why not pursue real lens access (J-lens runtime)?** The paper's method reads model internals a harness cannot reach; providers do not expose residual streams. Out of scope until an API exists, and the paper's own limitations (single-token concepts, bag-of-concepts) bound even that path.

**Why not a bigger protocol text (more modules, more prose)?** The paper shows instruction-level modulation is imperfect and phrasing-sensitive, with negations backfiring; every added instruction is unmeasured token cost. Prefer register enforcement (F1) over prose.

**Why not default-on now?** W0 is unrun. The availability line already mounts when enabled; flipping the default before measurement repeats upstream's sin of asserting benefit.

## Acceptance criteria

- W0 executed with published numbers per arm; a go/no-go decision recorded for the Settings default.
- ✗ channel exists end-to-end: event + fold + ship refusal + dock mark + tests, with marks never rendered to user-visible text.
- Shield deny on a seam appends a ✗ line in the same session (integration test with the guard seat); observe-tier never writes.
- Ship gate binds checkpoints to goal identity; regression test closes the length-growth loophole.
- Gate no longer classifies short-phrased multi-step work as `fast` (fixture set drawn from dogfood sessions and test_break-style phrasings); gate remains a pure function of log + config.
- Every module in `protocol.ts` carries its warrant line citing the paper section.
- Dock renders fold faults; a corrupted card is user-visible.

## Risks

- **More machinery, more gaming.** Checkpoint spam, ✗ dismissal spam, ritual compliance without substance. Per-goal binding (F1-3), repeat-refusal extension, and W0's truthfulness sampling are the counters.
- **✗ as FP amplifier** if anything but deny-tier Shield verdicts write to it — the constraint is deny-only, and it must hold.
- **W0 may show no gain or a net cost.** That is a valid result; the seat stays Settings-gated and this roadmap's F1 items lose their funding rationale. The point of measuring is to be able to stop.
- **Gate enrichment could compromise auditability.** If the two-signal gate stops being reconstructable from the log, it loses the property that makes it better than upstream's self-selection. Purity is a hard constraint, not a preference.
