# Agent Note: jspace-advisor catch-up watermarks the triggering event

Status: implemented

## Problem

After a proactive review settles, `launchReview`'s `finally` looks for a human `user/message` that arrived while the review was in flight and starts one catch-up `user-intent` turn ([steering note](../feature/2026-08-31-jspace-advisor-steering.md)). That scan used `run.lastSeq` as the exclusive lower bound. `lastSeq` is the last parent seq a *successful* review folded; a failed or agent-less turn leaves it at `-1` (or the previous success).

`-1` makes every historical user message look like in-flight catch-up. The `finally` then calls `launchReview` again on the microtask queue. A fast-failing review (`ctx.agents` missing, `startContinuable` throwing, a verdict-less turn) therefore re-enters immediately. The event loop never returns to HTTP, timers, or session I/O: the Web UI on port 3080 accepts TCP and never answers.

Enabling J-Space arms the advisor. The next `user-intent` or drift trigger on a session that already has user history is enough; the Settings switch does not have to be the event that wedges.

## Decision

Catch-up uses `triggerSeq` — the seq of the event that started *this* review. Messages already in the log when the trigger fired have `seq <= triggerSeq` and are not pending. Only a human `user/message` appended after that seq, while `flights` blocked the live listener, starts one follow-up. A failed turn that produced no later user message stops.

`lastSeq` still bounds the standing child's delta fold after a successful verdict. It is not the catch-up watermark.

## Alternatives considered

**Treat a failed turn as cooldown for catch-up too (`failedSeq`).** Rejected: a user who spoke *during* a failed review would be dropped until they speak again. Catch-up exists so in-flight user messages are not lost; the watermark just must not be older than this review.

**Set `lastSeq` to `session.seq` on failure.** Rejected: `session.seq` is the next seq, so it also hides a message that landed during the failed turn. `triggerSeq` is the review's start, which is the fact catch-up needs.

**Drop catch-up and let the next `user/message` listener fire after `flights` clears.** Rejected: the listener returns early while `flights.has(session)`, so a message that arrives during the review is never seen unless `finally` looks for it.

## Consequences

A broken advisor no longer wedges the host process. In-flight user messages still catch up after both success and failure. Package tests pin a failed start after a triggering user message (`starts === 1`) and an agent-less user-intent trigger that returns to the event loop.
