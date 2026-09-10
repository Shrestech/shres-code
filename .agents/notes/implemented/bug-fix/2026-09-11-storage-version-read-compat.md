# Agent Note: Admit declared compatible storage versions and salvage invalid records

Status: implemented

## Problem

Storage backends stamp each per-record document with the domain's `version`, and open refused any stored version other than the current one. Two failures followed.

A stale-but-acceptable cache — an older domain version whose records the current record schemas still parse — was refused instead of read, so an upgraded home could fail to boot.

The legacy whole-unit bootstrap migrated a file of any stored version and stamped its records current. That turned a discardable stale cache into invalid-record failures that refused the whole domain at open and permanently poisoned the new tree on first boot.

Authoritative domains such as workspace must stay fail-loud. Derived domains such as the session projection cache must not.

## Decision

`DomainSpec` declares two optional fields, validated in `defineDomain` at module load.

`compatibleVersions` is a list of older domain versions whose stored records the current record schemas still accept. Each entry must be a non-negative integer strictly below `version`; the current version must not appear in the set. Writes always stamp the current version. A `per-record` read admits a document stamped with the current version or a declared compatible one; any other stamp reads as absent. A `single` unit still rejects a mismatched stored version at open.

`invalidRecords` is absent by default (fail-loud `invalid-record` on open) or `'backup-and-skip'` for domains whose records are disposable derived data. Under salvage, a stored table record that fails its zod schema is moved aside through optional `KvUnit.backupRecord`, logged with its cause, and skipped. The global slot always rejects. A backend without `backupRecord` (memory, sqlite, `single` json) stays fail-loud even when the policy is declared.

The json `per-record` unit is the only backend that implements `backupRecord`. It names the backup `<key>.json.bak.<YYYYMMDDHHmm>` (local time; a same-minute backup of the same key overwrites). The moved file no longer ends in `.json`, so later reads treat the key as absent.

The json legacy whole-unit bootstrap migrates a `<root>/<name>.json` file only when its stored unit name matches and its stored version is the current version or a declared compatible one. An unaccepted stored version is left unchanged and the new tree opens empty, so those records are never stamped current.

`session_projcache` opts in because its records are disposable derived data: version 3, `layout: 'per-record'`, `compatibleVersions: [1, 2]`, `invalidRecords: 'backup-and-skip'`. Current identity fields already parse older records; a hopeless document is salvaged instead of refusing the plugin tree. `workspace` stays on the fail-loud default.

## Alternatives considered

**Admit every older version automatically.** Rejected: the backend does not know a domain's record schema and cannot decide which older stamps still parse. The owner must vouch per version.

**Copy legacy values across unit versions without a declared set.** Rejected: that relabels data without migrating it and is exactly the poisoning path this change closes. Compatibility is an explicit domain declaration; undeclared versions stay discarded.

**Reset the whole medium on any invalid record.** Rejected for the cache: one bad session document must not drop every other session's listing projection. Salvage is per-record; whole-medium reset remains a separate proposed recovery path.

**Implement `backupRecord` on sqlite and memory.** Rejected: those media have no per-record document to move aside. Omitting the method keeps the fail-loud fallback, which is the correct default for row stores.

**Leave `session_projcache` on `single` layout.** Rejected: salvage and per-record version admission require a document per record. The cache is derived data, so moving to `per-record` is the layout that matches its failure scope.

## Consequences

An upgraded home whose cache records still parse under the current schemas boots and serves those records. An undeclared older stamp is discarded, not migrated. A schema-failing cache record is moved aside and logged; neighboring records still open. Authoritative domains remain exactly as strict as before. Json is the only backend that can salvage; sqlite and memory stay fail-loud.
