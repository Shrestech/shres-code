# Agent Note: Goal fight visible army

Status: implemented

## Problem

Game mode on an active Goal drew the fearless girl in a 168px arena and then nothing else whenever `useProjection('todos')` was null, empty, or all completed. Most Goals have no todo list yet, so the shipped strip looked like a broken sprite: the girl stood alone. The original army rule in [Goal fight bar](../feature/2026-08-18-goal-fight-bar.md) treated that empty box as honest remaining work.

## Decision

`remainingFightUnits` still maps incomplete todos, in list order, capped at six. When that set is empty — absent projection, empty list, or every item `completed` — it returns four placeholder units with stable `standing#0`…`standing#3` ids. The girl therefore always faces an army while the Goal strip is visible and Game mode is on. Completing a real todo still removes that unit's id and plays the lunge/slash/scatter; when the last incomplete todo leaves, the standing ids come back.

Remaining goal rounds are still not the army. The service default `maxGoalRounds` is 256, so `maxGoalRounds - roundsStarted` would pin six zombies for almost the whole Goal and invent progress.

## Alternatives considered

**Keep the girl-alone empty army.** Rejected: Game mode's product request is a fight in the Goal bar. A girl in an empty box reads as a missing asset, not as "no todos yet."

**Drive the army from `maxGoalRounds - roundsStarted`.** Rejected: the default cap is 256. A remaining-rounds count capped at six does not move during a typical session and is not unfinished work.

**Show the arena on every Game-mode session, even with no Goal.** Rejected: the fight lives in the Goal strip. A complete, absent, or loading goal still renders nothing.

## Consequences

An active, paused, or blocked Goal with Game mode on always paints four or more zombies. The first `todo_write` that introduces incomplete items replaces the standing ids, so the girl slashes the placeholders and the real list walks in. The web Goal-bar ARIA snapshot stays unchanged because the arena remains `aria-hidden` and Game mode still defaults off.

## Related

- [Goal fight bar](../feature/2026-08-18-goal-fight-bar.md) — the switch and arena this army rule served.
- [Remove Game mode](../feature/2026-09-03-remove-game-mode.md) — Game mode does not ship.

## Testing

The remaining-fight-unit specs listed when this shipped were deleted with Game mode. Current coverage of the removal is in [Remove Game mode](../feature/2026-09-03-remove-game-mode.md).
