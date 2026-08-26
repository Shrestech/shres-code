# @shres-code/shres-code-compaction-tool-result-pruner

The replay-safe model-free pruning service (`ctx.toolResultPruner`). It rewrites over-budget `tool/result` surface nodes to a bounded head, an omission marker that names the original log seq and `session_event_read this session, seq N`, and a bounded tail, while retaining the full original event in the append-only session log.

This is a concrete companion to [`shres-compaction-basic`](../compaction-basic/README.md), not a compaction backend or model-facing tool. Compact-basic reads it through optional `ctx.get('toolResultPruner')`, so either package remains independently composable.

## Service API

`pruneSession(session)` scans one stable snapshot of the current surface. Every over-budget tool result is replaced by one newly appended `tool/result` carrying `{ surfaceOp: { op: 'replace', start: originalSeq, end: originalSeq }, sourceEventSeqs: [originalSeq] }`. The replacement spreads the complete original data and changes only `content`, preserving `turn`, `step`, `callId`, error fields, `meta`, and later data additions. The original event remains available for persistence, replay, and exact-log inspection.

The method throws synchronously when the session rejects a replacement. Replacements committed earlier in the pass remain durable.

`measureContent(blocks)` counts Unicode code points in `text` blocks. `pruneContent(blocks, originalSeq)` returns the bounded replacement or `null` when content is already within the threshold. The marker names `originalSeq` so the model can re-fetch the omitted middle with `session_event_read`. Non-text blocks are retained at their original relative positions; text slicing never splits a UTF-16 surrogate pair, though it can split a multi-code-point grapheme cluster.

Every emitted result has the configured head budget, the seq-named marker, and the configured tail budget in text code points, is no larger than `thresholdChars`, and is strictly smaller than the triggering input. A second pass therefore emits no replacement. Config validation budgets the longest possible marker so a later large seq cannot grow a replacement past the threshold.

## Config

Unrecognized keys fail at plugin construction. Resolved config is detached and deeply immutable.

| Key | Required | Meaning |
|---|---|---|
| `thresholdChars` | no (default `8192`) | Prune when combined text exceeds this many Unicode code points. |
| `headChars` | no (default `4096`) | Leading Unicode code points retained. |
| `tailChars` | no (default `1024`) | Trailing Unicode code points retained. |

All values are integers; the threshold is positive and head/tail are non-negative. `headChars + marker + tailChars` must fit within `thresholdChars`, so a valid configuration can prune every over-budget result without growth or repeated rewriting.

## Usage

```ts
import type { Context } from '@shres-code/cordis'
import ToolResultPruner from '@shres-code/shres-code-compaction-tool-result-pruner'

export function apply(ctx: Context): void {
  ctx.plugin(ToolResultPruner)
}
```

## Model Experience

### Pruned tool result

#### What the model sees

Once a compaction trigger qualifies, future requests see the retained head, an omission marker naming the original log seq and `session_event_read this session, seq N`, and the retained tail. The omitted middle stays in the append-only session log; it is not deleted. Rich blocks keep their order. The model does not see a second copy of the original on the surface.

#### Token effect

Each rewritten tool result has at most `thresholdChars` text code points. Pruning itself makes no model call; compaction-basic skips summarization when the remeasured request falls below pressure, otherwise the summarizer reads the pruned surface.

#### KV Cache effect

Replacing an earlier result invalidates reuse from the first changed token. The pruned prefix is eligible for reuse while its route, envelope, and preceding history remain identical.

## Known Limitations and Deferred Work

- **Character budgets are not token budgets** — provider token density varies, so `ctx.tokenMeter` remains the authority for deciding whether pruning relieved request pressure.
- **Pruning is syntactic** — it retains the beginning and end without interpreting which middle lines are semantically important. The omitted span is a middle-of-result loss on the surface only; re-fetch the original with `session_event_read this session, seq N` using the seq named in the marker.
- **The marker length depends on the seq digit count** — config validation budgets the longest possible marker (`Number.MAX_SAFE_INTEGER` digits) so a later large seq cannot grow a replacement past `thresholdChars`.
- **Grapheme clusters can split** — code-point slicing protects surrogate pairs but does not perform locale-aware grapheme segmentation.
