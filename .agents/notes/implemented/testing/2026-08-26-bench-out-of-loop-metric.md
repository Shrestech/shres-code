# Agent Note: bench out-of-loop experiment forensics metric

Status: implemented

## Problem

The beat-Prime-Agent campaign needs a process metric — the shape of Prime Agent's nanoGPT "experiments outside the main training loop" figure — to arbitrate whether wave-2 autonomy features (persistent kernel, subagent bus) raise productive experimentation or just tool storms. No comparable quantity existed in the bench, and porting their workload needs GPUs we do not own. Their figure framing is second-hand in [MAPPING](../../../../MAPPING-prime-agent-2026-08-26.md); the metric itself is log forensics ([bench-strategy note](../../proposed/feature/2026-08-26-beat-prime-agent-bench-strategy.md), [roadmap WP0.3](../../proposed/feature/2026-08-26-beat-prime-agent-roadmap.md)).

## Decision

`outOfLoopExperiments` counts exactly two durable event classes, nothing heuristic:

1. `run_code` tool calls ([`bench/runner/metrics.js`](../../../../bench/runner/metrics.js)) — programmatic computation outside the conversational tool loop, counted by `foldSessionLog` per session and summed over the trial tree by the [`descendants.js`](../../../../bench/runner/descendants.js) walk.
2. Delegated experiments — one per descendant session with header `origin: 'subagent'` ([`child-agent.ts`](../../../../packages/subagent/subagent/src/child-agent.ts) stamps it). The durable header is the counter, not a tool-call name, because the delegation tool name is configurable per composition.

[`bench/analysis/out-of-loop.js`](../../../../bench/analysis/out-of-loop.js) replays every stored run's recorded `sessionFile` through the same walk, zero API spend. The committed table is [`analysis/out-of-loop-stored-runs.json`](../../../../bench/analysis/out-of-loop-stored-runs.json).

## Consequences

The measured baseline over w4–w9, sq-adopt (27 arm rows): **zero out-of-loop experiments at every arm** — no stored composition mounted code-mode or delegation, so all spend was mainline. That is the arbitration floor: any future kernel or bus arm that moves this number does so against a clean zero, and the claim form stays "process traces per 100 mainline attempts," never record comparability with the nanoGPT figure. Counting delegated sessions by header means fork children (no `origin`) are not experiments; if forks ever count, that is a deliberate metric change. `METRIC_FIELDS` now also validates `descendantSessions`, closing a validation gap from the accounting change (extra fields used to pass unvalidated).

## Alternatives considered

**Count session-query reads as experiments.** Rejected: those are cross-session retrieval, not compute; they already have `sessionQueryCalls`. Counting them would blur the process metric the kernel arms must move.

**Classify bash commands into probes vs mainline edits.** Rejected: heuristic text classification of `bash` arguments is not durable-event forensics; two readers of the same log could disagree, which breaks the metric's job of being recomputable.

**Count delegation by tool-call name.** Rejected: `toolName` is configurable (`tool-subagent` config); a renamed tool would silently zero the metric. The header `origin: 'subagent'` is the durable signal.

## Testing

`node --test` in `bench/`: 259 passing — run_code counting in the fold (with and without), delegated-vs-fork distinction (origin header), root exclusion, descendant run_code sums, analysis table over stored runs (zeros with nonzero trials/mainline requests), empty-filter behavior. Fabricated schema fixtures updated to carry the new required fields.
