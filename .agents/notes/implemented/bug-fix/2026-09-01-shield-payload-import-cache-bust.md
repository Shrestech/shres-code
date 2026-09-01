# Agent Note: Shield remount imports a content-scoped file URL so in-place payload updates load

Status: implemented

## Problem

Settings → Update installs `@shrestech/shres-shield-plugin@<latest>` into the boot profile and remounts. `pnpm add` overwrites files at the same specifier path (`…/node_modules/@shrestech/shres-shield-plugin/dist/index.js`, a real directory or a retargeted symlink). `import()` keys the ESM module cache on that URL, so dispose-and-re-apply still ran the previous graph in the live process. A new Node process loaded 0.2.1; the running Web UI did not. The paid package is multi-file (`dist/index.js` imports `dist/harness/adapter.js`), so a query on the entry alone would leave children keyed by the un-queried path. Separately, `createRequire().resolve` misses the published package: it has `exports.import` and no CJS `main`, so the profile leg returned `undefined` and a machine with `../shres-shield` kept the sibling graph.

## Decision

**File-leg `import()` URLs carry `shresShieldBust=<mtimeMs>.<size>` of the entry.** `fileImportHref` appends that query for absolute paths, relative paths, and `file:` URLs. Bare specifiers stay unchanged. `ShieldEngine.entry` remains the filesystem path so `readPayloadVersion` still walks from it.

**An in-process `registerHooks` resolve hook copies that query from the parent file URL onto child `file:` URLs.** Node builtins and parents without the param pass through. The param name is not Vite's `v`, so the hook does not rewrite unrelated graphs.

**When CJS `createRequire().resolve` fails, read `exports['.'].import` (or `main`) from the profile-local `package.json`.** The paid tarball has no `main`. Without this fallback the profile leg never runs on a customer install, and remount cannot pick up Update.

No new Config field.

## Alternatives considered

**Query on the entry only.** Rejected: relative children resolve to the un-queried `file:` path and stay cached. The inbox-id fix lives in `dist/harness/adapter.js`.

**`realpathSync` the entry and import the physical path.** Rejected: the profile install is often a real directory, not a pnpm-store symlink, so the real path does not change across `pnpm add`.

**Copy the package tree to a unique directory per remount.** Rejected: bare imports of `@shrestech/shres-shield-core` would miss the profile `node_modules` unless the copy sat under it, and core/model would still be cached at their original URLs.

**Restart the Web process after Update.** Rejected: the pane's contract is remount in the running seat.

**A unique generation token on every `import()` (`Date.now()`).** Rejected: not content-scoped; every settings remount would duplicate the graph even when bytes did not change.

## Consequences

Settings → Update loads the newly installed payload in the same process. Each distinct `(mtime, size)` leaves one ESM graph in memory until process exit; remount frequency is low. `registerHooks` is the Node 22.15+ in-process resolve hook (engines are `^22.19 || >=24`). If the busted `import()` throws, the seat retries the un-queried file URL so a Vitest `.ts` env fixture still loads.

## Testing

`packages/guard/shield/tests/resolve.spec.ts` rewrites a single-file profile payload at the same path and asserts the second `resolveShieldEngine` in the same process returns the new `snapshot` marker; a two-file graph (entry re-exports a child marker) is overwritten the same way. Without the query and hook those tests return the old marker. Hook unit cases cover missing parent, `node:` children, empty/absent param, already-busted href, and a non-URL parent. ESM-only profile fixtures (no `main`) pin `exports.import`, `main` fallback, and unusable JSON/name/entry. Env `.ts` fixtures still resolve through the un-queried retry.

## Related

- [`2026-08-26-shield-npm-payload-update.md`](../feature/2026-08-26-shield-npm-payload-update.md): Check / Update remount this import path serves.
- [`2026-08-24-shield-edition-provision.md`](../feature/2026-08-24-shield-edition-provision.md): profile-leg resolve this fallback completes for ESM-only tarballs.
