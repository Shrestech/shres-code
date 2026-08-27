# Agent Note: provider endpoint variants — one-click endpoint switch in the Models settings card

Status: implemented

## Problem

A provider route can serve the same API family at multiple endpoints that take different credential classes — Moonshot's platform API (`api.moonshot.ai/v1`, platform keys) versus the Kimi Code endpoint (`api.kimi.com/coding/v1`, coding-plan credentials). The settings card only exposed a free-text Base URL inside collapsed Custom Settings, so pointing a shipped route at its coding endpoint required the user to discover the URL and hand-type it, with no hint that a different credential was needed.

## Decision

`PiAiProviderProfile.endpoints` declares a route's known alternate endpoints (`id`, `label`, `baseURL`, optional `hint`). Variants are metadata only: the active endpoint remains the plain `baseURL` override, so a hand-written URL stays authoritative and existing profiles are unaffected. The base profile declares the moonshotai pair (platform + Kimi Code with credential hints). The Models settings card (`ProviderEditor`) renders the declared variants as a chip picker above Custom Settings when a route declares two or more; picking one stages the ordinary `baseURL` override through the same settings-mutate path the Base URL field uses, and the active chip reflects the stored override. Routes with fewer than two variants render nothing new.

## Alternatives considered

**A dedicated kimi-coding route.** Rejected: duplicates the model catalog and credential reference for one endpoint difference, and the next variant (regional endpoints, proxies) would multiply routes.

**Auto-detecting endpoints from the key shape.** Rejected: credential classes are a provider account property, not derivable from the key string.

**Putting the picker inside Custom Settings.** Rejected: the whole point is discoverability at the card's top level; a collapsed drawer hides the choice it exists to offer.

## Consequences

Any shipped or custom pi-ai route can advertise its endpoints without code changes (settings-level `endpoints`); the moonshotai coding endpoint is one click after pasting a coding-plan key. The picker writes no new state shapes — only the existing `baseURL` — so wire compatibility and snapshots beyond the moonshotai profile are unchanged. Config catalog regenerated; the token-meter type-equiv block carries `headerTokens` (companion sync for the compaction surface-pressure fix).

## Testing

`packages/client/ui-settings-models`: 246 passing including two new cases — variants render and Apply writes `providers.moonshotai.baseURL`; sub-two-variant routes render no picker. `packages/llm/llm-pi-ai`: 221 passing. Typecheck, doc-sync 26/26, bench 277/277.
