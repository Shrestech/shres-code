# @shres-code/shres-code-storage-json

JSON backend for the [storage hub](../storage/README.md): one human-readable `<unit>.json` file (`single` layout) or one document per record under `<unit>/` (`per-record` layout) under a configured root, registered as backend `json`. Design: Version-read compatibility:

## Model

- In `single` layout the in-memory unit state is authoritative; every write primitive republishes the whole file via temp-write + fsync + atomic `rename()` replace. A unit file is always the complete current net state — legibility is this backend's reason to exist; scale is the SQLite backend's job.
- A missing `single` file or `per-record` directory opens as an empty unit and materializes on the first write. In `single`, malformed content rejects with `malformed-medium`, and a different stored version rejects with `version-mismatch`. In `per-record`, each malformed, unreadable, or unaccepted-version document reads as an absent record, so one bad document does not reject the unit. Record keys must match `[a-zA-Z0-9_-]+`; an unsafe key rejects before any file operation. Writes always stamp the current descriptor version; reads admit the current version plus any `compatibleVersions` the descriptor declares.
- An empty `per-record` tree can initialize its declared tables from a valid `<root>/<unit>.json` whole-unit document only when the source unit name matches and its stored version is the current version or a declared compatible one. The backend leaves that source file unchanged. A different source version leaves the new tree empty. Any document path in a declared table, or a declared `global.json`, suppresses this initialization for the complete unit, even if that document is unreadable or stale.
- `backupRecord` (per-record only) moves `<key>.json` aside as `<key>.json.bak.<YYYYMMDDHHmm>`. The moved file no longer ends in `.json`, so later reads treat the key as absent; a later write recreates it. Same-minute backups of one key overwrite.
- Write ordering across calls belongs to the caller (the domain layer's write chain); each single call is atomic and durable once resolved. Operations after close reject with `closed`.

## Config

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `root` | string | required — no default (a cwd fallback would scatter files) | Directory holding unit files; created `0o700` on demand |

## Model Experience

### Stored domain records

#### What the model sees

Nothing. This backend contributes no prompt, tool, or schema; it persists non-session domain data behind `ctx.storage` for host-side consumers only.

#### Token effect

Zero live-request tokens.

#### KV Cache effect

None — the backend never touches live request prefixes.

## Known Limitations and Deferred Work

- Windows durability relies on libuv's `rename()` (`MoveFileExW` with replacement) without an explicit write-through flag; the session-log backend's stricter Win32 write-through publish helper is planned to move down here when the append-log facet lands.
- No cross-process write locking: two processes writing the same root can interleave whole-file replacements (last write wins). Single-host-process deployments are the current consumer
