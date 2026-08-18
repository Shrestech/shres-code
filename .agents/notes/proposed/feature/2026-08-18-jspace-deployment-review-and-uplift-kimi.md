# Agent Note: J-Space deployment review and uplift roadmap (Kimi)

Status: proposed

## Problem

The J-Space seat shipped ([settings-toggle note](../../implemented/feature/2026-08-18-jspace-settings-toggle.md), [control-loop note](../../implemented/feature/2026-08-18-jspace-control-loop.md)) without an independent record of how it compares to its two named sources: Anthropic's global-workspace paper ([Verbalizable Representations Form a Global Workspace in Language Models](https://transformer-circuits.pub/2026/workspace/index.html)) and the upstream [Tiger3807861189 J-Space Cognition Suite V3.6](https://github.com/Tiger3807861189/J-Space-Cognition-Suite-V3.6) (Apache-2.0, DOI 10.5281/zenodo.21971181). A first review exists ([Claude's review note](2026-08-18-jspace-deployment-review-and-uplift-claude.md)); this note is a second, independent review, kept separate so the convergence or divergence of two reviewers stays visible.

Reviewed by Kimi (Kimi Code CLI) on 2026-08-18 against master `cf46459deb` plus the uncommitted control-loop working tree (all of `packages/jspace/*`, `packages/client/ui-jspace`, `packages/client/ui-settings-jspace`, bundles, examples, docs), the full Anthropic paper, and the upstream suite README.

## Proposal

Record the verdict and findings, then improve on four fronts the review motivates: (F1) capability uplift that converts instructed protocol into enforced protocol, gated on measurement; (F2) J-Space UI uplift; (F3) correctness and hygiene fixes; (F4) documentation and telemetry. Where a front overlaps Claude's note, this note says so and adds only what is new.

## Review verdict

**8/10 as harness engineering, 5/10 as a realization of the upstream suite, unproven on outcomes.** The deployment's real contribution is not the protocol text but the delivery machinery: the card is session state replayed from the log into every assembly, so the protocol cannot vanish on non-invocation, compaction, or non-compliance — the three failure modes that define the upstream skill's fragility. Enforcement is genuinely ahead of upstream (Core ≤ 2 with departing-line swap, coverage-term refusal, evidence must name an existing `tool/call`, ship gated on the goal epoch via `goalOpenedSeq`, single-writer copy-on-fork, fold faults on seq regression or foreign writes). Fidelity to upstream's mechanism inventory is deliberately shallow (no Dense Track, no first-person grammar, no awakening, bridge-before-conclusion reduced to two prompt lines), and the deployment says so. Neither this deployment nor upstream's single-run, vendor-mixed benchmark table proves the category helps; [W0](../../implemented/feature/2026-08-18-jspace-settings-toggle.md) remains the instrument that settles it.

Claude's note scored the same deployment 7/10 engineering and 3/10 as a validated cognition intervention. The two reviews converge on the same split — strong infrastructure, instructed cognition, absent measurement — which is itself the most reliable signal either review produces.

## Findings

Confirmed strengths (independent of the first review):

- Model-visible ⟺ logged holds: the gate is a pure function of the log and config; the card reprint is rebuilt from events on every assemble; `ignorable: true` keeps `SESSION_FORMAT_VERSION` at 0.
- Framing integrity is real: `line()` rejects fields that start with card labels, so logged content cannot impersonate the harness's `Goal:`/`Next:` voice, and malformed payloads fault instead of rendering.
- Attribution is honest: the NOTICE and DOI are present, the copy is a rewrite, and no Jacobian-lens claim is made.

Defects and gaps, each with its current state:

1. **`jspace_open` contract contradiction — fixed in tree, uncommitted.** At `cf46459deb` the model-facing description promised "replace Goal and Next when a card is already open" while the seat threw `JSPACE_ALREADY_OPEN` and the README documented rejection. The uncommitted control-loop work implements open-as-note (`packages/jspace/tool-jspace/src/index.ts`) and updates the note and README. Commit it; the defect is visible to the model on every auto-opened card until then.
2. **Dead module copy in the working tree.** `selectJspaceModules` no longer returns `markers` or `empirics`, but `JSPACE_MODULE_TEXT` and the registered sections keep them. Delete the copy or rewire the selection; an always-empty registered section is prompt surface that documents nothing.
3. **Repeat-refusal only compares the immediately previous tool call** (`packages/jspace/tool-jspace/src/retry.ts`): alternating `A, B, A` with identical arguments escapes the deny. If the intent is "no undiagnosed retry," the scan should not stop at the first different-name call.
4. **The gate is locale-blind.** `LOOP_TERMS` / `FULL_TERMS` (`packages/jspace/jspace-prompt/src/gate.ts`) match English only, and the 140/400 length thresholds carry no stated basis; the product ships zh locales. A Chinese multi-file request classifies `fast` and gets no protocol at all. Claude's F1-5 (two-signal gate) covers bluntness; locale coverage is additive to it.
5. **`coverageTerms` has no UI.** The settings schema and `ui-jspace/src/client/settings.ts` carry the field; `ui-settings-jspace`'s section does not edit it, and no doc says it is hand-edit-only.
6. **Copy drift across surfaces.** The toggle note says always-open opens on "the first assemble"; the settings locale says "first pre-step"; `ui-jspace/src/client/settings.ts` calls `always-open` "reserved for the prompt Consumer" while the Settings page exposes it as a user choice.
7. **Web-plane divergence.** `packages/bundle/web-app/cordis.patch.yml` keeps the jspace host rows process-wide while peer model-facing rows (`tool-goal`, `plan-mode`, `tool-bash`) moved behind per-session agent presets; no shipped preset references jspace. Confirm this is intent, not residue.
8. **Stray build artifacts in `src/`.** Untracked tsc output (`index.js`, `*.d.ts`, maps) sits in `packages/jspace/jspace/src/`, `packages/boot/*/src/`, and `packages/session/session-persistence-jsonl/src/`. Delete before an accidental commit; the tree gates assume `src/` is source-only.
9. **No user documentation.** No `docs/user/` page explains the switch, the card, or the honesty limits; the feature is discoverable only from package READMEs and catalogs.

## Front 1 — Capability uplift

Gated on W0 (Front 4 of Claude's note, which this note endorses as the highest-leverage item). Where the reviews agree — ✗ failed-check channel, ship gate binding checkpoints to goal identity, open-question aging, per-module warrant lines, escalation metrics — Claude's note owns the detail. Additive items:

- **Locale-aware gate and coverage terms.** Ship per-locale term sets as defaults, not only as `coverageTerms` config; a control plane that only fires in English is a control plane that is off for part of the product.
- **Evidence quality, not just existence.** `evidence` currently proves a `tool/call` id exists. A cheap strengthening: the named call must have a non-error `tool/result`. Still not proof of coverage, and the docs must keep saying so.
- **Decide the fate of `markers` and `empirics`** (finding 2): either restore selection where they earn tokens or remove them; keeping unreachable protocol copy invites drift between what the seat documents and what the model ever sees.

## Front 2 — J-Space UI uplift

- Edit `coverageTerms` from the Settings section (finding 5), with the coverage-honesty notice kept beside it.
- Surface fold `fault` in the dock and chip, not only in the Settings console: a corrupted card the user cannot see is a silent integrity failure (also in Claude's acceptance criteria).
- Align the three copies that describe when always-open opens (finding 6) and decide whether `always-open` is a user mode or a Consumer reservation.
- Dock diff affordance — what changed on the card since the last turn — as in Claude's F4; this note adds: show the current `Next` age in turns so a stale Next is visible, matching the open-question aging proposed for the register.

## Front 3 — Fixes

Commit or discard explicitly, none of these should linger in a dirty tree: the control-loop changes (finding 1), the dead module copy (finding 2), the retry-scan loophole (finding 3), the stray build artifacts (finding 8), and the web-preset decision (finding 7).

## Front 4 — Documentation and telemetry

- A `docs/user/` page for the feature: what the switch mounts, what the card costs (tokens, KV-prefix invalidation), and the two honesty limits (Checked is not Verified; evidence is not coverage).
- Projection aggregates (checkpoint counts, fault counts, pass distribution) exposed to the stats surface so W0 reads telemetry instead of scraping logs — convergent with Claude's F4.

## Alternatives considered

**Fold this review into Claude's note.** Rejected: the pair of independent reviews is the evidence; merging erases reviewer attribution and the convergence signal. Both notes stay cross-linked.

**Review only committed master.** Rejected: the working tree already resolves the largest defect found there (finding 1); reporting it as open would send the next contributor to fix a fixed bug.

**Implement the uplift directly instead of recording a roadmap.** Rejected: F1 spends tokens and prompt surface on an unmeasured intervention; W0 funds or kills it. F2/F3 are cheap enough to do without that gate.

## Acceptance criteria

- The control-loop working tree is committed or reverted; master no longer carries the `jspace_open` contradiction.
- `markers` and `empirics` copy is reachable or deleted; the retry-refusal scan's alternation loophole is closed or documented as intended.
- Gate classification and coverage terms have per-locale defaults, with fixtures proving a zh multi-file request does not classify `fast`.
- The Settings section edits `coverageTerms`; dock and chip render fold faults; the three always-open copies agree.
- `packages/jspace/jspace/src/` and siblings contain no committed build artifacts.
- A `docs/user/` J-Space page exists and `doc-sync` passes.
- W0 runs and records a go/no-go for any F1 register expansion; this note is then implemented or rejected on that evidence.

## Risks

- Two live review notes can drift apart as the code moves. Mitigation: this note cites Claude's for shared items instead of restating them; whichever review's items land first should absorb or reject the other's remainder explicitly.
- Uplift without measurement repeats upstream's unverified-claims pattern in first-party clothing. The W0 gate on F1 is the control.
- The UI front can grow into a second dashboard competing with GoalBar and the todo strip; the [control-loop note](../../implemented/feature/2026-08-18-jspace-control-loop.md) already chose one-clock, and UI additions should extend the card, not parallel it.

## Related

- [J-Space as a Settings-toggled harness card](../../implemented/feature/2026-08-18-jspace-settings-toggle.md) — the shipped seat decision.
- [J-Space control loop](../../implemented/feature/2026-08-18-jspace-control-loop.md) — open-as-note, tool-driver lines, diagnosed retry, todo hide.
- [J-Space deployment review and uplift roadmap (Claude)](2026-08-18-jspace-deployment-review-and-uplift-claude.md) — the parallel first review; shared items live there.
