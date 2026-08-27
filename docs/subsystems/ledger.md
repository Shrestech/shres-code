# Decision Ledger

Types shared by `ctx.ledger` and the model-facing ledger tools. The [package README](../../packages/ledger/README.md) owns composition; this page records the request/spec vocabulary, branded entry id, validation failure taxonomy, and durable entry record from [`packages/ledger/ledger/src/types.ts`](../../packages/ledger/ledger/src/types.ts).

`LedgerEntryId` is a [branded id](core.md#branded-ids). The seam assigns every record an id before validation, including records that fail validation, so a `ledger/decision` event and its store entry always agree.

```ts type-equiv
/**
 * An opaque decision-ledger entry id. Branded so an entry id cannot be passed
 * where another string-bearing id is expected. Constructed by
 * {@link newLedgerEntryId}; the seam assigns every record an id, including
 * records that fail validation, so a `ledger/decision` event and its store
 * entry always agree.
 */
type LedgerEntryId = Branded<'LedgerEntryId'>
```

```ts type-equiv
/** The decision reached on a hypothesis. */
type Decision = 'accepted' | 'rejected' | 'deferred'
```

`record` accepts a `LedgerRequest` and resolves it through `resolveRecord(request): LedgerSpec`. That step rejects blank `hypothesis`/`rationale`, requires at least one `evidence.runIds` entry for `accepted` and `rejected`, requires zero run ids for `deferred`, and defaults `evidence.artifactUris` to an empty list. Providers never re-default. `record` then re-executes every cited run's machine rule through `ctx.tracker.verifyDecisionRule` — an `accepted` or `rejected` decision fails with `unverified-run` unless every cited run verifies `satisfied`, making the mechanical-verdict rule an invariant of the ledger store itself; `deferred` cites no evidence and is verified at acceptance time.

```ts type-equiv
/**
 * A caller's decision REQUEST. `hypothesis`, `decision`, `evidence.runIds`,
 * and `rationale` are required and enforced by {@link resolveRecord};
 * `evidence.gitSha` and `evidence.artifactUris` are optional and defaulted by
 * {@link resolveRecord}.
 */
interface LedgerRequest {
  /** The hypothesis the decision addresses. */
  readonly hypothesis: string
  /** The decision reached. */
  readonly decision: Decision
  /** The evidence cited for the decision. */
  readonly evidence: {
    readonly runIds: readonly TrackerRunId[]
    readonly gitSha?: string
    readonly artifactUris?: readonly string[]
  }
  /** Why the decision was reached. */
  readonly rationale: string
}
```

```ts type-equiv
/**
 * The evidence cited for a decision. `runIds` are experiment runs that must
 * resolve through the mounted tracker service; `artifactUris` are
 * `modelstore://` URIs.
 */
interface LedgerEvidence {
  /** Experiment run ids cited as evidence. */
  readonly runIds: readonly TrackerRunId[]
  /** Git commit the evidence reproduced. */
  readonly gitSha?: string
  /** Artifact `modelstore://` URIs cited as evidence. */
  readonly artifactUris: readonly string[]
}
```

```ts type-equiv
/**
 * A fully resolved decision spec: the {@link LedgerRequest} with
 * `evidence.artifactUris` defaulted to an empty list. Handed to providers by
 * {@link resolveRecord}; `run()` paths never re-default.
 */
interface LedgerSpec {
  readonly hypothesis: string
  readonly decision: Decision
  readonly evidence: LedgerEvidence
  readonly rationale: string
}
```

```ts type-equiv
/** Filters for {@link LedgerService.query}. Every field is optional; absent fields are not applied. */
interface LedgerFilter {
  /** Match entries for one decision. */
  readonly decision?: Decision
  /** Match entries whose hypothesis contains this substring. */
  readonly hypothesisSubstring?: string
  /** Epoch milliseconds; return entries recorded on or after it. */
  readonly since?: number
}
```

```ts type-equiv
/** One durable decision entry returned by {@link LedgerService.query}. */
interface LedgerEntry {
  readonly entryId: LedgerEntryId
  readonly hypothesis: string
  readonly decision: Decision
  readonly evidence: LedgerEvidence
  readonly rationale: string
  /** Epoch milliseconds when the entry was recorded. */
  readonly recordedAt: number
}
```

```ts type-equiv
/**
 * Why a decision record did not land. Validation failures and store failures
 * carry the reason so the model sees the distribution verbatim instead of a
 * generic failure.
 */
type LedgerFailureReason =
  | 'required-field'
  | 'missing-run'
  | 'deferred-cites-runs'
  | 'unresolved-run'
  | 'unverified-run'
  | 'corrupt-store'
```

```ts type-equiv
/**
 * A record outcome. Every record is assigned an id (validation failure is a
 * result, not an error path); a failed record carries the
 * {@link LedgerFailureReason} so the tool can surface why it did not land.
 */
type LedgerRecordResult =
  | { readonly kind: 'recorded'; readonly entryId: LedgerEntryId }
  | { readonly kind: 'failed'; readonly entryId: LedgerEntryId; readonly reason: LedgerFailureReason }
```

`record` writes the log-only, `ignorable` event `ledger/decision`, carrying the entry id, the decision, the cited run ids, and the producing `ledger_record_decision` call id.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxledger--ledgerservice-abstract-seam"></a>

### `ctx.ledger` — `LedgerService` (abstract seam)

The abstract decision-ledger service. Registered as `ctx.ledger` (one provider per context; loading a second throws cordis' standard duplicate-service behavior). A provider subclasses this, implements the three abstract persistence hooks, and loads the subclass as a plugin.

Implementations must honor these semantics:

- persistRecord persists a resolved decision spec under its entry id.
- queryEntries reads the provider's authoritative entry store.
- hasEntry reports whether an entry id is present in the store.

```ts cordis-catalog
/**
 * Persist a resolved decision spec under its entry id. Implemented by the
 * provider.
 * @param entryId - the id the seam allocated for this record.
 * @param spec - a resolved spec from {@link resolveRecord}, never a raw request.
 */
abstract persistRecord(entryId: LedgerEntryId, spec: LedgerSpec): Promise<void>

/**
 * Query entries from the provider's authoritative store.
 * @param filter - optional filters; absent fields are not applied.
 * @returns the matching entries.
 */
abstract queryEntries(filter: LedgerFilter): Promise<LedgerEntry[]>

/**
 * Whether the provider's store holds an entry with the given id. Synchronous
 * so the invariant companion can check a `ledger/decision` event against the
 * store without awaiting a query.
 * @param entryId - the entry id to look up.
 * @returns whether the entry is present.
 */
abstract hasEntry(entryId: LedgerEntryId): boolean

/**
 * Record a decision. Resolves and validates the request, allocates the entry
 * id, resolves every cited run id against the mounted tracker service, and
 * delegates to the provider. A validation or store failure returns a failed
 * result carrying the {@link LedgerFailureReason}; the log-only
 * `ledger/decision` event is written only after the provider returns, so the
 * log reflects the record outcome exactly as the caller received it.
 * @param session - owning session; the decision event is appended to its log.
 * @param request - the caller's decision request (validated and defaulted here).
 * @param callId - the tool-call id of the `ledger_record_decision` call that produced the record.
 * @returns the record outcome with the allocated entry id.
 */
async record(session: Session, request: LedgerRequest, callId: CallId): Promise<LedgerRecordResult>

/**
 * Query entries from the provider's authoritative store.
 * @param filter - optional filters; absent fields are not applied.
 * @returns the matching entries.
 */
async query(filter: LedgerFilter): Promise<LedgerEntry[]>
```

Types: [CallId](llm-streaming.md) · [Session](session.md)

Source: [`packages/ledger/ledger/src/index.ts:67`](../../packages/ledger/ledger/src/index.ts)
<!-- END GENERATED cordis-surface -->
