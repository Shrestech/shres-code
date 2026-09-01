# Agent Note: Settings Shield checks npm and installs `@shrestech/shres-shield-plugin` into the boot profile

Status: implemented

## Problem

The host seat resolved `@shrestech/shres-shield-plugin` without a version pin. On a developer machine the sibling `../shres-shield` checkout always won, so a newly published npm release (0.2.0) never loaded. There was no product path to see that npm had a newer payload or to install it: Settings showed a definition stamp (SIG-PACK, engine-owned) and the READMEs deferred "Update now". Edition `enable-edition` can install a specifier from the CLI, but the Shield pane had no check or download control.

## Decision

**Check and Update are Host remotes on `ctx.shield`, not settings fields.** `checkUpdate` GETs `https://registry.npmjs.org/@shrestech/shres-shield-plugin/latest` (15s hang-safety abort) and compares that concrete semver to the resolved package.json `version`. `applyUpdate` re-checks, then `pnpm add @shrestech/shres-shield-plugin@<version>` in the boot profile (`ctx.baseUrl`) with credential-shaped env keys stripped, then remounts so the profile leg loads the new files. The pane never accepts a user-typed spec: only the registry's `version` is passed to pnpm, and non-semver strings are refused. `SHRES_SHIELD_MODULE` stays exclusive and blocks the install (`blocked: 'env-override'`). A missing profile directory blocks (`no-profile`). Registry and pnpm failures are structured results, not thrown, so the seat stays up.

**Profile resolution precedes sibling.** After an Update, the profile `node_modules` copy must load even when `../shres-shield` exists. Env remains exclusive; sibling remains the fallback when the profile does not carry the package. Removing the profile package restores the sibling leg. The specifier stays unversioned in code; the installed profile directory is what pins a version on disk.

Settings → Shield **Plugin updates** is idle until **Check for updates**. Versions appear only after that RPC, so web snapshots of the idle card stay machine-independent. **Update** is shown only when `available` is true.

No model-visible text.

## Alternatives considered

**Keep sibling before profile and document that Update is a no-op on developer machines.** Rejected: the user-visible control would install files that never loaded.

**Pin `PAYLOAD_SPECIFIER` to `@shrestech/shres-shield-plugin@0.2.0` in source.** Rejected: a source pin requires a harness release to pick up the next payload. The pane talks to npm `latest` instead.

**One button that checks and installs without a confirmation step.** Rejected: a registry GET is cheap and safe; `pnpm add` writes the profile. The pane shows installed vs latest before Update.

**Auto-write `shres.editions.shield` on Update.** Rejected: editions stay "config declares, enabling selects". New web/headless profiles declare the edition at init instead. `pnpm add` writes an ordinary profile dependency. An enabled seat with no resolved payload now installs npm `latest` itself ([default-on provision](2026-09-01-shield-default-on-provision-and-hatch.md)); wiping `node_modules` no longer stays `engine-missing` until the user clicks Update.

**Depend on `ctx.subprocess` for the pnpm spawn.** Rejected: adding `subprocess` to `inject` would leave the seat pending on compositions that omit it. Direct `node:child_process` spawn matches the CLI edition forwarder.

## Consequences

A customer (or this develop checkout) can Check and Update from Settings without a sibling checkout and without `shres plugin enable-edition`. A set `SHRES_SHIELD_MODULE` still wins and the pane says so. SIG-PACK `definitions` on the snapshot stay engine-owned and are not this RPC.

## Testing

`packages/guard/shield/tests/update.spec.ts` covers packument parse, version walk, spawn, env scrub, and non-semver refusal with injected fetch/spawn plus a real Node `spawnBinary`. `shield.spec.ts` covers env-override, registry miss, missing profile, pnpm fail, already-current, and a successful profile install that remounts. `resolve.spec.ts` pins profile-over-sibling. `packages/client/ui-settings-shield/tests/section.client.spec.tsx` covers Check, Update, blocked copy, thrown RPCs, and in-flight labels. `apps/web/tests/shield-settings.e2e.ts` snapshots the idle Plugin updates card through the real settings dialog.

## Related

- [`2026-08-24-shield-edition-provision.md`](2026-08-24-shield-edition-provision.md): profile-leg resolve and CLI edition install this pane does not replace.
- [`2026-08-17-paid-shres-shield-default-seat.md`](2026-08-17-paid-shres-shield-default-seat.md): seat, entitlement, and snapshot RPC this change extends.
