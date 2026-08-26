# Agent Note: Read defaults and result-retention tuning

Status: implemented

## Problem

Data-heavy trials lose the middle of oversized tool results on the model-facing surface. The pruner kept a head and tail with a generic omission marker that did not name how to recover the omitted span. The omitted middle already stays in the append-only session log, but the model was not told the seq or the re-fetch command. `readLimit` 2000 and the pruner head/tail budgets are deployment-varying, so they belong on validated Config, not as unconfigurable constants.

## Decision

`readLimit`, `readMaxLineLength`, `readMaxBytes`, and `readStreamMinSize` remain validated Config fields on `@shres-code/shres-code-tool-fs` (defaults 2000 / 2000 / 51200 / 10485760). `thresholdChars`, `headChars`, and `tailChars` remain validated Config fields on `@shres-code/shres-code-compaction-tool-result-pruner` (defaults 8192 / 4096 / 1024). Shipped defaults are unchanged.

When the pruner replaces an over-budget `tool/result`, the omission marker names the original log seq and the exact re-fetch command `session_event_read this session, seq N` — the same cue compaction-basic's seq pointers use ([`POINTER_READ_CUE`](../../../../packages/compaction/compaction-basic/src/pointers.ts)). The omitted middle stays in the session log; the surface replacement does not delete it. Config validation budgets the longest possible marker (`Number.MAX_SAFE_INTEGER` digits) so a later large seq cannot grow a replacement past `thresholdChars`.

Middle-loss is documented on both package READMEs: a `read` window that later gets pruned is recoverable by seq; paging with `offset`/`limit` is how to cover a file the line cap cannot hold in one call.

This is [roadmap WP1.5](../../proposed/feature/2026-08-26-beat-prime-agent-roadmap.md).

## Alternatives considered

**Leave the generic `[... tool result middle pruned ...]` marker.** Rejected — a model that needs the omitted span has no command or seq to follow. sq-adopt showed a task-level cue at the moment of need is what gets used.

**Import compaction-basic's `POINTER_READ_CUE`.** Rejected — the pruner is an optional companion of compaction-basic; depending on the summarizer would invert the package graph. The cue text is duplicated and must stay identical.

**Change shipped `readLimit` / pruner defaults for data-heavy flows.** Rejected for this WP — defaults stay; deployments raise the Config fields. A follow-up measurement is pre-registered on the [roadmap WP1.5](../../proposed/feature/2026-08-26-beat-prime-agent-roadmap.md) if shipped defaults later change.

**Put re-fetch guidance only in the `read` system-prompt section.** Rejected — pruning applies to every oversized tool result, and the sq-adopt lesson is that a cue at the moment of need beats a standing prompt line. The marker carries the command; the `read` prompt keeps paging guidance.

## Consequences

Pruned surface text is longer by the seq-named marker than the previous fixed phrase; Config still requires head + longest marker + tail to fit in `thresholdChars`. Replay still emits a `compaction/prune` shadow-price event immediately before each replacement. Callers of `pruneContent` must pass the original log seq.
