# Agent Note: J-Space note rejects Goal change

Status: implemented

## Problem

The [goal-epoch reset](./2026-08-24-jspace-goal-epoch-reset.md) routed Goal identity changes through `openGoal`, but `note()` still accepted a different Goal string. That moved `goalOpenedSeq` while keeping Core and Checked visible — an incoherent epoch state and a side door around the reset. Model-visible goal-tool text (`update_goal` description and `guidance()`) had changed in source without updating ACP snapshot sidecars, blocking keyless replay.

## Decision

`note()` now rejects a Goal input whose trimmed text differs from the current card Goal (`JSPACE_NOTE_GOAL_CHANGE` with message `note cannot change the Goal; call jspace_open to open a new Goal epoch (resets Core and Checked).`). A same-Goal note remains allowed and leaves `goalOpenedSeq` unchanged. Goal epochs open only through `openGoal` / `jspace_open`.

`OPEN_DESCRIPTION` and `JSPACE_DRIVER_OPEN` tell the model that a changed Goal starts a new epoch: Core and Checked clear and ship needs a fresh checkpoint; open questions carry over. `NOTE_DESCRIPTION` states Goal changes are rejected.

Stale ACP snapshot sidecars for `update_goal` and goal `guidance()` were hand-aligned to the current source strings. Recording was unavailable without an API key; keyless replay verifies the fixtures.

## Alternatives considered

**Keep `note()` Goal refinement within the epoch.** Rejected: it moved the ship anchor without clearing Checked, contradicting the epoch reset contract and letting stale evidence ship under a new Goal label.

**Silently ignore a Goal change in `note()`.** Rejected: the model would believe the Goal updated while the epoch anchor and evidence stayed bound to the old identity.

## Consequences

Goal identity changes are single-path through `openGoal`. `note()` patches Core, Open, and Next only. Seat and tool tests pin rejection and same-Goal success; the goal-epoch e2e adds a refused `jspace_note` after checks land. README Known Limitations document exact-string Goal identity and copy-on-fork Checked inheritance. The prior epoch-reset note's `note()` contract is superseded for Goal identity; same-Goal `openGoal` and open-on-open reset behavior are unchanged.
