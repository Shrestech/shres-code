# Agent Note: Goal fight bar

Status: implemented

## Problem

The Goal strip reported phase and objective only. Remaining work (incomplete todos) had no presence in that 36px dock, so a live Goal looked idle even while a list of unfinished units sat in the Todo card above it.

## Decision

Game mode is off by default. A switch labeled Game sits in the composer tool row beside J-Space (`conversation.input.left`) and writes the `game` settings namespace (`enabled`). The Goal fight arena renders only while that document is ready and `enabled` is true.

An active, paused, or blocked GoalBar then draws a 32px fight arena at the left of the strip. The fearless girl (ponytail, sword, green S-shield) stands on the left. Each incomplete todo is one zombie, capped at six, in list order. When a remaining todo id leaves the list, she steps forward, slashes, and that zombie scatters. Paused and blocked goals, and `prefers-reduced-motion: reduce`, drop missing units immediately and do not shuffle.

The clock is elapsed milliseconds since `goal.createdAt`. It is not an estimate of completion. The arena and clock are `aria-hidden`; the strip's name, objective, and actions stay the accessible chrome.

Incomplete todos are the army when any exist. Remaining goal rounds stay unused (the default cap is 256). Live child sessions have no parent-session projection, so they are not zombies. An empty remaining-todo set draws a standing army of four; the army-source rule lives in [Goal fight visible army](../bug-fix/2026-08-18-goal-fight-visible-army.md).

Sprites are inlined data URLs in `packages/client/ui-goal/src/client/sprites.ts` so the client plugin bundle does not need an image loader.

## Alternatives considered

**Drive the army from remaining goal rounds (`maxGoalRounds - roundsStarted`).** Rejected: a round cap is not unfinished work. The default cap is 256, so a remaining-rounds army would sit at the six-unit strip cap for almost the whole Goal. The standing-army fallback that later shipped is recorded in [Goal fight visible army](../bug-fix/2026-08-18-goal-fight-visible-army.md).

**Add a parent-session children projection and treat live subagents as zombies.** Rejected for this change: that projection does not exist, and inventing it is a session-fold contract, not a GoalBar presentation.

**Play a generated video clip in the strip.** Rejected: this team's video generator requires an upload URL the harness cannot supply, and a 36px dock cannot play a 6s clip honestly. Four poses plus a left-position transition are the motion.

**Put PNG files on a public HTTP route.** Rejected: the Goal plugin loads through the client ModuleLoader, which has no static asset table. Inlined data URLs travel with `lib/client.js`.

**Keep Game mode as a local React flag with no settings namespace.** Rejected: the switch would reset on reload and could not cross the Host settings wire.

**Put the switch only on a Settings page.** Rejected: the switch has to stay next to the chat. The `game` namespace is still the durable store so Settings can bind the same document.

**Keep the switch in the sidebar logo row.** Rejected: it crowds the wordmark. Game sits beside J-Space in the composer tool row.

## Consequences

The Goal strip is unchanged until Game mode is on. Then it is wider on the left by 168px plus the elapsed clock. Todo completion is visible in two docks: the Todo card and the Goal army. The web Goal-bar ARIA snapshot stays the same because Game mode defaults off and the arena is `aria-hidden`. The api-proxy allowlists the `game` namespace so the switch persists.

## Testing

`packages/client/ui-goal/tests/units.client.spec.ts` pins the standing army for empty/non-list/all-completed input, completed-item drop, the six-unit cap, and elapsed formatting. `packages/client/ui-goal/tests/goal-fight.client.spec.tsx` plays one kill through lunge/slash/scatter, freezes under `frozen` and reduced motion, appends new units, and shows/clears the clock. `packages/client/ui-goal/tests/goalbar.client.spec.tsx` asserts the arena is absent by default and mounts `aria-hidden` when Game mode is on. `packages/client/ui-goal/tests/game-mode.client.spec.tsx` pins the ready+enabled predicate and the sidebar switch. `packages/host/apiproxy/tests/api-proxy-config.spec.ts` persists `game.enabled`.
