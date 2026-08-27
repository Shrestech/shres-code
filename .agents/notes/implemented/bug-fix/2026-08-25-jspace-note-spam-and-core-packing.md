# Agent Note: J-Space note spam and Core packing

Status: implemented

## Problem

Live-session forensics in [J-Space live-session forensics](../../proposed/feature/2026-08-24-jspace-live-session-forensics.md) and the [long-horizon harness uplift](../../proposed/feature/2026-08-25-long-horizon-harness-uplift.md) showed two card dysfunctions the existing write rules did not stop.

In `session-6f4eb6e0` a card's `core[0]` held the literal string `["Zombie-goal root cause: …", "Fix (scoped): …"]` — a JSON-encoded array packed into one capacity slot, so Core showed two claims while the ≤2-live-items limit still counted one slot.

In develop parent `session-2ec6708c`, child `session-5231518c` issued 19 `jspace_note` calls in one turn, oscillating Next between the same two sentences, writing zero checkpoints, and burning the turn to max-tokens. Some of those notes were exact no-ops. The [control-loop same-args refuse](../feature/2026-08-18-jspace-control-loop.md) does not trip on `jspace_*` tools, so A→B→A Next oscillation and restated cards both ran.

## Decision

`line()` in [`packages/jspace/jspace/src/index.ts`](../../../../packages/jspace/jspace/src/index.ts) refuses any trimmed line whose `JSON.parse` yields an array (`JSPACE_LINE_PACKED`, message `jspace line must be one item per slot; Core holds at most 2 live items`). A line that merely starts with `[` (for example `[shield] fix the gate`) and a line that parses to a JSON object or string stay accepted.

After `note()` computes the next card, it refuses when Goal, Next, Core, and Open are element-wise identical to the current card (`JSPACE_NOTE_NOOP`, message `the card already says this; proceed with the work or write a checkpoint`). Checked is not compared because `note` cannot change it. A→B→A Next oscillation is still a real change and is not this refuse.

`tool-jspace` already walks `session.events` back to `turn/start` in `tools/pre-execute` for the same-args refuse. That hook now also counts `jspace_note` `tool/call` events in the current turn (skipping the in-flight `callId`) and denies further notes once `maxNotesPerTurn` is reached. The cap is validated `Config` on `tool-jspace` (default 8; zero and negative fail at load). Raising it is a deployment choice. The jspace fold does not track turns.

`jspace_note`'s model-visible description adds one clause that a no-op leaving the card unchanged is rejected.

## Alternatives considered

**Refuse any line that starts with `[`.** Rejected: the observed abuse is a JSON array in one slot; `[shield] fix the gate` is ordinary prose and must stay legal.

**Refuse a line that parses to any JSON value.** Rejected: the forensic payload was an array; a JSON object or quoted string is not that packing and would over-block.

**Treat A→B→A Next oscillation as a no-op.** Rejected: each hop changes the card, so exact identity cannot see it. The per-turn cap is the cheap stop for that pattern; a fold-owned oscillation detector would invent turn or history tracking the fold does not own.

**Put `maxNotesPerTurn` on the jspace seat Config / Settings namespace.** Rejected: the seat Config is write, gate, and remount policy; the count lives on the existing `tools/pre-execute` walk that already bounds scans at `turn/start`. Growing the Settings document without a Settings-page control would mix those jobs, as the [reprint-bounds note](../feature/2026-08-25-jspace-card-reprint-bounds-and-framing.md) already recorded for reprint caps.

**Count notes inside `foldJspace`.** Rejected: the fold is last-wins card state and has no turn vocabulary. The user-facing instruction was to skip the cap rather than invent that tracking.

## Consequences

Packed Core/Checked/Open arrays fail at the write path before a snapshot lands. Exact no-op notes fail without appending `jspace/card`. A ninth `jspace_note` in one turn (default) is denied at pre-execute with `jspace_note is limited to 8 calls this turn; write a checkpoint or do the work instead.` A new `turn/start` resets the count; a card write does not. Oscillation across distinct Next strings still spends the budget and then must checkpoint or do the work. Seat and tool tests pin packed-array rejection, `[shield]` acceptance, no-op rejection, A→B→A survival, the default cap, a deployment cap of 1, and zero/negative Config failure. No ACP snapshot scenario pins the new description or denials.
