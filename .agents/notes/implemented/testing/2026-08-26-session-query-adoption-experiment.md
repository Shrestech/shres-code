# Agent Note: Session-query adoption experiment (prior-session seed + driver-line arm)

Status: implemented

## Problem

Session-query was mounted in every relevant eval arm and called zero times across more than one hundred trials, recorded in the [W0 eval note](../../proposed/testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md) and the [J-Space contract plan](../../proposed/feature/2026-08-26-jspace-contract-and-harness-hardening.md). Compaction pointers (contract plan item 6) convert retrieval from initiative into instruction-following only if the model will dereference the lossless log at all. Without a task whose needed fact exists only in a prior session's event log, a driver-line contrast cannot distinguish "the model will not look" from "no trial ever needed to look." The recorded fallback if adoption stays zero is harness-side auto-dereference, not a further-improved prompt.

## Decision

`bench/tasks/session-query-adoption` is a pressure task whose correct completion requires exporting `ORIGIN_STATION = 'QX7K-ALPHA'`. That code lives only in `prior-session.jsonl`. The prompt tells the agent to continue where the previous session left off and that the session recorded the origin-station decision; it does not state the code and does not name `session_search`. The fixture's `src/origin.js` exports `''`, and the pinned tests accept any `/^[A-Z0-9-]+$/` station, so a guessed substitute can turn the suite green and still fail the verifier.

Optional `task.json` `setup` runs `node setup.mjs <scratch-dir> <session-log-root>` after the fixture copy and the session-root pre-existence audit, and before the harness spawn. A failed setup is `HARNESS_ERROR`. `session-query-adoption` setup rewrites the fixture header `cwd` to `realpath(scratchDir)` — headless stamps `process.cwd()`, and session-query workspace authority is exact string equality — then writes the log at the JSONL identity path (`--<projectKey(cwd)>--/<encodeSegment(id)>/session.jsonl`) so `sessionPersistence.list()` will index it. `bench/runner/session-layout.js` copies that encoding because the bench tree does not import workspace packages. Session id `bench-prior-session-query-adoption` uses the reserved prefix `bench-prior-`; `findSessionLog` skips those ids so a planted prior is never folded as the trial transcript. If the spawn never writes a live log, the locator returns null rather than treating the prior as a successful run.

The verifier scores only the shipped workspace: pinned `test/quote.test.js` bytes, `node --test` green, and `ORIGIN_STATION === 'QX7K-ALPHA'`. Adoption is `metrics.sessionQueryCalls` from the trial log (`session_search` / `session_event_search` / `session_event_read` / `session_event_trace` / `session_trace`), the same fold that already feeds the report's SQ column. A resolved trial with `sessionQueryCalls === 0` means the fact arrived by some other path (guess or filesystem); that is still a measured outcome.

`sq-driver` is identical to `sq-only` (session-query mounted, jspace disabled) plus a wholesale `system-prompt` config replace that restates the headless persona and appends `SESSION_QUERY_DRIVER_LINE`, which names `session_search` / `session_event_search` / `session_event_read` at the moment of need. The adoption contrast is `--arms sq-only,sq-driver --tasks session-query-adoption`. `sq-driver` is not in the synthetic demo arm set.

## Alternatives considered

**Put the fact in a workspace file the prompt says not to open.** Rejected: file tools would read it, so the trial would not measure log dereference.

**Restate the recorded decision in the prompt.** Rejected: that measures instruction following, not retrieval from the durable log.

**Bake a cwd into the fixture JSONL.** Rejected: session-query admits a cross-session target only when `header.cwd` equals the live session's cwd exactly; a placeholder rewritten at setup is the only deterministic way to satisfy that under a fresh scratch dir.

**Use a chain task so phase 1's conversation is the prior.** Rejected: chain phases are cold carry today — each spawn is a new session, and the needed fact would have to survive in the workspace, which this experiment forbids.

**Treat a planted prior as the trial transcript when the spawn writes nothing.** Rejected: folding the prior would fake a successful harness run and hide `HARNESS_ERROR`.

**Skip the driver-line arm and jump to auto-dereference.** Rejected: the contract plan's recorded fallback fires only after this contrast; a named-tool driver line is the cheap test of initiative versus instruction-following.

## Consequences

The bench catalog has an 18th pressure task and an optional setup slot. The arm ladder has eight entries. Persistence-path encoding is duplicated in `bench/runner/session-layout.js` and must track `shres-session-persistence-jsonl` if that encoding changes. Compaction pointers (contract plan item 6) wait on a powered run of this contrast; this note does not graduate pointers or auto-dereference. Real API trials are scheduled separately and are not part of the instrument.

## Testing

`node --test bench/tests/*.test.js` covers catalog `setup`, overlay driver-line presence, locator skip of `bench-prior-*`, setup failure → `HARNESS_ERROR`, fixture/prompt omission of the secret, verifier discrimination (empty origin, guessed `STATION-1`, weakened tests, recorded code), and a dry-run of `plantPriorSession` that rewrites cwd onto the identity path. No trial in that suite launches a provider.

## Related

- [J-Space contract and harness hardening](../../proposed/feature/2026-08-26-jspace-contract-and-harness-hardening.md) — item 6 owns the pointer-versus-auto-dereference decision this experiment feeds.
- [W0 eval arms and decision rules](../../proposed/testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md) — the arm-ladder and session-query call-count metric this experiment uses.
- [J-Space W0 benchmark suite](2026-08-18-jspace-w0-benchmark-suite.md) — the bench instrument this task and arm extend.
