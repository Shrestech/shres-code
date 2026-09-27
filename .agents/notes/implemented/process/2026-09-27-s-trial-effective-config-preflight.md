# Agent Note: S-trial effective-config preflight

Status: implemented

## Problem

An S trial logs `request/header.config` as the effective call. After `--resume`, later headers can mark `reasoningEffort` as an adapter default while a later header carries the same `high` as explicit. The effective call is unchanged. Comparing `proposalFromHeader(header)` (which deletes fields marked true on `adapterDefaults`) to `currentSelection()` therefore refuses a valid resumed S trial as `request-config-mismatch`.

## Decision

Each S trial computes one `sPrepared = (await ctx.llm.prepareCall(currentSelection())).config` before its consults, never dispatched, and memoizes it across that trial's headers. Every S `request/header.config` must equal `sPrepared` field for field over the `LlmCallConfig` fields present on either side (`provider`, `model`, `reasoningEffort`, `maxTokens`, `temperature`, `stop`). A mismatch is still `request-config-mismatch`. C trials make no such call. Consults still pass unprepared `currentSelection()` into `replayConsultInput` with `runtime = ctx.llm`. The counting proxy tags the preflight `s-validation` (1 `prepareCall` per S trial, 0 per C) separately from consult counts (2 per ask/ineligible, 0 warm).

## Alternatives considered

**Compare `proposalFromHeader` to `currentSelection`.** That is the loop's request-proposal strip of adapter-default markers. It treats a marker change with an identical effective config as a mismatch, so resumed S trials with seq 10 (effort marked default) and seq 28 (effort explicit) fail.

**Call `prepareCall` once per S consult header.** Eligibility already prepares inside `replayConsultInput`. A second call per consult would double lookup counts and is not the public prepared config. One trial-wide memo is enough because S's current selection does not change across that trial's headers.

**Reuse a consult-path prepared config.** The facade does not expose the base prepared config, and a warm consult has no eligibility prepare. The preflight call is independent of consult preparation.

## Consequences

Resumed S logs whose effective config matches `prepareCall(currentSelection())` are accepted at every header, including mixed adapter-default markers. An effective `maxTokens` or effort mismatch still refuses the trial after exactly one s-validation `prepareCall`. Consult-phase counts stay the accepted 2/0 split. The product `prepareCall` / header-fold path is unchanged.
