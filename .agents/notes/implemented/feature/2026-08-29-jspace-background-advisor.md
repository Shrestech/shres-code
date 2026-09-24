# Agent Note: J-Space background advisor

Status: implemented

Superseded for the proactive channel by [the one-shot drift reviewer](./2026-08-30-jspace-advisor-oneshot-drift-reviewer.md); consult remains as described here with the route split applied.

## Problem

The J-Space card is a working-memory fold of the session log, but nothing looks over the session's shoulder as it runs. The main agent is self-monitoring only through prompt text. The user wanted a dedicated reviewer model — a continuation of the Ward/Aegis/Stride "model seat" concept — that monitors the session in the background, not reading everything but enough for useful, targeted advice, and that can (a) proactively flag when the session appears to be going wrong and (b) be consulted on demand by the main session.

## Decision

Add `packages/jspace/jspace-advisor/`, a default-off jspace feature. The advisor is a reviewer model seat that watches a bounded fold of the main session and advises through jspace surfaces.

### Two channels, not one

`ctx.subagents.startContinuable` and `followup` resolve at inbox acceptance and never yield a reply, so a continuable channel cannot "return the reply directly as tool output". The feature therefore splits:

- **Consult** (`jspace_consult`) runs a fresh one-shot child per call via `ctx.subagents.start` with a structured `outputSchema` reply. The digest fully specifies the input, so continuity buys nothing; synchrony and per-call disposal are worth more.
- **Proactive** runs one continuable reviewer child per parent session via `startContinuable` + `followup`, woken by the harness on triggers. The reviewer's settlement notice is captured from the parent session log and written as a logged `jspace/advisor` event.

### The digest

`foldAdvisorDigest` folds a bounded view of the parent session: the rendered card (`formatJspaceCard`, reused rather than a second renderer), the trailing tool-outcome window (oldest-first, capped by `maxDigestTools`), the latest human user intent, and the completed step count. `maxDigestChars` caps the complete render. The reviewer self-serves older context through `wiki_search`/`wiki_read` and the `session_search` family via its `toolFilter`.

### Proactive triggers

A proactive review runs on a closed trigger set, coalesced to at most one per user turn: `charter-fail` (a failed `jspace/charter-run`), `error-burst` (`errorBurst` consecutive errored `tool/result`), `goal-epoch` (a `jspace/card` whose Goal changed), and `ship-attempt` (a `jspace/charter-run` with `phase: 'ship'`). A bare card update is not a trigger (it fires per-step); a `step/end`-after-a-bound trigger is deferred because its invariant predicate would depend on advisor Config the companion cannot read without a service.

### Model-visible ⟺ logged

The reviewer-visible digest is logged as the child's user message in the child's durable session. Parent-visible proactive advice is a logged `jspace/advisor` event (log-only, `{ ignorable: true }`) written from the settlement notice, filtered by `sessionId` so forked logs do not resurrect stale advice. The consult reply lives in its `tool/call`/`tool/result` pair and writes no advisor event.

### Package shape

No `ctx.jspaceAdvisor` service — every consumer is internal to the plugin, so a service would be API expansion with zero current callers. The plugin row wires tools and prompt directly, like `tool-jspace`. Advice lives in its own `jspace:advisor` prompt section (order 56, after the whole jspace block 44–55), framed untrusted, never entering the card fold.

## Alternatives considered

**A continuable child for consult.** Rejected: `startContinuable` and `followup` resolve at inbox acceptance and never yield a reply, so a continuable channel cannot return the reply directly as tool output.

**A bare card update as a proactive trigger.** Rejected: card updates fire per step, so a trigger on them would fire on every step rather than on a signal worth a review.

**A `ctx.jspaceAdvisor` service.** Rejected: every consumer is internal to the plugin, so a service would be API expansion with zero current callers.

## Consequences

- The advisor is default-off and absent from shipped/snapshot profiles; no ACP snapshot is added.
- Each proactive review wakes the parent with a settlement notice turn (the continuation manager's behavior, not suppressible); the `jspace:advisor` section is the durable echo.
- Continuable children require a `sessionPersistence` backend; the advisor preflights it at remount and fails loud while enabled.
- Reviewer seats are host-composed; per-preset seats are not offered.

## Verification

Unit tests cover the digest fold (trailing-window identity, char caps), consult gating and settle mapping, trigger classification and coalescing, and the invariant's trigger-precedence check. A Loader-booted real-composition test (modeled on `agent-seats`' `loader-composition.spec.ts`) boots a test-only `cordis.yml` with a stub provider and asserts `jspace_consult` registers, is withheld before a card opens, and returns the stub's advice. Per-file 100% coverage on `src` is the CI gate.
