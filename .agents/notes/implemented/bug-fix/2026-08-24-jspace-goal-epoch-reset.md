# Agent Note: J-Space goal-epoch reset

Status: implemented

## Problem

A card for Goal G1 shipped with 10 Checked lines and 2 Core lines. The user then started a new goal epoch: `create_goal` followed by `jspace_open` returned `Updated J-Space.`, and the open card kept G1's Core and all 10 checks under the new Goal D1. `jspace_ship` therefore passed on the previous Goal's evidence. The control loop had made `jspace_open` on an open card an in-place Goal/Next update through `note` so auto-open would not trap the model, with no Goal-identity check ([control loop](../feature/2026-08-18-jspace-control-loop.md)). The D1 card in the [live-session forensics](../../proposed/feature/2026-08-24-jspace-live-session-forensics.md) is the regression fixture; [Front 1 item 3 of the uplift note](../../proposed/feature/2026-08-18-jspace-deployment-review-and-uplift-claude.md) binds checkpoints to goal identity and calls for the reset.

## Decision

`jspace_open` on an already-open card now routes through a new seat method `openGoal`, which reads the Goal identity:

- A **different Goal** opens a new epoch: Core and Checked reset to empty, the `goalOpenedSeq` anchor moves to the current session event seq (the existing ship-gate anchor, not a new one), and Open questions carry over unchanged. Ship then requires a fresh checkpoint under the new Goal.
- The **same Goal** is the control-loop update path: Goal and Next update in place, and Core, Checked, Open, and the anchor are all unchanged.

`note` rejects a Goal identity change (`JSPACE_NOTE_GOAL_CHANGE`); Goal epochs open only through `openGoal`. The tool `jspace_open` returns `Updated J-Space.` for both cases; it opens a new card only when none is open.

The checkpoint driver line (`JSPACE_DRIVER_OPEN`, mounted by the control loop whenever a card is printed) gains one clarifying clause: the optional `evidence` must be a `call_*` tool-call id from this session. The `jspace_checkpoint` refusal behavior is unchanged and stays strict; this only stops models from sending `"bash-1"` or a file path as evidence.

## Alternatives considered

**Reset Core and Checked on every `jspace_open`, regardless of Goal.** Rejected: the control loop made open-on-open an in-place update so auto-open would not trap the model; a full reset undoes that. Resetting only on a Goal identity change preserves the same-Goal path.

**Route `jspace_open` through `note` and reset only in the tool.** Rejected: the seat owns the epoch-anchor move and the reset contract, so the semantics live in `openGoal` on `JspaceService` where the D1 fixture and the fold can pin them; the tool just selects the method.

**Refuse open-on-open whenever the Goal differs.** Rejected: that breaks the control-loop update path that the loop relies on and gives the model no way to state a new Goal on the live card; the reset keeps the update and moves the ship gate.

**Let a second `jspace_open` with a different Goal also replace Open.** Rejected: the scope says Open questions carry across epochs untouched; they are not part of this fix.

## Consequences

A new goal epoch can no longer ship on the previous Goal's Core and Checked: Core and Checked clear, the `goalOpenedSeq` anchor moves, and ship re-gates until a checkpoint lands under the new Goal. Same-Goal re-open is unchanged (the control-loop path). The D1 tool test pins the reset and the re-gate; the seat test pins the anchor move and Open carry-over; the driver test pins the new evidence sentence. `tool-jspace` and `jspace` READMEs document the epoch semantics. Coverage: `openGoal`, the tool routing, and the driver change are fully covered by the jspace suites, and `packages/jspace/jspace/src/index.ts` is at 100% — the `note` swap's `incoming === undefined` throw in the no-departing branch is unreachable (entering that branch requires a set `core`, which defines `incoming`) and carries a `v8 ignore` for the same reason the file's decode catch does. Pre-existing uncovered branches remain only in `fold.ts` (untouched): `sessionEventSeq`'s non-number/negative path and `matchesCoverageTerm`'s empty-term path. The [control loop](../feature/2026-08-18-jspace-control-loop.md) decision text is updated to match the new routing.
