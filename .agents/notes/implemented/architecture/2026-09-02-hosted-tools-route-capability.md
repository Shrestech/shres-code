# Agent Note: hosted tools as a declared route capability

Status: implemented

## Problem

Web-search selection did not follow the model route. The harness's one in-conversation native-search path — the provider executes the search as a server-side tool — existed only on `grok-session`, behind that plugin's private `hostedSearch` adapter option and two default-off switches, while every other route served the local `tool-web` `web_search` regardless of provider. The user direction: a selected provider that serves its own web search should supply it, the same way a selected model supplies vision, and the local chain is the fallback for routes that do not.

## Decision

Make hosted tools a **declared per-route capability with adapter-side enforcement**, in the two layers vision already uses:

- **Declaration + enforcement.** `hostedTools: { webSearch?, xSearch? }` on `PiAiProviderProfile` (route default) and on `PiAiModelProfile`/`PiAiModelOverride` (per-model, merged per field over the route's). Resolution (`resolveRouteModels`/`resolveProfiles`, the `reasoningEfforts` owners, reused by the settings validator) materializes the effective per-model set and fails loud naming route, model, and field — on a non-boolean switch and on a tool the model's dialect does not serve (`x_search` is `openai-responses`-only). `PiAiAdapter` derives the splice per request from the materialized declaration through a dialect module (`hosted-tools/<dialect>.ts` behind `hostedToolsDialectFor`): entries appended to the outgoing `tools`, colliding local tools dropped (hosted wins), hosted names that surface as pi-ai tool calls promoted to `server-tool-call` blocks. The grok-session-private `hostedSearch` hook is deleted; every pi-ai route gets the behavior, including dict-configured ones like `zai`.
- **Advertisement.** `LlmModelInfo.hostedTools?: readonly HostedTool[]` (`HostedToolMap` merge-extensible like `ModelModalityMap`), detached in the llm service projection beside `detachedModalities`, carried through the apiproxy schema, the Web picker (a `web search` marker beside vision), the models CLI marker, and the replay/fixture validators. Advisory for surfaces; enforcement stays in the adapter.
- **Defaults.** The code default for an absent declaration is off — local chain unchanged. grok-session's two settings switches keep their names, flip to default **on** (matching the Grok CLI's own sampler, which always carries both), and now feed the profile declaration instead of the deleted hook.

## Alternatives considered

**A tool-availability signal that follows the selected route** (unregister `web_search` when the route is native). Rejected: `tool-web`'s stable registration is a documented contract, the tool catalog is deliberately constant for request-cache stability, and a global default-model service cannot see per-session or per-purpose selections — only the adapter building the in-flight request knows its route. Per-request payload suppression touches neither the registry nor the cache key.

**Model-info field only** (declare on `LlmModelInfo`, let consumers decide). Rejected alone: nothing but the adapter can drop the local tool and splice the hosted entry, and pickers would need pi-ai types. The field stays as the advertisement layer.

**Per-plugin config switches generalized.** Rejected: the `zai`/`openai`/`anthropic`/`xai` routes are entries of the one `llm-pi-ai` providers dict — there is no per-route plugin to carry a switch — and the profile vocabulary is where `reasoningEfforts` already lives.

## Consequences

The session-log invariant holds with no new event: the offered tools are the stable registry minus `web_search` exactly when the logged call's route resolves hosted web search, and hosted executions ride the existing `server-tool-call` content block (the loop structurally never dispatches it). No `SESSION_FORMAT_VERSION` bump. Two resolution traps are now pinned by tests: the config schema materializes an absent `hostedTools` object as `{}`, so resolution treats an all-absent dict as "inherit the route" rather than a whole-dict replace; and per-model switches merge per field, so `{ xSearch: false }` on a route with web search on keeps web search. Spend: each default-on declaration adds hosted-search billing on that route; new vendor declarations ship one per PR as reviewable composition rows (z.ai is next, pending its `openai-completions` dialect module and response-surface spike). pi-ai 0.83 drops response-side `web_search_call` items and exposes no response-body hook, so a hosted web search may execute with its search action unlogged (the answer text still logs); `x_search` surfaces and is promoted live. The [`grok-session` note](2026-08-30-grok-session-provider.md) retains the wire-facts history; this note owns the generalized capability.
