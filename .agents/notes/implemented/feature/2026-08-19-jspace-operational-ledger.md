# Agent Note: J-Space operational ledger

Status: implemented

## Problem

The first J-Space control copy described an accessible workspace, stage capacity, broadcast, inner marks, and pass escalation. Those terms did not correspond to an activation lens or to enforceable harness operations. Local W0 calibration also found that exact-string Core swaps failed, checkpoint phrases could satisfy the register without a cited check call, successful ship left the expensive card open, and retry refusal could apply to successful calls or state the model no longer saw after compaction.

## Decision

J-Space is a durable external session ledger. Its prompt names only card operations and enforced rules; it does not describe the card as Anthropic's internal J-space or claim that automatic processing occurs below it.

Core is a whole-list replacement with at most two lines: the current intermediate followed by an optional pinned constraint. `jspace_open` applies supplied Core whether it creates or updates the card, and `jspace_note` replaces supplied Core without exact-string departure matching.

When `requireCoverage` is true, `jspace_checkpoint` requires both a configured coverage term and evidence naming a successful non-J-Space tool call recorded after the current Goal opened. The evidence establishes that a call completed, not that it semantically covered the claim. `jspace_ship` therefore requires an evidence-backed checkpoint for the current Goal and closes the card after the register check passes.

Identical-call refusal applies only to a failed non-card operation while Goal, Core, Open, and Next remain unchanged in the current turn. A checkpoint-only write does not count as a diagnosis; changing the working fields or starting a new turn releases the refusal.

Automatic loop opens seed Goal from the triggering instruction and retain the existing placeholder guard for blank or bare human opens. The Settings default remains disabled, and the pass classifier remains a reconstructable text/config heuristic pending measured replacement.

## Alternatives considered

**Keep the Tiger380-derived module vocabulary and add clarifications.** Rejected because clarifications would retain prompt cost and the false implication that the card is an internal model representation.

**Increase Core capacity while retaining exact-string swaps.** Rejected because the observed failure was the mutation operation, not demonstrated shortage of slots; a larger brittle list becomes another todo surface.

**Make evidence prove verifier coverage.** Rejected because a generic tool result cannot establish the semantic relationship. The harness records Checked and states the remaining uncertainty.

**Refuse every repeated call while a card is open.** Rejected because successful reruns can be legitimate and raw-log history can outlive the model-visible transcript after compaction.

**Leave ship open for possible follow-up.** Rejected because an open card forces later requests onto the loop copy. A continuation that needs durable state can open a new card with a new Goal.

## Consequences

Full and loop requests carry one compact operational section instead of the capacity, broadcast, and seven optional module sections. Card writes remain model-visible logged state, so Core replacement and ship closure are reconstructed after resume and compaction.

Evidence-backed checkpoints cost a call id and can still cite an irrelevant successful operation. Bench instrumentation must therefore distinguish attempts, accepted card writes, successful ship checks, and final verifier outcomes rather than treating a tool call as success.

The four schemas remain visible on every enabled request, and the keyword/length classifier can still over-open long one-step work. Pass-scoped tool visibility, cross-session card carry, and a measured opening policy remain separate follow-ups.
