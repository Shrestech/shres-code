# Agent Note: Goal disarmed completion authority

Status: implemented

## Problem

A goal that finished in a non-human-driven turn could never be closed by the agent that finished it. `completionAuthority` admitted only direct-human input or the exact current goal round; a background-notification or plugin-sourced turn has neither. Meanwhile every non-goal turn's accepted events leave the folded goal `disarmed` (the round driver disarms to preserve human steering), and the goal-round driver reserves rounds only while `activation === 'armed'`. The result was a zombie state: the goal stayed `phase: 'active'` with `activation: 'disarmed'` and zero future rounds, the UI showed an ongoing goal, the agent was idle, and only an coincidental later human turn could complete it. Session telemetry confirmed the sequence: work finished in a notification-triggered turn, `update_goal action=complete` was refused with `GOAL_TOOL_AUTHORITY_REQUIRED`, and the goal stayed active across subsequent idle turns.

## Decision

`completionAuthority` in `packages/goal/tool-goal/src/authority.ts` gains a third grant: `complete` on a goal whose `activation === 'disarmed'`, from an agent that is a runtime root in the live agent graph. Three properties make it safe:

- **Bookkeeping-only.** `goal-round-driver` reserves a next round only when `phase === 'active' && activation === 'armed'`; a disarmed goal admits no future round, so completing it cancels nothing that would have run.
- **Roots-checked.** A subagent session seeded with a parent's goal events folds the same current goal but is not in `ctx.agents.roots()`, so it cannot close the parent's goal from its own turns.
- **Complete-only.** `blocked` never takes the grant: its `blockedAfterConsecutiveRounds` threshold is defined over admitted goal rounds, and a disarmed goal has none to test the condition against.

The `update_goal` description and the `tool:goal` prompt section now tell the model to complete a disarmed goal from a non-human finishing turn rather than leaving it open. The wrap-up `deferContext` injection stays goal-round-only: a disarmed completion is a settlement, not a continuation boundary, so no turn conclusion or follow-up instruction is queued.

## Alternatives considered

**Let the runtime auto-complete disarmed goals.** Rejected: completion is a claim that the objective was achieved; only the executing model can make it, and a silent runtime transition would erase the human-visible record of who said it succeeded.

**Admit any turn for terminal reports.** Rejected: `blocked` needs admitted rounds by construction, and an unrestricted grant would let an unrelated plugin turn that merely observes a goal close it without having done the work.

**Surface a "completion pending" state instead.** Rejected as the primary fix: it converts one refused call into a permanent intermediate state that still needs a human or round to settle, and the GUI would render a third phase for a condition the authority rule can simply admit.

## Consequences

An agent that finishes goal work during a notification-triggered turn closes the goal in that turn; zombie active-but-idle goals end. The authority surface grows one grant kind (`GoalToolAuthority` gains `{ kind: 'disarmed' }`), and the refusal message names the new admission so the model can self-correct. Tool-catalog and README prose changed with the schema description. The catalog regen also picked up the unlisted `tool-tracker` package (generator row added as a drive-by; the freshness gate had been failing on clean develop).

## Testing

`packages/goal/tool-goal/tests/tool-goal.spec.ts`: disarmed `complete` from a plugin-sourced turn succeeds and queues no turn conclusion; disarmed `blocked` from the same turn is still refused; a seeded subagent session completing the root goal from a notice turn is refused (`GOAL_TOOL_AUTHORITY_REQUIRED`). Existing pins unchanged: goal-round terminal reports, direct-human steering in goal rounds, resumed-fork root authority.

## Related

- [Model-facing goal tools](2026-07-19-model-facing-goal-tools.md) — the authority split this extends; its terminal-authority paragraph now links here.
- [Same-session goal round driver](2026-07-19-same-session-goal-round-driver.md) — owns the `activation === 'armed'` reservation this grant depends on.
