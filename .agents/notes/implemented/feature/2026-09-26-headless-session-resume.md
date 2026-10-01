# Agent Note: Headless multi-turn trials resume one persisted session per spawn

Status: implemented

## Problem

The routing benchmark drives one `shres --profile headless` spawn per scripted user turn, and every spawn before this change created a fresh session: a second turn could not see the first turn’s durable log, and the runner passed an explicit `agentOptions` provider/model on creation, which on a continued session would override the route the log records. Multi-turn arms need the opposite: one session id per trial, one spawn per turn, and a resumed spawn whose requests follow the durable route even when the resuming composition differs from the one that routed the earlier turns. The durable-route precedence itself is owned by the [model-selection record](../../../../packages/core/agent/src/model-selection.ts) in the agent package; this note covers the headless entry point that must not stand in its way.

## Decision

The `headless-startup` command line gains `--session-id <id>` (create the fresh session under the given id instead of a generated one) and `--resume <id>` (continue a persisted session). The two flags are mutually exclusive and each still requires the task positional; both travel through the ordinary `headlessStartup` service into validated runner config fields, and naming both identities in the config is rejected at mount.

Resume validates before anything is published and never falls back to a fresh session. A spawn with no session-persistence backend, an unknown id (the persistence `inspect` not-found error), or a persisted header whose `cwd` differs from the current working directory exits 1 with a named message. The cwd check reads the header through `inspect`, which publishes and commits nothing, so a failed resume leaves no session, agent, or log behind.

A resumed acquisition calls `agents.resume({ resumeSessionId, setup })` with no `agentOptions`: the session-local selection the shared setup provides reads `selectionInForce` from the log — an explicit `agent/model-selection`, the router’s sticky state, the manual base recorded beneath the last routed header, then the last header — so a routed session returns to its manual base even in a tree that composes no router, and this spawn’s composition default never overrides the log. The post-resume path is the fresh path: `whenIdle`, one follow-up, `whenIdle`, flush, and a summary that folds only events from the resume-time `seq` onward. The launcher’s per-spawn timeout, abort, and exit-code handling is unchanged, and the runner writes nothing into the log it resumes.

## Consequences

Multi-turn work is one spawn per turn with the same `--resume <id>`; the spawn’s stdout is only its own interval’s final text, and the persisted log grows append-only across spawns. A trial’s later phases may boot a different patch overlay than phase 0 — dropping the router is how the routed-to-manual recovery is observed. An explicit `--session-id` that collides with an existing log still fails loud through the persistence layer’s existing collision errors; there is no adopt-or-recreate fallback. The resume pre-check reads the header once more than a bare `agents.resume` would; coordinator-backed backends retain the inspected source for the following `prepare`, so no log is parsed twice.

## Alternatives considered

Feeding scripted follow-ups to one process over stdin keeps a single spawn but adds a second driver lifecycle to a one-shot bundle and changes its timeout, abort, and exit contract; rejected. Falling back to a fresh session when a resume fails keeps the run alive but silently diverges from the session the caller named; rejected. Checking the persisted cwd after `agents.resume` returns avoids the extra read but publishes the session and announces the agent before failing; rejected.

## Verification

Focused unit tests cover flag parsing, exclusivity, and the task requirement at the provider; the explicit create id; the resumed summary folding only its own interval; the absent `agentOptions` on resume; and the three named exit-1 failures. A keyless two-spawn snapshot ([`headless-resume.snapshot.ts`](../../../../examples/headless-agent/tests/headless-resume.snapshot.ts)) drives the real product headless profile twice against a loopback stub model endpoint and jsonl persistence: turn 1 routes to the candidate under the router, turn 2 resumes in an overlay without the router, and the snapshot pins the append-only same-session log, the `request/header` reason `resume`, the manual-base model on turn 2, and the second-turn-only stdout.
