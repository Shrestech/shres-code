# Agent Note: Settle `wakeDriver` when initiator start throws

Status: implemented

## Problem

`wakeDriver` assigned `activityDone` and moved the phase to `running` before `withInitiator()`. That call throws synchronously once the Agent service is closing. `.then()` never attached, so `whenIdle()` waited forever. `runMaintenance`'s `finally` could skip `done.resolve()` on the same throw. `send()` after `cancel({ kind: 'disposed' })` could still splice work onto an agent the factory was tearing down.

## Decision

`wakeDriver` wraps the initiator start. A throw restores `idle` and resolves the driver promise. `cancel({ kind: 'disposed' })` sets a flag; later `send` and `wakeDriver` return without queueing or starting a turn. A user cancel still accepts a later send.

## Alternatives considered

**Rethrow after settling the driver.** Rejected: `runMaintenance`'s `finally` would still skip `done.resolve()`, and teardown needs quiescence more than it needs that error.

**Throw from `send` after dispose.** Rejected: racing callers after `handle.dispose()` should stay silent. The factory already calls this sender's leftover work.

## Consequences

Disposal and a closing initiator scope cannot leave `whenIdle()` pending. A stale `followup` after a disposed cancel does not start a model turn.
