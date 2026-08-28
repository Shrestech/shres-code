# @shres-code/shres-code-tool-ledger

The model-facing **Consumer** for the decision-ledger seam (`ctx.ledger`). It registers two tools — `ledger_record_decision` and `ledger_query` — and owns their schemas, prompt guidance, and presentation, never provider selection or persistence.

## Tools

| Tool | Semantics |
|---|---|
| `ledger_record_decision` | Record one decision with its required `hypothesis`, `decision`, `evidence`, and `rationale`. Requires an owning agent session (the record is logged to it). Returns the entry id and record status. The record's `ledger/decision` event carries this call's tool-call id. |
| `ledger_query` | Query recorded decisions by `decision`, `hypothesisSubstring`, and `since` (epoch milliseconds), returning their entry ids and evidence. |

## Failure taxonomy surfacing

A record that does not land returns a `failed` status carrying the validation failure taxonomy (`required-field`, `missing-run`, `deferred-cites-runs`, `invalid-artifact-uri`, `unresolved-run`, or `corrupt-store`) verbatim. The model-facing output and the rendered text both include the exact reason, so the model sees why a record did not land rather than a generic failure.

## UI render intent

Decided up front: **generic**. Both tools present via `presentCall` returning a `card: 'generic'` view; there is no terminal/diff or location rendering.

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`ledger_record_decision` and `ledger_query` schemas](../../../docs/tool-catalog.md#shres-codeshres-code-tool-ledger).

#### Token effect

Fixed schema cost on every request where the tools are visible.

#### KV Cache effect

Prefix-stable while the definitions and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Success returns exactly `Recorded decision <entryId>.`, `Decision <entryId> was not recorded (reason: <reason>).`, `No ledger decisions found.`, or a list headed `Ledger decisions:` of `- <entryId> <decision> <hypothesis>` lines. `ledger_record_decision` rejects a caller without an owning agent session.

#### Token effect

Call arguments remain until compaction. Result text is small and scales with the query hit list.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **No concurrency-safety opt-in** — the tools make no `isConcurrencySafe` claim; sequential execution is the safe default until decision recording is proven idempotent.
