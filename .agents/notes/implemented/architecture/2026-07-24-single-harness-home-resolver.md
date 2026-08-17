# Agent Note: One harness home resolver

Status: implemented

## Problem

The harness had two inconsistent conventions for "where does Shres Code user data live":

- `@shres-code/shres-code-home` resolved `configured ?? $SHRES_HOME ?? ~/.shres`.
- `@shres-code/shres-code-home-paths` shipped a **second** `resolveShresHome` with the same precedence plus tilde expansion — a near-duplicate of `shres-home` that no gate flagged because the two lived in different packages and had already drifted (only one expanded tildes).

Two resolvers for the same cross-cutting fact meant there was no single home policy.

## Decision

One resolver owns the harness home, in `@shres-code/shres-code-home-paths`, single-root:

```
explicit configured path  >  $SHRES_HOME  >  ~/.shres
```

An empty or whitespace-only `$SHRES_HOME` is treated as unset; otherwise `resolve('')` would silently place the home at the current working directory. The harness keeps all user data under one root; there is no XDG config/data/cache split. `shresHomePath(...segments)` joins deployment-owned children onto that root, and `shres-app-boot` exposes it to Loader `!!js` config expressions before mounting entries, so shipped compositions derive `sessions` and `storages` without copying the resolver. `shresHomeDisplay()` names a resolved root symbolically for user-facing paths — `~/.shres` for the default home, `$SHRES_HOME` for any configured home — so the user-global `AGENTS.md` label never leaks an absolute machine path. It replaces agent-instructions's bespoke default-vs-`$SHRES_HOME` check.

`@shres-code/shres-code-home` is deleted. Its three importers (`shres-tool-bash`, `shres-skill-filesystem`, `shres-agent-spine-demo`) import `resolveShresHome` from `shres-home-paths`.

`shres-telemetry` and its separate home policy are absent under the [SDK project toolchain removal](../simplification/2026-08-11-remove-sdk-project-toolchain.md), leaving this resolver as the sole home policy.

## Alternatives considered

**Leave the two `resolveShresHome` copies in place.** They had already drifted (one expands tildes, one didn't) and encode the same cross-cutting fact twice. Consolidation is the point of the `util/` layer; a duplicate resolver is a latent divergence bug.

**Adopt XDG (honor `$XDG_CONFIG_HOME`, or split config/data/cache into separate trees).** Considered and dropped in favor of one obvious root. A single `$SHRES_HOME || ~/.shres` ground truth matches `~/.claude` / `~/.aws`, needs no per-kind reclassification of every `~/.shres` consumer, and leaves no resolver asymmetry to reconcile.

## Consequences

- One home fact, one resolver. `shres-home-paths` is the sole owner; the `util/` group loses the `home` package.
