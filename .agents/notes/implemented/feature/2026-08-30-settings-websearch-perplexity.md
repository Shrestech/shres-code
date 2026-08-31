# Agent Note: Perplexity web search in the shipped fallback and the Settings card

Status: implemented

## Problem

`@shres-code/shres-code-web-search-perplexity` shipped as a provider package with unit and e2e coverage, but no deployment mounted it and no surface configured it: the base bundle's `searchProviders` was `[attached-cli, deepseek-official]`, and the Settings web-search card staged only the attached-CLI method flags and DeepSeek's fields. A user holding a Perplexity key could not turn the provider on without hand-editing a composition.

Mounting it is not a one-line bundle row, because the provider would sit **mid-fallback** in the chain [the attached-CLI search note](2026-08-16-attached-cli-web-search.md) owns. DeepSeek official is the terminal entry: its `available()` is true whenever it is enabled (its key resolves per search, and a keyless search fails with an actionable `WEB_PROVIDER_CREDENTIAL_MISSING`), which is exactly right only because nothing follows it. A provider placed between `attached-cli` and `deepseek-official` with the same availability semantics would shadow DeepSeek in every default deployment — enabled by default, always "available", then failing for the missing `PERPLEXITY_API_KEY` even when a DeepSeek key exists. The old Perplexity package also resolved its key once at boot from config or `$PERPLEXITY_API_KEY`, so a key written later through the Settings card could never reach it.

## Decision

Perplexity ships as the middle entry of the base bundle's search fallback — `[attached-cli, perplexity, deepseek-official]` — with **key-presence availability** and a credentials-seam key lifecycle:

- The provider's options become a per-call snapshot (the attached-CLI/DeepSeek thunk pattern). `available()` requires a resolved key in the snapshot, so a keyless Perplexity drops out of the chain and DeepSeek keeps serving; the shipped behavior without a Perplexity key is byte-identical to before.
- The plugin keeps a credential cache filled from the credentials domain (the Settings web-search card writes `PERPLEXITY_API_KEY` through it), with the launching environment as the no-seam fallback. The cache refreshes at boot, before every search, and on a `credentials/updated` commit naming the section's reference — the event exists for this activation gap, since a keyless provider is never searched and a search-time refresh alone could never observe the write. The cache is keyed by reference, so a section renaming `apiKeyEnv` never serves a key resolved under the old name.
- A search that refreshes and still finds no key fails `WEB_PROVIDER_CREDENTIAL_MISSING` with the same actionable wording as DeepSeek's; a credential-backend failure fails `WEB_PROVIDER_ERROR`, never as a missing key. Redirects stay rejected before contact.
- The section installs as the `web-search-perplexity` settings namespace (`apiKey` secret-role, `apiKeyEnv` credential-ref-role, `model`/`maxTokens` schema-defaulted so a configuration surface renders resolved values, `enabled` default on), so the Settings page edits it and a settings provider layers user values over the composition entry without re-registration.

The Settings web-search card gains a Perplexity switch (between Ollama and DeepSeek, mirroring the fallback order) with a key field and an endpoint field shown immediately under that switch while the method is on — DeepSeek's section shape, minus the DeepSeek-specific `maxUses` budget. The grouping of each method's extra fields under its switch is owned by [the web-search provider-fields note](../bug-fix/2026-08-31-web-search-settings-provider-grouping.md). Perplexity's section keys collide with DeepSeek's on the card's flat edit protocol (`enabled`, `baseURL`, `apiKey`), so the card addresses them through `perplexity*` aliases the controller maps back onto section keys. The card's credential tracking, previously one DeepSeek-specific flow, extracts into a `CredentialTracker` the two sections share; Perplexity's key and endpoint carry their own labels (`Perplexity API key`, `Perplexity endpoint`) because both sections can render at once and one accessible name cannot address two controls.

The `web-search-round` e2e scenario drives a DeepSeek double and asserts one exact wire call, so the scaffold pins `web-search-perplexity` `enabled: false` in that lane: a recorder host with `PERPLEXITY_API_KEY` exported would otherwise hijack the recording.

## Alternatives considered

**DeepSeek-style availability (always available when enabled, key resolved per search).** Rejected: as the middle fallback entry it would shadow `deepseek-official` in every deployment that lacks a Perplexity key, turning today's working DeepSeek search into a `PERPLEXITY_API_KEY` credential error. Key-presence availability is the only semantics that keeps a mid-chain provider honest.

**Mount Perplexity after `deepseek-official`.** Rejected: DeepSeek is available whenever enabled, so Perplexity would serve only for users who first turn DeepSeek off — a search API that needs another provider disabled to be reachable is not meaningfully shipped.

**Env-only key, no settings section.** Rejected: the Settings card is the surface this change exists to feed, and the credentials domain is where the Models page already keeps vendor keys; an env-only Perplexity would be the one search method the UI cannot configure.

**Expose `model`/`maxTokens`/`searchRecency` on the card.** Deferred with the same evidence bar DeepSeek's equivalent fields met: they stay schema-editable in the section, and the card adds controls when a consumer demonstrates the need.

## Consequences

A deployment with no Perplexity key behaves exactly as before; adding a key through Settings → Plugins → Web search (or exporting `PERPLEXITY_API_KEY`) activates Perplexity without a restart, and rotation reaches the next search. The cost is a second credential lifecycle to reason about: availability now reads a cache that three triggers (boot, per-search, commit event) keep current, and a credential-backend outage at all three leaves the provider keyless rather than erroring — searches then fall through to DeepSeek, which is the intended degraded behavior but means a Perplexity outage is silent unless someone looks. The web e2e scaffold carries one new explicit pin tying the DeepSeek-double lane to that provider.

## Testing

`packages/web/web-search-perplexity/tests/perplexity.spec.ts` moves to the thunk constructor and adds the credential lifecycle: refresh-before-search, `WEB_PROVIDER_CREDENTIAL_MISSING` wording, refresh-rejection mapping (`WEB_PROVIDER_ERROR`, abort-shaped to `WEB_ABORTED`), a pre-aborted signal never fetching, boot surviving a failing credential backend, the `credentials/updated` listener filtered to the section's reference, and activation-plus-rotation through a real `LocalCredentialProvider`. `tests/settings.spec.ts` (new) mirrors the DeepSeek section suite: stored endpoint served without re-registration, secret redaction in described layers, entry fallback on settings-provider detach, namespace release on unload, and `enabled: false` dropping the provider from the pool. `packages/client/ui-settings-plugins` controller and section suites cover the alias routing, both credential trackers, and the switch/key/endpoint render rules. The assembled-browser lane is `apps/web/tests/plugin-config.e2e.ts` — a new case expands the Web search card against the real shipped composition and pins the Perplexity switch (on by default), the Z.AI switch, the password-typed `Perplexity API key` control, and the distinct `Perplexity endpoint` label, with no write reaching `settings.yaml` — plus the `web-search-round.e2e.ts` replay, whose goldens do not move because the search card is unchanged, with the scaffold pin above keeping the search lane on its DeepSeek double.
