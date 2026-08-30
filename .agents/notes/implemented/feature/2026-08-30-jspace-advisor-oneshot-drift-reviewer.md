# Agent Note: jspace-advisor one-shot drift reviewer

Status: implemented

## Problem

The first jspace-advisor skeleton (see [the original note](./2026-08-29-jspace-background-advisor.md)) ran proactive reviews through a continuable reviewer child and captured the parent's settlement notice. Design review proved that channel dead three ways: triggers never classify mid-turn, the captured append reenters the session's publication window, and the notice is attributable to any continuable child. The user's intent was also broader than the skeleton: a top-tier reviewer that understands the user's goal from every user message and redirects the main agent when work drifts from it.

## Decision

Both channels now run fresh one-shot reviewer children on one explicit route.

- **Goal anchor is the user-message stream, not the card Goal.** The card Goal is agent-authored and provably placeholder-grade (`always-open` and bare `/j-space on` open Goal "J-Space is on"). The digest carries every source-`user` message oldest-first (first message always retained, per-message and history caps as Config fields), with the card framed as the session's own claim. The trailing tool window renders last so the digest cap truncates it first.
- **Triggers classify mid-turn**; the dead `userTurnOpen` gate is gone. Charter discrimination probes (phase `probe`) are excluded — a demonstrated probe logs `passed: false` and would otherwise fire a bogus charter-fail. Error bursts count across interleaved `tool/call`s and break only at a successful result.
- **A step-cadence drift check** (`driftEverySteps`, default 8, counted from the log since the last advice) wakes the reviewer periodically; the persona returns a structured verdict `on-track | drift` with an optional redirect.
- **The reviewer judges from the digest.** The persona names the digest as sufficient input, forbids reading the reviewer's own session log or searching for other sessions, caps exceptional tool use at one call, and requires every run to end with the structured verdict. Every reviewer child carries the display label **Advisor** in the subagent list (consult and review alike).
- **The `jspace:advisor` prompt section is the redirect channel.** One-shot runs emit no settlement notice; assembly runs per step, so a verdict completing mid-turn reaches the main model in the same turn, durably and framed untrusted.
- **Coalescing is log-derived**: one review in flight, and `suppressReview` blocks new reviews until the user speaks after the latest advice — an ignored redirect never re-fires.
- **Config splits the route from the capability provider**: `provider`/`model` name the reviewer's LLM route (passed as `agentOptions` on both channels — the skeleton's proactive child silently inherited the parent's model), `subagentProvider` (default `spawn`) names the `ctx.subagents` provider.

## Consequences

- The invariant companion no longer re-derives Config thresholds: every `jspace/advisor` event carries `triggerSeq`, and the companion checks the pointed-at event against a config-free per-family predicate plus strictly increasing drift-check pointers. This retires the original note's deferral reason for cadence triggers.
- Default `reviewerTools` is wiki-only: no shipped bundle mounts `tool-session-query`, and subagent tool filters reject unknown names loudly, so the session_query family must be opted in by deployments that mount it.
- Root sessions only; delegated children carry their own folds. Seat-roster (`agent-seats`) reuse is deferred until a live seat-reading service exists.
- Reviewer failures are contained (logged warning, no advice event); plugin disposal aborts in-flight reviews through effect-owned controllers.

## Verification

Unit suites cover the digest fold (user-history retention and elision, trailing window, cap priority), trigger classification (probe exclusion, burst interleaving, drift cadence, suppression), settle mapping, and the triggerSeq predicates (per family, first-card and non-card rejections, drift monotonicity, unknown-family throw). An apply-level harness boots a real Context with the real jspace/session/tools/subagents services and a scripted spawn provider, and drives consult denial and success, the full drift loop (fire, suppress, re-arm on user speech), section rendering for both verdicts, seat-off/fiber-dispose withdrawal, and failure/no-agents/hang aborts. A Loader-booted real-composition spec asserts registration and consult through `tool-jspace`. Per-file 100% coverage on `src` passes with narrow `v8 ignore` annotations on executor-owned defense-in-depth paths.
