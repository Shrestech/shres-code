# Agent Note: llm-cursor-session boots config-less entries — export the Config schema

Status: implemented

## Problem

`shres web` (and every profile mounting the base bundle) died during boot with `failed to apply loader entry llm-cursor-session: Cannot read properties of undefined (reading 'displayName')`. The bundle entry carries no `config` section. Cordis normalizes plugin config through the plugin module's exported `Config` schema (`vendor/cordis/src/fiber.ts` `resolveConfig`); `llm-cursor-session` exported `Config` only as a type, so `apply` received raw `undefined`, and `registerAdapter`'s synchronous `providerInfo()` call reached `resolveConfig(undefined)` and aborted the whole plugin tree.

## Decision

`packages/llm/llm-cursor-session/src/index.ts` re-exports the `Config` schema value from `./config.ts`, matching the `llm-grok-session` and `llm-codex-session` adapters. The schema then normalizes an absent config to its defaults before `apply` runs, and the package's real-composition test gains a no-`config` boot case mirroring the shipped bundle posture.

## Alternatives considered

**Default the parameter in `apply` (`config = {}`).** Rejected: it fixes this one plugin while leaving the schema unexported, so settings validation and every other schema consumer still see nothing; the sibling adapters own the parity pattern.

**Validate defensively inside `resolveConfig`.** Rejected: `resolveConfig` takes an already-validated `Config`; per the typed-boundary rule, validation belongs at the loader schema, not inside a typed callee.

## Consequences

Config-less bundle entries boot; the composition test now pins the shipped posture instead of only the explicitly configured one. The defect shipped with the route in [the cursor subscription session note](../architecture/2026-09-15-cursor-subscription-session.md); nothing about that decision changes.
