# Agent Note: Default-on Shield provisions the payload and entitles plugin 0.2.0

Status: implemented

## Problem

Activate in Settings only wrote `enabled` and remounted. Stock `web` / `headless` profiles did not declare `shres.editions.shield`, so `enable-edition shield` failed and first boot never installed `@shrestech/shres-shield-plugin`. The host seat treated a non-empty `shres-dev` string as enough and called paid `apply({ posture })` only. Plugin 0.2.0 verifies signed `shres1.` tokens (and rejects `shres-dev` as legacy-dev) unless `SHRES_SHIELD_DEV=1`. The seat then set `ctx.shield.status.active = true` even when the payload returned an inactive instance. Screening stayed off unless the operator typed `pnpm add`, clicked Update, or patched `~/.shres/cordis.patch.yml`.

## Decision

**New web and headless profiles declare the Shield edition.** `initProfile` writes `shres.editions.shield = { packages: ["@shrestech/shres-shield-plugin"], autoProvision: true }`. First boot `ensureProfileEditions` installs a missing package. Existing profiles are never rewritten.

**An enabled seat installs npm `latest` when resolve is empty.** If `SHRES_SHIELD_MODULE` is unset, Shield is enabled, panic is off, and `ctx.baseUrl` names a profile directory, the seat queries the public packument and `pnpm add`s that concrete semver, then re-resolves. A registry or pnpm failure stays `engine-missing`. This is the same installer Settings Update uses, not an edition rewrite.

**The seat forwards license and honors plugin entitlement.** Paid `apply` receives `{ posture, license }`. After apply, `entitlement.active === false` keeps the host inactive (`unlicensed`, or `panic` when the payload says panic).

**Unsigned profile/package loads in non-production use the payload hatch.** When the engine source is `profile` or `package` and the license is not a `shres1.` token, the seat sets `SHRES_SHIELD_DEV=1` unless `NODE_ENV=production` or `SHRES_SHIELD_PRODUCTION=1`. Env and sibling loads stay developer-entitled without that assignment. Production remains fail-closed without a signed token.

## Alternatives considered

**Vendor the paid tarball into the harness workspace.** Rejected: the engine is the paid product; shipping it with every install forks the release train.

**Auto-write `shres.editions.shield` onto existing profiles from Update or Enable.** Rejected earlier for Update; still rejected. Templates declare at init. The seat's missing-payload `pnpm add` writes an ordinary dependency.

**Keep `~/.shres/cordis.patch.yml` `!!js` as the hatch.** Rejected: that file is a user plugin layer, not entitlement. The seat owns the hatch for unsigned non-production profile/package loads.

**Forward license only, with no hatch.** Rejected: plugin 0.2.0 rejects `shres-dev` by name, so default-on would stay dark until every developer minted a signed token.

**Treat any non-empty Settings string as a signed token.** Rejected: verification belongs to the plugin.

## Consequences

A new `shres web` profile provisions Shield on first boot. An older profile with Shield enabled installs on the next mount if the payload is missing. Default-on screens in development without a home-patch hatch. A production process without a signed license does not screen. The green mark follows the payload's `entitlement.active`.

## Testing

`packages/guard/shield/tests/shield.spec.ts` covers license forwarding, inactive plugin entitlement, unsigned-dev hatch for profile vs env vs production lock, missing-payload install, and no install when disabled. `packages/boot/app-boot/tests/profile.spec.ts` covers web template edition write and omitted editions.

## Related

- [Paid default seat](2026-08-17-paid-shres-shield-default-seat.md)
- [Edition provision](2026-08-24-shield-edition-provision.md)
- [npm payload update](2026-08-26-shield-npm-payload-update.md)
