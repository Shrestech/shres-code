# Agent Note: Windowed in-memory session log and SQLite busy_timeout/retention

Status: implemented

## Problem

A live `Session` kept every accepted event in RAM for its lifetime. Compaction already shadows replaced surface nodes in `session.surface.nodes`, and persistence already flushes the lossless log, but the in-memory array never released either the shadowed nodes or the log-only events (`assistant/chunk`, turn/step bookkeeping, `tool/call`, and the rest). Long sessions therefore grew without a bound the deployment could set.

The SQLite backend compounded the durable side of the same growth. A connection set no `busy_timeout`, so a second writer failed immediately on `SQLITE_BUSY`. Streaming chunks were stored 1:1 forever with no prune that a later reader could detect. Both gaps are items 10 and 11 of the [harness-hardening plan](../../proposed/feature/2026-08-26-jspace-contract-and-harness-hardening.md). They are independent of the jspace work and do not change the on-disk session format (`SESSION_FORMAT_VERSION` stays `0`) or the SQLite table layout (`SCHEMA_VERSION` stays 15).

## Decision

### What "outside the model surface" is

The in-memory owner is `packages/core/session`'s `Session.log`, not a persistence package. The model surface is `session.surface.nodes`: the seqs of the current message-producing events (`user/message`, `assistant/message`, `tool/result`, and the other surface-eligible types). Compaction elision is a `surfaceOp: { op: 'replace', start, end }` whose shadowed seqs leave that list. An event is outside the surface when its seq is not in `surface.nodes` — log-only events, and surface events a replace has shadowed.

Only a flushed prefix may leave RAM. Unflushed events and every current surface node stay resident so `deriveMessages()` never hydrates and the model-visible transcript stays reconstructable from the live log. The [session-surface decision](../architecture/2026-06-18-session-surface.md) still owns surface markers; this note owns which resident slots the live session may drop.

### `inMemoryLogWindow`

The window is persistence-backend config, not a `SessionStore` field, so `core/session` does not grow a schemastery dependency. Absent (the default) retains every event, including after flush. `0` keeps only current surface nodes plus unflushed events. A positive `N` also keeps the last `N` seqs. A non-integer or negative value throws at coordinator construction / plugin load.

When the window is set, the coordinator attaches a `SessionEventArchive` that calls `PersistenceBackend.readStoredEventsSync`. JSONL (including default `zstd`) and SQLite implement that hook. A window without a sync reader fails loud at session attach. Detached `Session.create()` never windows.

After a successful `appendBatch`, the coordinator marks the stored prefix durable and drops flushed off-surface slots. Incremental `requestHeader()` / `requestContext()` folds catch up before the drop so they cannot miss a later-dropped header or context event. `session.events` hydrates holes from the archive, returns a complete snapshot, and re-drops when a window is attached so the session does not cache the reconstructed log. A missing seq, a count mismatch, or a lost archive throws. The on-disk log is unchanged: holes exist only in RAM.

### SQLite `busyTimeoutMs` and `chunkRetention`

`busyTimeoutMs` defaults to `5000` and is applied as `PRAGMA busy_timeout` on the connection after journal mode. `0` fails immediately. A negative or non-integer value throws at construction.

`chunkRetention` is `'forever' | 'assembled'`, default `'forever'`. `assembled` is opt-in: after a batch inserts, each new `assistant/message` with `sourceEventSeqs` tombstones matching `assistant/chunk` rows in the same transaction (same seq/type/time; payload `{ turn, step, chunk: { type: 'text-delta', index: 0, text: '' }, pruned: true }`). Rows are not deleted, because a seq gap would look like corruption. A later `load` / `inspect` / `readFrom` / windowed re-read that encounters a tombstone throws `SessionPersistencePrunedError` naming the session and seqs. Live inspect of an unwindowed session still sees the original in-memory chunks. Combining `assembled` with `inMemoryLogWindow` makes `session.events` throw once those chunks have left RAM — that is the same loud failure, not a silent empty text. Sessions still have no deletion API; chunks that never assemble stay stored.

The [session-persistence decision](../architecture/2026-06-14-session-persistence.md) still owns the lossless default and the contiguous-seq contract. This note owns the opt-in tombstone and the busy timeout. Partial supersession only: that ADR remains active.

## Alternatives considered

**Dropping events before they are durable.** Rejected: a crash after a drop and before flush would lose history that the model-visible invariant requires the session log to reconstruct.

**Keeping `log` dense and moving dropped events to a side map.** Rejected: `seq === log.length` is the contiguity contract every append, seed, and backend asserts. Holes in a length-preserving array keep that contract without a second numbering scheme.

**Putting the window on `SessionStore`.** Rejected: the store has no schemastery Config, and a window without a durable reader cannot be honored. Persistence backends already own flush and the artifact.

**Deleting pruned chunk rows.** Rejected: a missing seq in the committed region is the existing corruption signal. A tombstone keeps the seq occupied so a later reader can refuse loudly instead of looking like a torn tail.

**Inserting a `session/chunks-pruned` event.** Rejected: the backend must not append events the live session did not assign. A new event would desynchronize `seq` between RAM and storage.

**Packing SQLite chunks the way JSONL does.** Rejected as a substitute for retention: packing shrinks bytes but still reconstructs every event, so it does not bound stored growth. JSONL packing remains a lossless encoding.

**A time- or byte-based rotation of whole sessions.** Rejected: the seam has no deletion API, and silently removing a session a later resume expects would violate the same reconstructability rule the tombstone refusal exists to keep.

**Shipping a non-zero window or `assembled` by default.** Rejected: both change memory or resume behavior. Absent / `forever` keep every existing composition identical.

## Testing

`packages/core/session/tests/windowed-log.spec.ts` drives the live log against a map-backed archive: retain-all until a window attaches, drop off-surface flushed seqs, hydrate on `events`, keep a trailing window, keep unflushed events, drop replace-shadowed surface nodes, and fail loud on a bad window, a lost archive, an archive gap, and a mismatched seq.

`session-persistence` rejects an invalid window and refuses attach when the backend cannot re-read synchronously. JSONL covers windowed flush and hydrate for both `none` and `zstd`. SQLite covers the default and zero `busy_timeout` pragmas, constructor rejection of invalid `busyTimeoutMs` / `chunkRetention`, lossless `forever` chunks, assembled tombstones that refuse cold `load` / `inspect` / `readFrom`, and windowed drop-plus-hydrate on a live session.

No keyless snapshot: model-visible transcripts are unchanged under the shipped defaults.

## Consequences

Shipped compositions still retain the full live log and the lossless SQLite chunk history. A deployment that sets `inMemoryLogWindow` accepts archive I/O on every complete-log read of a windowed session, because that getter does not cache the reconstructed snapshot. A deployment that sets `chunkRetention: 'assembled'` accepts that resume and any other full-log read of that session throw once chunks have been tombstoned; the cost is documented on the named error, not hidden as empty text.

The window cannot drop current surface nodes, so compaction still has to replace those nodes before their RAM can be released. Unassembled chunks stay stored under both retention policies. Session files and SQLite session rows still accumulate until removed out of band.
