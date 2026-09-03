# Agent Note: Remove Game mode

Status: implemented

## Problem

Game mode added a composer switch and a Goal-bar fight arena that the product no longer wants on the Web UI. The switch sat in `conversation.input.left` beside J-Space, wrote the `game` settings namespace, and widened the Goal strip by an `aria-hidden` sprite arena. That chrome is unrelated to `/goal` mutation, and it is extra composer noise next to Dictate and model selection.

## Decision

Game mode is gone. `ui-goal` does not register a Game switch, a `game` settings section, or the fight arena. The GoalBar strip still shows phase, objective, and edit / pause / resume / clear. `/goal` command input is unchanged.

The host settings allowlist does not expose `game`. A leftover `game` document in a user's settings file is unread and cannot be mutated through the Web settings wire (`settings-not-exposed`).

## Alternatives considered

**Leave the toggle off by default and keep the arena code.** Rejected: an unreachable settings namespace and sprite bundle would still ship in the client plugin and still occupy the composer row if anyone turned the switch on.

**Move Game mode to a Settings page only.** Rejected: the request is to remove the mode, not to hide the switch.

**Delete the GoalBar with Game mode.** Rejected: `/goal` and the docked strip are the goal surface; the fight arena was an optional overlay.

## Consequences

Composer-row snapshots do not include a Game switch. The Goal plugin's node half is an empty loader seat. The inlined fight sprites are gone from the client bundle. Prior Game-mode Agent Notes describe a feature that does not ship; this note is the current owner.

## Testing

Package specs cover GoalBar registration and verbs without a Game slot or arena. The api-proxy allowlist spec no longer serves `game`. The assembled `goal-fight` e2e is deleted. Speech e2e waits on Dictate rather than the Game switch.

## Related

- [Goal fight bar](2026-08-18-goal-fight-bar.md) — the switch, `game` namespace, and arena this removal deletes.
- [Goal fight visible army](../bug-fix/2026-08-18-goal-fight-visible-army.md) — the standing-army rule for that arena.
