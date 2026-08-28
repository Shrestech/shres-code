# Agent Note: Preset plugins resolve from the app dependency surface

Status: implemented

## Problem

The researcher preset ([researcher MVI](../architecture/2026-08-28-researcher-mvi-ledger-verifier-protocol.md)) shipped unmountable in the real app: creating any session staged as `researcher` failed with `agent-preset-invalid … Cannot find package '@shres-code/shres-code-research-protocol' imported from ~/.shres/profiles/web/`. The preset's five plugin packages were declared only in `examples/package.json` — the keyless snapshot lane — never in `apps/cli/package.json` or a bundle manifest, so `healProfilesModuleFallback` (which links exactly the app-plus-bundle dependency closure into `$SHRES_HOME/profiles/node_modules`) never linked them. The same failure class previously dropped the pwsh packages from the CLI closure ([Windows pwsh default](../feature/2026-08-01-windows-pwsh-default.md)). Two gate gaps let it ship: `validateAppResolution` scanned only top-level `apps/cli/config/*.cordis.yml` and the app overlays, never `agent-presets/*/agent.cordis.yml`; and `packages/research/protocol` (directory `protocol`, npm suffix `research-protocol`) plus `packages/client/ui-speech` (directory `ui-speech`, npm suffix `client-ui-speech`) lacked the explicit `tsconfig.base.json` `paths` entries the generic wildcard cannot synthesize, so the [source-plane gate](../process/2026-07-30-cordis-config-source-plane-resolution-gate.md) was already red on master.

## Decision

Preset plugin rows resolve from the same app dependency surface as the shipped configs — they mount per session through [per-session agent presets](../architecture/2026-08-03-per-session-agent-presets.md), but resolution anchors do not change with the mounting plane. The five researcher packages (`research-protocol`, `tracker-shrestech`, `tool-tracker`, `ledger`, `tool-ledger`) are declared in `apps/cli/package.json`. `validateAppResolution` in `scripts/verify-cordis-config.ts` globs `agent-presets/*/agent.cordis.yml` into the shipped set it checks against that surface. Name-mismatched packages get explicit `paths` entries beside the existing sdk/ and timeout-policy precedents: `shres-code-research-protocol` (+ `/invariant`) → `packages/research/protocol/src`, and `shres-code-client-ui-speech` → `packages/client/ui-speech/src`.

## Alternatives considered

**A per-preset resolver manifest.** Rejected: presets are config trees under `apps/cli/config`, not packages; inventing a second resolution anchor per preset duplicates what the app manifest already is for every other config that boots through the app.

**Heal the profile fallback by scanning preset YAML.** Rejected: that re-derives the dependency graph from YAML at boot instead of letting pnpm link the declared graph once; the gate, not the healer, is where undeclared rows must fail.

**Rename `packages/research/protocol` to match the wildcard.** Rejected: group-prefixed naming (`research/protocol` → `shres-code-research-protocol`) is the sdk/ scheme, and explicit entries are the established pattern for name mismatches; a rename churns every reference for no semantic gain.

## Consequences

A preset row naming an undeclared package is now a red `verify-cordis-config` at the exact file — proven red with the five researcher errors before the declarations landed, green after — and both previously-failing specifiers resolve to workspace source, returning the gate to green on master. The Web app mounts the researcher preset once the installation re-links (`pnpm install`) and the server restarts. The gate still cannot see plugins a package mounts by runtime string (the chooser's `BACKEND_PACKAGES` pattern remains the hand-maintained exception).
