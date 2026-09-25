# Agent Note: A routed agent returns to its manual route after its router is removed

Status: implemented

## Problem

After its first request, an agent loop instance seeds each request from the last logged `request/header` ([agent.ts](../../../../packages/core/agent-loop/src/agent.ts)), and a routed request leaves that header on the candidate. The manual route beneath it was durable only in the router's `model-routing/decision.sticky.entryBase`, which core/agent cannot read without depending on the router's event types. Once the router was removed, the model-selection hook's empty-source branch and `selectionInForce` fell back to that header: an agent with no front-end selection kept running the candidate, and a front end that restores its selection from `selectionInForce`, such as the Web Host API or `agentDefaultModel.selectionFor`, adopted the candidate as the manual route. The [router-selection install-gap note](2026-09-25-router-selection-install-gap.md) recorded this as deferred work.

## Decision

**core/agent owns a durable record of the manual route beneath a routed request.** `agent/route-base { manual, routed }` is declared in core/agent's `SessionEventMap` merge beside `agent/model-selection`, and both fields are provider, model, and optional effort. The model-selection hook ([model-selection.ts](../../../../packages/core/agent/src/model-selection.ts)) appends it when `ctx.modelRouting.resolveRequest` returns a route that differs from the manual route in provider, model, or effort, after checking the request's abort signal. The append runs inside the `agent/request` waterfall, so it precedes the `request/header` the loop logs for that request. No router, a router that keeps the manual route, and a routed route equal to the manual one append nothing, so a composition without a router writes the same log as before.

**The record is required on read.** It changes no request text; it decides which route a later request returns to, so it is logged rather than held in memory. It is not `ignorable`: a build that does not know it refuses the log instead of resuming on the candidate. The event type is additive, so `SESSION_FORMAT_VERSION` stays 0, and `gen-persistence-catalog` adds it to `KNOWN_SESSION_EVENT_TYPES`.

**`manualBaseOfLastHeader(events)` reads it.** From the last `request/header` it searches back past headers on the same route and stops at the first header on another route. The latest record in that span whose `routed` route the last header runs supplies `manual`. Effort is compared only when the record names one, because a header's effort may be an adapter default. A record that no header runs, from a request aborted or failed after the append, is never read. The reader validates the durable payload as `selectionInForce` validates `agent/model-selection`.

**Precedence.** The hook's empty-source branch uses `stickySelection`, then `manualBaseOfLastHeader`, then the resolved route, and rewrites the request only when the manual route differs from the resolved one; with no router, that rewrite returns the agent to its manual route. `selectionInForce` uses the latest `agent/model-selection`, then `stickySelection`, then `manualBaseOfLastHeader`, then the last header. With a router composed, its report stays first. The provided-selection branch is unchanged.

**The hook skips a record the reader already has.** It skips the append when the record a header on the routed route would read already names the same two routes. A held streak therefore records once, and a later streak after a manual header records again, because the reader does not search past that manual header.

**Each package checks its side of the relation.** core/agent's `./invariant` requires the two routes to differ and each to have a nonempty provider and model. The model router's companion requires each record to follow its step's downgraded decision, with that decision's entry base provider and model as `manual` and its selection as `routed`.

## Alternatives considered

**Record the manual route in `request/header`.** Rejected: the loop writes the header after `prepareCall`, while only the hook knows the manual route, so the loop and core/session's `EpochHeader`, which every header fold reads, would both change. A new event type is additive and keeps routing facts out of the request-epoch vocabulary.

**Read the router's `model-routing/decision` events from core/agent.** Rejected: core/agent would depend on the event vocabulary of an optional plugin that depends on core/agent.

**Keep the manual route in memory in the hook.** Rejected: it is lost on resume and in a fresh process, and an input that changes later requests must be reconstructable from the log.

**Skip the append when the latest record anywhere in the log is equal.** Rejected: a second streak on the same two routes after a manual header would record nothing, and the reader, which stops at that manual header, would find no record for the second streak's header.

## Consequences

- An agent whose router is removed mid-session returns to its manual route on the next request, and `selectionInForce` reports the manual route, which the Web Host API and `agentDefaultModel.selectionFor` restore.
- A log written before this change has no record: the reader returns `undefined`, and with no router the last header stays in force until a front end provides a selection. There is no migration.
- A fork seeded from a routed parent carries the parent's record, so its first request returns to the manual route when no router is composed.
- Every routed session log gains one record per streak. In the model-router keyless fixtures, the `stateHash` of each decision after the first record, and the fitted arm's judge-visible state text, carry the shifted surface seqs.
- The reader scans the log backward on each request that has no provided selection and no router report, and stops at the last header on another route.

## Verification

- `packages/core/agent/tests/model-selection.spec.ts`: the record and its absence without a router, with a manual answer, and with an equal route; one record across held steps and a new one after a manual header or a new manual route; the record precedes the header; an orphan the reader ignores and an abort before the append; the empty-source restore with and without a router report; the reader's span, effort, legacy-log, and corrupted-record cases; and `selectionInForce` precedence.
- `packages/core/agent/tests/invariant.spec.ts` and `packages/llm/model-router/tests/invariant.spec.ts`: each relation accepts a valid record and rejects every mismatch.
- `packages/llm/model-router/tests/composition.spec.ts`: through the real Loader with both invariant companions, a routed request records the creation route, the router's fiber is disposed, `selectionInForce` reports the creation route, and the next request runs it with no further consult.
- `examples/headless-agent` keyless snapshot `model-router-unmount`: the first boot routes to the candidate; the second boot leaves the router entry disabled, resumes the session, restores its selection, and runs the manual model.
