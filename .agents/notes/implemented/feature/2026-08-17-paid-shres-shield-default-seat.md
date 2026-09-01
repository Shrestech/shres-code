# Agent Note: Paid Shres Shield is the default-on host seat

Status: implemented

## Problem

Shres Shield is the product's prompt-injection defense and a paid plugin. Shipping its engine inside the harness tarball would give the payload away, leave no entitlement check, and mix two repositories' release trains. Leaving it unmounted would hide the product's core defense. The brand mark also had no active-vs-inactive lockup, so a live seat was invisible.

## Decision

`@shrestech/shres-shield-plugin` stays in the shres-shield repository. Shres Code ships only `@shres-code/shres-code-shield`, a function plugin on `shres-base` (`id: shres-shield`) that resolves the payload, checks entitlement, and publishes `ctx.shield.status`.

Resolve order: `SHRES_SHIELD_MODULE` (exclusive when set), then the active profile's installed payload, then sibling `../shres-shield/packages/plugin/dist/index.js`, then the `@shrestech/shres-shield-plugin` specifier (see [edition provision](2026-08-24-shield-edition-provision.md) for the profile leg; [npm update](2026-08-26-shield-npm-payload-update.md) for why profile precedes sibling). Entitlement: a non-empty `license` / `SHRES_SHIELD_LICENSE`, or a sibling/env-module load. `SHRES_SHIELD=off` is the panic switch and beats every other control. An unentitled or missing payload keeps the row loaded and `active: false`; the loop is unchanged.

The seat calls `apply(ctx, { posture, license })` itself and registers `dispose` through `ctx.effect()`. The payload is never a Loader `name` — its `apply` is async and returns an instance, which Cordis would not treat as a disposer. When that instance reports `entitlement.active === false`, the seat stays inactive. Plugin 0.2.0 verifies signed `shres1.` tokens; for unsigned loads of every source the seat enables `SHRES_SHIELD_DEV=1` in non-production ([default-on provision](2026-09-01-shield-default-on-provision-and-hatch.md)).

The seat `inject` is `['systemPrompt', 'tools', 'approval', 'jobs']`. Cordis array inject is required-only; there is no optional flag. Product `shres-base` always mounts `user-approval` and `jobs-local` as siblings of this row. A composition that omits `approval` or `jobs` leaves the seat fiber pending: `apply` never runs, `ctx.shield` is never published, and the engine never screens. Listing the names is required so the payload adapter's `ctx.approval` / `ctx.jobs` property probes succeed when those sibling services exist (an uninjected property read throws and is treated as headless).

While `ctx.shield.status.active` is true, the product mark uses girl `#2563eb` and shield `#16a34a`. Inactive uses `currentColor` with no green overlay. The web primitives default `shieldActive` to true because the shipped composition is default-on; a later client binding can pass `ctx.shield.status.active`. Settings **Shield** (`@shres-code/shres-code-client-ui-settings-shield`, order 12) writes the `shres-shield` namespace (`enabled`, `posture`, `license`, `repos`); the seat remounts on change. The page's activate switch sits beside the Shield mark. The same page binds `ctx.remote.shield.snapshot()` for this-repo counters and recent findings. License defaults to `shres-dev` until a paid key exists. The API proxy allowlists that namespace next to `agent-seats`. `ctx.shield.snapshot()` is the Host Remote for those counts. `'shield/decision'` is the ignorable session event Trajectory badges fold. The mark follows the current session's snapshot status, and `repos` carries the per-repo exemption ([per-repo exemption note](2026-08-24-shield-per-repo-exemption.md)).

The reproducible checkout, entitlement table, and Cordis mapping live in shres-shield `docs/integration-shres-code.md`.

## Alternatives considered

**Vendor `@shres-shield/*` into this repository.** Rejected: the engine is the paid product. A workspace copy would ship it with every harness install and fork the release train.

**List `@shrestech/shres-shield-plugin` as a `file:` or workspace member.** Rejected: CI has no sibling checkout, and `workspace:*` inside that package does not resolve from this workspace. Dynamic resolve plus a documented sibling layout keeps `pnpm install` self-contained.

**Mount the payload as a bare `cordis.yml` name.** Rejected: Cordis `apply` must return a disposer or void. The payload's `apply` is async and returns `{ shield, dispose }`.

**Require a license even for a sibling checkout.** Rejected: developers cloning both repos as siblings must get a working default-on seat without a customer key. Package- and profile-resolved loads still require `SHRES_SHIELD_LICENSE`.

**Cryptographic license verification in this seat.** Rejected for this change: the paid release of `@shrestech/shres-shield-plugin` owns key verification. This seat only distinguishes empty from non-empty and records the gap.

**Skip `approval` and `jobs` in `inject` and probe with `ctx.get`.** Rejected: the payload adapter property-reads `ctx.approval` / `ctx.jobs` (try/caught). Sibling services are invisible on the ancestor walk without `inject` ([postmortem 0001](../../../../docs/postmortem/0001-acp-default-export-drops-inject.md)). Tools already consume approval opportunistically via `ctx.get` ([approval seam](2026-07-06-approval-seam.md)); the adapter does not. Cordis has no optional-inject form.

**Invent `{ optional: ['approval', 'jobs'] }` on the seat.** Rejected: this Cordis treats object keys as service names and intercept config, not optionality.

## Consequences

Every profile loads `shres-shield`. Screening starts only when the payload resolves and is entitled. Tests force `SHRES_SHIELD_MODULE` at a fixture so CI does not depend on the sibling. The brand mark's default lockup is the paid-active colors; HoppingRoo keeps `shieldActive={false}` so seat fills still ride `currentColor`. A profile that disables the `approval` or `jobs` row, or a custom leaf that omits them, silently disables Shield: the seat stays pending instead of applying the engine as headless.

## Testing

`packages/guard/shield/tests/shield.spec.ts` covers panic, env-module miss, env-module entitle, dispose, license override, and `isEntitled` by source. The same file mounts `approval` and `jobs` as sibling plugins (not root `ctx.provide`) and asserts the fake payload's seat-ctx property probes are `ok` only when those names are in `inject`; omitting the siblings leaves the seat fiber pending, never calls the payload, and does not publish `ctx.shield`. `packages/client/ui-primitives/tests/icons.client.spec.tsx` pins the blue/green lockup and the monochrome inactive mark. The sibling repo's `packages/plugin/src/harness/adapter.test.ts` maps `'allowed-once'` / `'rejected'` / `'cancelled'` / `'unavailable'`. A sibling checkout plus `pnpm build` in shres-shield plus `node scripts/link-shres-code.mjs` is the live path: the web sidebar shows the blue girl and green S-shield, and `SHRES_SHIELD=off` restores monochrome.

## Deferred

No client plugin yet reads `ctx.shield.status.active` over RPC to flip `shieldActive` at runtime. Ask-posture approval still needs an open turn and `exec.agent`; headless stays fail-closed. Signed-token verification lives in the paid plugin; the seat forwards `license` and enables the unsigned-dev hatch for unsigned non-production loads of every source.
