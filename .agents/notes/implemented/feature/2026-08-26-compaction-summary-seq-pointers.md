# Agent Note: Compaction summaries carry seq pointers into the elided log

Status: implemented

## Problem

Compaction replaces a span of the model-visible surface with a summary. The lossless session log still holds every shadowed event, but the summary the model sees named none of them, so recovering a compacted tool result or decision required spontaneous use of session-query. That did not happen: session-query was mounted in every relevant eval arm and called zero times across more than one hundred trials. Item 6 of the [J-Space contract plan](../../proposed/feature/2026-08-26-jspace-contract-and-harness-hardening.md) required summaries to carry sequence references on the compaction checkpoint, not the J-Space card, so retrieval becomes instruction-following at the moment of need.

The [session-query adoption experiment](../testing/2026-08-26-session-query-adoption-experiment.md) then showed the model dereferences a named prior-session reference when it is visible at the moment of need (16/16 trials). Harness auto-dereference is the recorded fallback only if that experiment returned zero; it did not.

## Decision

`compaction-basic` appends code-assembled seq-pointer lines to every successful summary. The summarizer still writes the checkpoint prose; code selects up to `maxPointers` salient shadowed surface nodes and formats one markdown bullet each. Pointers are extra text blocks in `compaction/summary` `data.summary` and therefore inside the replacement `user/message` `<compacted-summary>` body. `rawOutput` stays the summarizer output. Nothing is written onto the J-Space card.

Selection order is deterministic: `tool/result` first (subject `full output of <tool name>`), then `user/message` (`prior checkpoint` when `isCompactCheckpointSource`, otherwise `user message`), then `assistant/message` only when the span has neither of those. Each line is:

```
- full output of bash at seq 15 — session_event_read this session, seq 15
```

`session_id` is omitted so `session_event_read` targets the current session, which is how that tool already names "this session." Tool names resolve from a cited or preceding `tool/call` in the lossless log.

`maxPointers` is a validated top-level `BasicCompactionConfig` field, default `8`, inclusive range `0`–`64`. `0` emits no pointer section. It is not a per-model policy override.

The [recallable-compaction proposal](../../proposed/feature/2026-07-06-recallable-compaction.md) remains open: this change does not add frozen index stubs, a mutable state checkpoint, `history_read` / `history_search`, or a second backend.

## Alternatives considered

**Harness auto-dereference (inject shadowed events at the elision point).** Rejected by the adoption experiment: named references were followed, so the contract plan's fallback did not trigger.

**Model-authored pointers in the summarizer prompt.** Rejected: seqs must be exact; the [recallable-compaction proposal](../../proposed/feature/2026-07-06-recallable-compaction.md) already recorded that deterministic assembly is required.

**Put pointers on the J-Space card.** Rejected: the card reprints every turn and must not grow with history. Pointers belong on the checkpoint that replaces the elided span.

**New `history_read` tools instead of `session_event_read`.** Rejected for this item: session-query already resolves current-session seqs, and the adoption task exercised those tools. A dedicated recall consumer remains a larger open design.

## Consequences

Each compaction pays a small, `maxPointers`-capped number of extra input tokens on later turns. Pointers that would make the framed checkpoint not strictly smaller than the shadowed span are dropped from the least-salient end until it shrinks, including all of them. The model still has to call `session_event_read`; unused pointers are wasted tokens, not recovered facts. `maxPointers` may omit some elided events. A later summarizer pass may rewrite pointer prose inside a prior checkpoint; each new pass re-emits pointers for its own shadowed span, including the prior checkpoint as a two-hop target.

## Testing

Package tests cover selection rank and cap, checkpoint vs user labels, tool-name resolution, `maxPointers: 0`, load-time validation, and that pointer lines ride in `compaction/summary` and the framed replacement while `rawOutput` stays summarizer-only. `bench/tasks/compaction-pointer-follow` is the acceptance-criteria task: a one-time token exists only in an early tool result after setup plants a consumed stamp; correct `LEASE_TOKEN` plus `metrics.sessionQueryCalls` scores follow. Run it with `bench/pressure/forced-compaction.patch.yml` so compaction fires mid-session. The existing keyless `compaction-recovery` headless snapshot runs live overflow compaction through `llm-replay` and now asserts the pointer section on the logged summary.
