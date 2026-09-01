# Agent Note: J-Space Goal settled on ship; Advisor steers done work

Status: implemented

## Problem

`jspace_ship` was a register check that did not close the card or mark the Goal complete. Protocol copy stayed on `loop` ("keep the card, refresh at every seam"), so after the work was done the same Goal reprinted and the main session kept tending it. Advisor could not write the card (and must not: jspace tools act on the child's own session; write access would launder the Goal). `suppressReview` also swallowed `ship-attempt` after the user-intent verdict, so Advisor never judged the ship seam. Charter-less ships append no `jspace/charter-run`, so that trigger never fired.

## Decision

Harness owns the terminal register; Advisor owns judgment.

`jspace_ship` still writes no files and does not close the card. A passing ship calls `ctx.jspace.recordShipped`, which appends log-only `jspace/shipped` (`goal`, `goalOpenedSeq`). The fold exposes `settled` until `goalOpenedSeq` advances or the card closes. The prompt Consumer reprints a settled line instead of the keep-tending driver (`JSPACE_DRIVER_SETTLED`); capacity, broadcast, and extra modules stay empty for that epoch.

Advisor: digest and delta include a ship line when the current epoch has a passing stamp (or a successful `jspace_ship` / passing charter ship run). `classifyTrigger` treats `jspace/shipped` and a successful `jspace_ship` result as `ship-attempt`. Cadence suppression (`drift-check`, `error-burst`) still waits for the user; lifecycle triggers always run. Persona and trusted `MAIN_SESSION_ADVISOR_RULES` say: if the user ask is satisfied, `jspace_open` only for new work; the user turns J-Space off. Advisor still has no `jspace_*` tools.

## Alternatives considered

**Give Advisor `jspace_note` / `jspace_open`.** Turns it into a second author of the card and would fail on the child session (no card). Rejected.

**Ship closes the card.** One-way door; close drops the registered charter that `openGoal` otherwise keeps for follow-on work. Rejected as default.

**Protocol copy only, no stamp.** Stops some flailing but the card still reprints as an active Goal. Rejected as the only fix.

## Consequences

A shipped Goal stays visible (charter and Checked survive) but is labeled settled. A new Goal epoch via `jspace_open` clears `settled` and restores tending. `/j-space off` still closes. Card Goal epochs remain a different ledger from `create_goal` / `update_goal complete`.

## Verification

Fold specs pin stamp-then-new-Goal. Tool-jspace ship leaves the card open and sets `fold.settled`. Prompt assemble after `recordShipped` prints `JSPACE_DRIVER_SETTLED` and omits loop/capacity/broadcast. Advisor classifyTrigger, digest ship line, invariant `jspace/shipped` pointer, and apply harness: a ship stamp after a landed verdict starts a `ship-attempt` followup.
