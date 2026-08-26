# Agent Note: Bench runner opt-in trial concurrency

Status: implemented

## Problem

The bench runner executed the interleaved plan strictly one trial at a time. A pre-registered w9 run is 124 trials at about eight minutes each — sixteen hours sequential — even though trials are independent: each already owns a scratch dir and session-log root, and McNemar pairing is `taskId+trialIndex`, not wall-clock order. Forcing that independence through wall time made the measurement instrument slower than the design required.

## Decision

`node bench/runner/run.js` accepts `--concurrency <n>`, an integer `>= 1`, default `1`. A worker pool (`mapPool` in `bench/runner/pool.js`) walks the existing interleaved plan and never reorders it. At most n plan entries run at once. Scratch (`runs/<experiment>/scratch/<arm>/<taskId>/<trialIndex>`) and session-log roots (`runs/<experiment>/<arm>/sessions/<taskId>/<trialIndex>`) were already unique per entry, so concurrent workers do not share those directories.

`1` is sequential: item i+1 starts only after item i finishes, progress lines match the historical runner, and `trials.jsonl` appends in plan order. n greater than 1 may complete out of order. Completions share one in-process serial queue that appends one complete JSON line (including the trailing newline) and prints one prefixed progress line at a time, so concurrent `appendFile` calls cannot interleave bytes. Aborted in-flight trials are not written. SIGINT/SIGTERM abort the controller, kill harness/setup/verifier children (SIGTERM then SIGKILL), await their exit, skip `run.json` `endedAt`, and exit 130. A second signal exits immediately.

The report's `loadArm` sorts trials by `taskId` then `trialIndex` before pairing and bootstrap, so an out-of-order file grades identically to a sequential write. Pairing keys, grades, and the plan list are unchanged. Progress lines carry `taskId #trialIndex [arm]`; when n is greater than 1 the runner also prints `running` so interleaved completions stay attributable.

## Alternatives considered

**Default n greater than 1.** Rejected: it would change the historical sequential runner, raise provider QPS without an explicit operator choice, and break the `1` identity the w9 pre-registration assumes.

**Pair-scoped concurrency (only the matching off/on pair at once).** Rejected: that would change which plan entries may overlap and is unnecessary because pairing is by key, not by who ran together.

**Multiple runner processes appending the same `trials.jsonl`.** Rejected: cross-process append needs file locks the in-process queue does not, and one process already owns the plan, manifests, and abort tree.

**Record aborted in-flight trials as `HARNESS_ERROR`.** Rejected: Ctrl+C is not infrastructure noise; writing those rows would inflate the error count of an interrupted experiment. Finished lines already on disk stay; `endedAt` stays empty so the report treats the run as interrupted.

## Consequences

Operators opt in per experiment. Higher n increases concurrent provider load and can finish the matching off/on pair of one `(task, trial)` at different times; that does not affect McNemar pairing. `SHRES_HOME` remains experiment-wide (session persistence and the session-query index still redirect per trial). An abort can drop a trial that finished in the same tick as the signal. The serial queue does not make a torn last line impossible if the runner process is SIGKILL'd mid-`appendFile` — the same crash window the sequential runner had.

## Testing

`node --test bench/tests/*.test.js` covers `--concurrency` parse failures, pool ordering and abort, serialized overlapping writes, concurrency-1 identity against the default sequential run (progress lines and trial keys), a fake-harness gate that proves n=3 reaches three in-flight starts, out-of-order pairing counts, abort leaving well-formed JSONL and empty `endedAt`, and `loadArm` grading a reversed `trials.jsonl` identically after sort.

## Related

- [J-Space W0 benchmark suite](2026-08-18-jspace-w0-benchmark-suite.md) — owns the interleaved plan, per-trial isolation, and incremental `trials.jsonl` this pool runs.
- [W0 eval arms and decision rules](../../proposed/testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md) — the 124-trial w9 design whose wall-clock this flag shortens.
