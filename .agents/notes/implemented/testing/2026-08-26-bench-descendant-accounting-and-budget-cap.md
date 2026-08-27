# Agent Note: bench descendant-inclusive accounting and the live token cap

Status: implemented

## Problem

The bench could not price subagent arms. `tokensIncludingDescendants`/`costIncludingDescendants` were hard `null`: the runner folds only the top-level `delegationDepth: 0` session log, and the schema comment called a recursive walk "fragile and untested in v1". Score-at-budget experiments also had no live enforcement — `BUDGET_EXCEEDED` existed as a failure mode but nothing could produce it. Prime-Agent-style swarm claims (states-per-dollar, experiments-per-dollar) need root-plus-descendants spend ([roadmap WP0.1](../../proposed/feature/2026-08-26-beat-prime-agent-roadmap.md)).

## Decision

Two additions to the standalone bench runner, no workspace dependencies:

1. **Descendant accounting is a header-keyed BFS, not a path walk.** [`bench/runner/descendants.js`](../../../../bench/runner/descendants.js) enumerates every `session.jsonl` under the trial's session-log root, reads each header's `id`/`parentSession`, and closes over the root's descendant set by parent links. Path shape encodes nothing; a malformed parent cycle cannot loop the walk (visited set). The numerator is `assistant/message` `usage` input+output tokens only — identical to the root fold in `metrics.js` — so root and tree numbers stay comparable; token-meter's `assistant/chunk` fallback is deliberately not duplicated. Seeded `bench-prior-*` fixtures are excluded, matching `findSessionLog`. A torn final line (child killed mid-append) is tolerated; a corrupt line before the end throws, the same stance as `foldSessionLog`.
2. **The cap is a live watcher, not post-hoc filtering.** [`bench/runner/usage-watcher.js`](../../../../bench/runner/usage-watcher.js) polls the session-log root every `BUDGET_POLL_MS` (5 s), absorbing only bytes appended since the last poll and holding back torn lines. When the running total exceeds `--max-total-tokens`, `executeTrial` SIGTERMs the child (SIGKILL after the existing grace) and the trial records `BUDGET_EXCEEDED` when the verifier does not resolve it — a delivered verdict in the timeout class, never infrastructure noise. The cap is pinned in `run.json` so a pre-registration is checkable; `success(B)` at budgets below the cap stays post-hoc filtering over `tokensIncludingDescendants`.

`costIncludingDescendants` stays null: no price table exists in-tree, stale prices are wrong prices, and inventing one would be a hardcoded tunable. Token fields remain the cost currency until a priced tier config exists.

## Consequences

Subagent arms are now priceable in tokens: any arm that spawns children reports tree-inclusive spend alongside root spend, and pre-registered budget grids can terminate trials that overspend. The watcher adds one poll per 5 s per in-flight trial reading only appended bytes, so the sequential runner's overhead is negligible. The token numerator is now pinned to `assistant/message` usage for both root and tree; adopting token-meter's chunk-fallback semantics would change both at once, not just the tree field. `BUDGET_EXCEEDED` is a delivered verdict class, so pass rates stay comparable between capped and uncapped runs only when the cap is part of the pre-registration — an uncapped control paired against a capped treatment measures the cap, not the harness.

## Testing

`node --test` in `bench/`: planted persistence roots cover closure selection (unrelated trees excluded), seeded-fixture exclusion, torn-tail tolerance, corrupt-interior rejection, cycle safety, incremental watcher absorption, and torn-line hold-back. Full suite: 254 passing. Demo generator emits the new `descendantSessions: 0` field; `validateRunManifest` treats an absent `maxTotalTokens` as uncapped, which is the historical fact for w4–w9 manifests.

## Alternatives considered

**Walk by directory depth (`depth>0` headers) instead of parent links.** Rejected: depth is derivable but parent links are the durable relationship; fork chains and future transport children make depth-encoding brittle, and the schema's own comment named exactly this fragility.

**Reuse token-meter's `usageOf` (chunk+fallback) for the walker.** Rejected for symmetry: the runner's root metrics count `assistant/message` usage only, so a chunk-aware walker would use a different numerator than the root row it extends. Symmetry wins over coverage; both change together if ever.

**Post-hoc-only budget enforcement (mark BUDGET_EXCEEDED at fold time).** Rejected: a terminated trial stops spending; a post-hoc mark lets an over-budget run bill the full amount before being classified, defeating score-at-budget experiments.

**Record cost with an assumed price table.** Rejected: pricing is deployment-varying; a hardcoded table is a stale-price bug the repo rules forbid.
