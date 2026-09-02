# Agent Note: Port per-record storage and spill cleanup from upstream

Status: implemented

## Problem

Two upstream improvements in packages shres-code keeps in sync were not yet ported. The JSON storage backend only supported the `single` layout (one whole-unit file), so one malformed or stale record file could brick the entire unit and every write rewrote the whole file. The local spill backend accumulated orphaned spill files from crashed or interrupted sessions with no startup cleanup.

## Decision

Port both from the upstream fork, adapting to shres-code conventions.

- **storage-json per-record layout**: add a `layout?: 'single' | 'per-record'` field to `KvUnitDescriptor` in the storage domain, add `serializeRecord`/`parseRecord` to `format.ts`, add `per-record-unit.ts` and `single-unit.ts` (replacing the old `unit.ts`), and rewire `index.ts` to select the layout via `descriptor.layout`. The `per-record` layout stores one version-stamped document per record under `<dir>/<table>/<key>.json`, so a malformed or stale record reads as absent (one bad file never bricks the unit), a version bump discards stale records instead of migrating them, and each write rewrites one record instead of the whole unit. It is an opt-in layout; the `single` layout remains the default.
- **spill-local startup cleanup**: add `DEFAULT_ROOT_PREFIX` (`shres-spill-`) and `isErrno` to `store.ts`, add `cleanup.ts` (a best-effort startup sweep that deletes expired regular files under `session-*` directories, prunes emptied session dirs and discovered prior-default roots, and never follows a symlink or sweeps an unrelated entry), and rewire `index.ts` with a `cleanupPeriodDays` config (default `30`, `0` disables) that launches one fiber-owned sweep at activation and awaits it on disposal.

Both ports keep the DeepSeek LLM provider and the rest of the product untouched.

## Alternatives considered

**Wholesale-sync the upstream storage-json package.** Rejected: shres-code has diverged in the storage domain; the port adapts the two unit files and the interface change to shres-code conventions instead of copying the package wholesale.

**Add a migration shim for existing single-layout data.** Rejected under the pre-release stance: the per-record layout is a new opt-in layout, so no existing data needs migrating; the `single` layout remains the default.

**Skip the spill cleanup.** Rejected: orphaned spill files accumulate without it, and the upstream sweep is race-safe and never follows symlinks, so it is safe to adopt.

## Consequences

The JSON storage backend supports a resilient `per-record` layout (one bad file cannot brick a unit; concurrent record loading). The local spill backend reclaims expired spill files at startup. Both are covered by focused tests. The `single` layout and the default spill behavior are unchanged.
