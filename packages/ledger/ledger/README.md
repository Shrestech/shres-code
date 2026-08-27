# @shres-code/shres-code-ledger

The **`LedgerService`** (`ctx.ledger`) defines WHAT decision recording the harness has — record a decision, query recorded decisions — without binding the model contract to one store's API shape.

This package owns the Service Definition role of the decision-ledger capability, plus the durable JSONL store that backs it. The tool role lives in a sibling package:

| Package | Role |
|---|---|
| `@shres-code/shres-code-ledger` (this) | Service Definition + durable store: the service contract, the decision record/query vocabulary, the required-field validation and spec step, the failure taxonomy, and the log-only `ledger/decision` session event |
| `@shres-code/shres-code-tool-ledger` | Consumer: the model-facing `ledger_record_decision` / `ledger_query` tools |

The seam follows the [capability seam](../../../docs/glossary.md#capability-seam) definition: a Service Definition / Service Provider / Consumer trio, complete, never one role. This package combines the Service Definition and the file-backed provider.

## Service API (`ctx.ledger`)

| Member | Semantics |
|---|---|
| `record(session, request, callId)` | Validate the request, allocate a branded `LedgerEntryId`, resolve every cited run id against the mounted tracker service, delegate to the provider, and write the log-only `ledger/decision` event. Returns the record outcome — the id is always present, with a failure reason when the record did not land. |
| `query(filter)` | Query the provider's authoritative entry store; filters on decision, hypothesis substring, and recency are optional. |

Providers implement the abstract persistence hooks `persistRecord`, `queryEntries`, and `hasEntry`; the seam's concrete `record`/`query` own defaulting, id allocation, evidence resolution, and event logging so validation and logging never vary by provider.

## Request/spec split

`record` accepts a `LedgerRequest` and resolves it through the pure, exported `resolveRecord(request): LedgerSpec`. That step rejects a blank `hypothesis` or `rationale` (`required-field`), an `accepted`/`rejected` decision that cites no run id (`missing-run`), a `deferred` decision that cites any run id (`deferred-cites-runs`), and an artifact uri that does not start with `modelstore://` (`invalid-artifact-uri`), and defaults `evidence.artifactUris` to an empty list. Providers and `run()` paths never re-default — they receive an already-resolved spec.

## Evidence resolution

`accepted` and `rejected` decisions require at least one cited run id, and every cited run id must resolve through the mounted tracker service (`ctx.tracker.queryRuns`). A run id that resolves to nothing is a named failure `unresolved-run`. A `deferred` decision cites no evidence by definition, so it requires zero run ids.

## Durability

The file-backed provider appends every recorded entry to an append-only JSONL file at the required `storagePath` config field (an empty string fails loud at mount) and mirrors it into an in-memory query index, so `query` answers without re-reading the file. A corrupt store line fails loud with the line number (`corrupt-store`).

## Vocabulary

`LedgerRequest` (`hypothesis`, `decision`, `evidence`, `rationale`) → `LedgerRecordResult`. A result is either `{ kind: 'recorded', entryId }` or `{ kind: 'failed', entryId, reason }`; the `reason` is the validation/store failure taxonomy — `required-field`, `missing-run`, `deferred-cites-runs`, `invalid-artifact-uri`, `unresolved-run`, or `corrupt-store` — surfaced verbatim so the model sees why a record did not land. `query` returns `LedgerEntry[]`.

## Session events

`record` writes the log-only, `ignorable` event `ledger/decision` (declared by declaration merging in `src/types.ts`), carrying `{ entryId, hypothesis, decision, runIds, callId }`. The event is written only after the provider returns, so a replay can follow the record to its store entry.

## Model Experience

### Via tool-ledger

#### What the model sees

Nothing directly. `tool-ledger` renders bounded record results and the exact failure reason; this seam contributes no prompt section or schema.

#### Token effect

Zero from the seam itself; every model-visible byte is owned by the consumer.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Single-writer, load-once index** — the store loads its JSONL into memory at mount; a second session or process over the same `storagePath` never sees the other writer's entries until restart, and there is no cross-writer coordination. Relative `storagePath` values resolve under the harness home.


- **No live decision store** — the seam's `persistRecord` contract is defined here, and the file-backed provider is the only implementation; a remote decision store is deferred.
- **`ledger/decision` carries no git sha or artifact uris** — the event payload is the minimal `{ entryId, hypothesis, decision, runIds, callId }`; the full evidence is reconstructable from the store entry.
