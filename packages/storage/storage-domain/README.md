# @shres-code/shres-code-storage-domain

Domain data form for the Shres Code storage hub: exposes the injectable `ctx.storageDomain` service and the matching `ctx.storage.domain` projection after every configured backend is registered. A domain is declared once with `defineDomain` (zod record schemas, `z.infer`-derived types), opened through `DomainFacility.open`, and served from authoritative in-memory state — reads are synchronous, writes serialize on one per-domain chain, reach durability on the routed backend first, then update memory and emit `domain/changed`. The opening consumer owns the handle's lifecycle and releases it with `Domain.close()` (idempotent; typically its own `ctx.effect` disposer); domains still open when the plugin unmounts are closed by the facility.

`defineDomain` accepts optional `layout` (`single` or `per-record`), `compatibleVersions` (non-negative integers strictly below `version`), and `invalidRecords: 'backup-and-skip'`. Writes always stamp the current version. Reads of a `per-record` unit admit a document stamped with the current version or a declared compatible one. Absent `invalidRecords` (the default), a stored table record that fails its zod schema rejects the open with `invalid-record`; `'backup-and-skip'` moves that document aside through `KvUnit.backupRecord`, logs the cause, and continues with the record absent. A backend without `backupRecord` stays fail-loud even when the policy is declared. The global slot always rejects.

## Configuration

| key | meaning |
| --- | --- |
| `backend` | Default backend name for every domain (required; no universally correct medium exists). |
| `routes` | Per-domain overrides: domain name → backend name. |

## Model Experience

### Durable domain state

#### What the model sees

Nothing. The package registers no tools, injects no prompts, and appends no session events; it stores non-session data (workspace records, future session sidecars) behind `ctx.storageDomain` and emits only the in-process `domain/changed` event, which reaches a model only if a Consumer package renders it through its own documented surface.

#### Token effect

Zero. No text from this package enters any model request.

#### KV Cache effect

Independent: domain reads and writes never touch request prefixes, so nothing here can invalidate provider cache reuse.

## Known Limitations and Deferred Work

- **Single-process change visibility** — `domain/changed` is an in-process event; lands.
- **No cross-table transactions, secondary indexes, or multi-segment keys** — each write touches one record;
