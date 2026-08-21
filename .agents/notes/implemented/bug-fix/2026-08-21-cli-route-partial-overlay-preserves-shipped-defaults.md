# Agent Note: Partial CLI-route settings preserve shipped defaults

Status: implemented

## Problem

`shres models list` and the Models picker showed the delegated CLI routes (`grok-cli`, `kimi-cli`, `claude-cli`, `codex-cli`) as advertising no models, even when the route was enabled. Toggling a route `enabled` in the `llm-cli-bridge` settings section silently erased its shipped model list (and its `efforts` / `extraArgs` / `env`).

The settings layer runs a stored route through the `Config` schema before `resolveRoutes()` merges it onto `SHIPPED_ROUTES`. `@shres-code/schemastery` gives array and dict schemas a non-nullable default (`[]` / `{}`), so a partial route that only set `{ enabled: true }` was coerced into `{ models: [], efforts: [], extraArgs: [], env: {}, enabled: true }`. `mergeRoute()` then applied `overlay.models ?? base.models`, and an empty-but-present `[]` won over the shipped base list, deleting it.

## Decision

`routeSchema` in `packages/llm/llm-cli-bridge/src/config.ts` marks `models`, `efforts`, `extraArgs`, and `env` `.default(undefined as unknown as …)`, so an omitted field stays truly absent through schema coercion. `mergeRoute()`'s existing `overlay.x ?? base.x` fallback then keeps the shipped default. An explicitly provided empty list still clears the field, preserving the intent to override. This uses the repo-established cast pattern already present in `system-prompt` and `tool-subagent`.

## Alternatives considered

**Edit the vendored schemastery so arrays do not default to `[]`.** Rejected: `vendor/` sources are pinned to upstream and a local change must be logged and re-applied on every sync; the fix belongs in the owned consumer.

**Treat an empty overlay array as "use base" in `mergeRoute()`.** Rejected: it would make an intentional `models: []` clearing indistinguishable from an omitted field, removing the ability to clear a shipped list.

## Consequences

`shres models list` and the Models picker now show the shipped advertised models for any enabled CLI route whose settings do not override them. A route with an explicit empty `models` still advertises none. The `Config` schema's coercion of other fields is unchanged.
