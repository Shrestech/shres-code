# Agent Note: Shield payload resolves from the active profile, and profiles can auto-provision paid editions

Status: implemented

## Problem

The paid Shres Shield seat (`packages/guard/shield`) resolved its payload through a fallback specifier `@shres-shield/plugin` that does not exist on npm (the real name is `@shrestech/shres-shield-plugin`), and its final bare `import()` ran from the seat's own module path — the repo `node_modules`, which by design never carries the paid package. A customer install without the sibling `../shres-shield` checkout had no way to make the payload resolvable, so the seat stayed inactive (`engine-missing`) even with a valid license. Separately, there was no supported path to pull and install the paid payload into a profile: adding it and keeping it present across reinstalls was manual.

## Decision

**The resolution order is env → active profile → sibling → package.** `resolveShieldEngine` resolves `SHRES_SHIELD_MODULE` (exclusive when set), then the payload from the active profile's `node_modules` (`source: 'profile'`), then the sibling `../shres-shield/packages/plugin/dist/index.js`, then the pinned `@shrestech/shres-shield-plugin` specifier. Profile precedes sibling so a Settings → Update install takes effect on a machine that also has a local checkout ([npm update](2026-08-26-shield-npm-payload-update.md)). The specifier is a named export `PAYLOAD_SPECIFIER` so a revert to the wrong name fails a regression test. The profile-anchored leg uses a `node:module` `createRequire` anchored at the profile's `package.json`, so the lookup starts exactly where pnpm installs profile-local dependencies. The seat derives the profile directory from `ctx.baseUrl`, which the app boot anchors at the profile directory — the same anchor that resolves profile bundles, so no new global mutable state is invented. The `profile` source requires a license (it is a real paid payload, like `package`); sibling and env remain developer-entitled without a key. Every leg stays fail-through and the seat keeps its documented fail-soft contract (inactive when nothing resolves).

**A profile may declare editions, and enabling is an explicit act.** The profile manifest (`app-boot` `ProfileManifest`) gains an optional `shres.editions` record — a named inventory of `{ packages: string[], autoProvision: boolean }`. Config declares the inventory; `enable-edition` selects among declared editions: `shres plugin --profile <name> enable-edition <edition>` sets that edition's `autoProvision` and provisions its packages through the same pnpm forwarder, then reconciles bundle layers. Nothing auto-writes an edition; an undeclared edition fails loud. At profile boot, every edition with `autoProvision: true` is checked against the profile `node_modules`, and a missing package triggers one `pnpm add` through the same forwarder; a pnpm failure fails the boot loudly with the exact pnpm error — a missing paid payload is never silently skipped.

No keyless snapshot changes: this change introduces no model-visible text.

## Alternatives considered

- **An exported setter to thread the profile directory into the seat** — rejected: `ctx.baseUrl` already names the boot profile directory and follows the existing anchor pattern, so no extra global state or boot hook was needed.
- **Bare import directly from the profile via `createRequire` without a resolve step** — the profile leg must resolve the absolute entry first (a `createRequire.resolve`) and import that path, because bare `import()` from the seat cannot see the profile's `node_modules`; resolving the path first is what makes the leg observable and testable.
- **Letting `enable-edition` invent an edition's package set** — rejected: it would violate "config declares inventory; enabling selects". An undeclared edition fails loud instead.

## Consequences

A paid customer install without the sibling can install `@shrestech/shres-shield-plugin` into a profile, `enable-edition` it, and the seat resolves it from that profile on every boot. The `profile` resolution source requires a license (same as `package`). The edition boot ensure is a no-op on profiles without an enabled edition, so ordinary boot latency is unaffected; it only spawns pnpm when a declared enabled package is missing. The shield seat's README now documents the four-leg resolution order, and the CLI and app-boot READMEs document the edition inventory and the config-declares / enabling-selects law.

## Testing

`packages/guard/shield/tests/resolve.spec.ts` pins the specifier (a revert to `@shres-shield/plugin` fails), proves the profile leg with a fixture profile `node_modules` under a throwaway `repoRoot` that neutralizes the sibling (which exists on the developer machine), and covers every resolution leg and `toEngine` snapshot variant to 100% on `resolve.ts`. `shield.spec.ts` adds a seat test asserting `ctx.baseUrl` (the boot profile) is threaded into resolution. `apps/cli/tests/plugin.spec.ts` covers `enable-edition` (undeclared fails without spawning, declared sets `autoProvision` and provisions), `ensureProfileEditions` (no-op paths and a missing package triggering `pnpm add`), and pnpm failure returning the exit code, with `node:child_process` stubbed. `apps/cli/tests/args.spec.ts` routes `enable-edition` to its own invocation mode. App-boot profile tests stay green.

## Related

- [`2026-08-17-paid-shres-shield-default-seat.md`](2026-08-17-paid-shres-shield-default-seat.md): the host-seat design this change's resolution order extends (profile leg) and whose stale specifier this change corrects.
- `shres-shield` `docs/integration-shres-code.md` (`Resolution` and `Entitlement`): the resolution order and the fail-soft contract this seat implements.
- Existing Agent Notes governing profile bundling and the `shres plugin` forwarder.
- [`2026-08-26-shield-npm-payload-update.md`](2026-08-26-shield-npm-payload-update.md): Settings Check / Update and why profile precedes sibling.
