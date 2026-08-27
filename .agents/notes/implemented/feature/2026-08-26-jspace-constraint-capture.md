# Agent Note: J-Space constraint capture

Status: implemented

## Problem

The J-Space card exists to carry what a task states once through the context loss that follows compaction. Two forced-compaction experiments measured whether it does. In the [W0 pressure results](../../proposed/testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md#pressure-results-2026-08-26) — `w6-compaction-2026-08-26` (4 pressure tasks × `off` / `on` / `on-adaptive` × 2) and `w7-build-confirm-2026-08-26` (`constraint-survival-build` × the same 3 arms × 8), both on Z.ai GLM-5.2 under `bench/pressure/forced-compaction.patch.yml` — Core was empty on every card snapshot in all 20 engaged card sessions. The tasks state six house rules once in the prompt; not one session wrote a rule onto the card. 11 of 12 w7 sessions instead checkpointed a verifier-blind "tests green" line, and 7 of 8 engaged failures shipped on that line before the constraint verifier would have failed. The modal failure was identical across arms: one subtle constraint application in `m04-bin.js`.

The outcome followed: `on` passed 3/8 against `off` 5/8 in w7 (McNemar `tie`, p = 0.625) at 1.64× the input tokens, and 7/8 against 6/8 in w6. A tie at n = 8 is not evidence the card hurts, but the token cost is real and the mechanism finding is not statistical — as prompted, the card is used for goal restatement and ritual checkpoints, never for the one job that justifies its cost.

## Decision

Constraint capture is pressure on the two card operations that decide whether Core is ever populated, shipped as two `tool-jspace` `Config` fields, both defaulting to `false`. No shipped composition changes.

`requireCoreOnOpen` refuses a `jspace_open` that would create the card unless it carries at least one `core` item:

> jspace_open requires at least one core item. Core carries the once-stated constraints, standing rules, and invariants this work must honor through context compaction, and it is the only card field reprinted whole. Re-read the task statement for them and pack related rules into one line; Core holds at most two.

The refusal names the cap because the seat rejects a third item and rejects a JSON array packed into one slot, so "write every rule" is not satisfiable advice; packing related rules into one line is. Core is also the only card field the prompt Consumer reprints whole — `checkedReprintLimit` and `openReprintLimit` bound Checked and Open at 5 — which is why it is the right carrier and why the refusal says so.

The gate applies only to the call that creates the card. The seat applies `core` on the first open and ignores it when `jspace_open` replaces Goal and Next on an open card, so gating that path would refuse a call the model cannot satisfy.

`requireCoreForShip` refuses `jspace_ship` while Core is empty, which is also the state a Goal change leaves behind:

> jspace ship on a card whose Core is empty certifies nothing: the card carries no constraint the work was held to. Write the once-stated constraints and standing rules this work honored onto Core with jspace_note, or, when the task states none, the acceptance criterion it is measured against.

It joins `shipRefusal` as a `ShipRefusalOptions` field beside `requireVerifiedEvidence`, checked after the Goal and Next content checks and before the checkpoint check — an empty Core is a card-content failure, like an empty Next, not an evidence failure.

### Model-visible text

`jspace_open`'s description and its `core` parameter now name Core as the home for the standing rules and invariants a task states once, and the closed-card driver in `jspace-prompt` asks for them at open time. The open-card driver's existing "a changed Goal clears Core and Checked" clause continues with "so restate the standing constraints there", because the epoch reset is the moment the constraints silently leave the card. Each addition is one clause: these strings are priced on every request of an engaged session.

### Measurement

Bench arm `on-core` registers as `on` plus both requirements. It contrasts against `on`, not `on-sq`, because w6 and w7 measured the empty-Core failure on the card alone. `renderArmOverlay` grew a `tool-jspace` patch block for arms carrying a `toolJspace` config; the seat and the tool Consumer own separate plugin entries, so a single `jspace` overlay could not reach these fields.

## Alternatives considered

**Put the fields on the `jspace` seat, beside `requireVerifiedEvidence`.** Rejected: the seat's `open()` serves `/j-space on`, which opens a stock card with no Core, so a seat-level requirement would refuse the human command. The requirement is about how the model drives the tools, which is what the tool Consumer owns.

**Validate what Core says, not that it exists.** Rejected: nothing in the harness knows which sentences of a task statement are constraints, and a keyword rule would teach padding — the ritual-compliance failure the [evidence-grade checkpoints](2026-08-25-jspace-evidence-grade-checkpoints.md) work already ran into. Presence pressure plus explicit prompt text is the proportionate step; the arm measures whether it is enough.

**Ship both requirements on by default.** Rejected: w6 and w7 are ties at n = 8. A default flip needs the `on-core` arm to beat `on` on the same task and overlay at n ≥ 16, which is the pre-registered rule the W0 note carries.

**Tell the model to close the card when the task states no constraints.** Rejected: there is no `jspace_close` tool, so that advice is unactionable from the model's side. The refusal asks for the acceptance criterion instead, which is a constraint the work was held to and which the model can always write.

**Gate `jspace_open` on the Goal-replace path too.** Rejected: `core` is dropped on that path, so the model would face a refusal it cannot clear. `requireCoreForShip` covers the post-epoch-reset gap instead.

## Consequences

A deployment enabling both fields cannot ship a card that carries no constraint, at the cost of at least one extra tool call whenever the model opens a card without one and whenever a Goal change empties Core. Both refusals are presence checks: a placeholder Core line satisfies them, and nothing compares Core against the task statement.

Core remains the two-item working-memory stage. Typed standing checks live on a separate [charter](2026-08-26-jspace-executor-enforced-charter.md) list on the same card; this note's presence gates do not run those checks.

The [close-hygiene and goal-card-binding proposal](../../proposed/feature/2026-08-25-jspace-close-hygiene-and-goal-card-binding.md) stays open and unbuilt; this change delivers none of its five items. Its dangling-card root and this note's empty-Core root are separate failures of the same card.

No ACP or headless snapshot fixture pins the changed descriptions or either refusal. The `jspace-tools` headless fixture normalizes the system prompt and tool schemas to placeholders, and recording a fixture that carries them needs an API key that was unavailable; the tool-jspace unit suite and the `constraint-capture.e2e.ts` keyless end-to-end pin the text instead.
