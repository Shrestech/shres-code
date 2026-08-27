# Agent Note: jspace close hygiene and goal-card binding

Status: proposed

## Problem

Session-log forensics over the newest 22 substantial sessions in `~/.shres/sessions` (2026-08-25 pass, extending the [live-session forensics](2026-08-24-jspace-live-session-forensics.md)) show the J-Space card is written but never settled: 18 of 21 opened cards were still open at session end, and the only 3 closes were the user running `/j-space off`. Ship is a register check, not a close, and no mechanism nudges or performs the close, so every long session ends with a dangling card whose Next is stale.

Four adjacent dysfunctions share the lifecycle root:

1. **The goal tool and the card are two memories that do not bind.** In develop `session-6f4eb6e0` the durable goal completed at seq 58384 while the card Goal was later rewritten to a different objective and stayed open to session end; nothing links `goal.id` to the card or reconciles their lifecycles.
2. **Root agents cannot retune or replace an in-flight goal.** `session-fe6e08d5` seq 38781: `update_goal edit` (raise `max_goal_rounds`) refused as human-only; seq 87182: `create_goal` refused because a goal is active. The model dead-ends and the user must intervene, which in practice means `/goal` clears — the human is the only closer.
3. **Stock fork cards are never replaced.** 6 of 21 cards in the slice were the inherited `J-Space is on` stock card; idle children complete a turn without touching it (forensics item F1-8, still unbuilt).
4. **Same-args retry loops are only guarded for `jspace_*`.** `session-6f4eb6e0` retried an identical `edit` call 23 times within one turn; the repeat-refusal control loop does not cover `edit`/`write`/`read`.

## Proposal

Five items, ordered by value:

1. **Bind goal completion to the card.** When the durable goal tool completes or clears a goal in a session whose card is open, the card is settled in the same effect: either a close tombstone is written (goal complete with shipped card) or the card epoch resets awaiting a new Goal (goal cleared). Implement as an optional integration plugin (Consumer of both seams) so jspace core keeps no goal-tool dependency; compositions that mount both get the binding.
2. **Turn-end close nudge.** When the assistant's final turn state has an open card whose Goal's work has shipped (a ship register-check passed in the current epoch), the next assemble appends one harness-authored sentence prompting `jspace_close` or an explicit continuation. Pure prompt text, no forced action.
3. **Root-agent goal retuning.** Admit `update_goal edit` of `max_goal_rounds` (and optionally the objective) from a runtime root on a disarmed goal, mirroring the shipped disarmed-completion authority; `blocked` stays strict. Alternatively a single `replace` verb that clears-and-creates atomically with the same authority rules.
4. **Stock-card replacement pressure.** A fork child whose card is byte-identical to the inherited stock card after its first completed turn gets one harness-authored line telling it to open its own Goal or close; repeat offenders are a capacity-module concern, not a hard gate.
5. **Generalize the same-args-within-turn refusal** from `jspace_*` to `edit`/`write` (and evaluate `read`), as a guard-plugin config listing covered tool names rather than a hardcoded set.

## Alternatives considered

**Auto-close the card at session end.** Rejected: session end is not an event the model sees, a silent close hides the dangling-Next problem instead of fixing it, and fork children would inherit nothing reviewable; settling belongs where the goal lifecycle already settles (item 1) or in model-visible pressure (item 2).

**Make `jspace_ship` also close the card.** Rejected in the 2026-08-24 forensics round and still wrong: ship is deliberately a register check so work can continue after a passed gate; conflating it with close re-opens the "ship early to silence the gate" incentive.

**Hard-block turns until the card is closed.** Rejected: a completion gate that fires on every session teaches padding, the exact ritual-compliance failure the evidence-grade checkpoint work addresses; nudge text plus the goal binding is the proportionate pressure.

**Let jspace core listen for goal events directly.** Rejected: it couples the jspace package to the goal tool's event vocabulary; the integration-plugin form keeps both seams independent and the binding opt-in per composition.

## Acceptance criteria

- Mounting the binding plugin makes goal `complete` write a card close tombstone (and goal clear reset the epoch) in the same session, covered by unit tests and a keyless e2e over both seams.
- The close-nudge sentence appears in the assembled prompt exactly when an open card has a passed ship register-check in the current epoch, pinned by a jspace-prompt unit test.
- A root-agent `update_goal edit` of `max_goal_rounds` on a disarmed goal succeeds; an armed-goal edit still refuses; covered by goal-tool unit tests.
- The guard config lists covered tools; an identical-args `edit` repeated within a turn past the threshold is refused with the existing refusal text; covered by guard tests.
- Forensics rerun on fresh sessions shows dangling-card rate materially below the observed 18/21.

## Risks

- **Binding surprise:** a user who completes a goal while intending to keep the card working loses the card; mitigated by the clear-vs-complete distinction and by the binding being a separately mountable plugin.
- **Nudge fatigue:** one more harness sentence per qualifying assemble; bounded to a single line and only when a ship has passed.
- **Retuning abuse:** a model raising its own `max_goal_rounds` weakens the round budget; scoping the grant to disarmed goals from runtime roots keeps the armed-path budget intact.
- **Guard false positives:** legitimate identical `read` retries exist (file changed on disk); start with `edit`/`write` and leave `read` to evidence.
