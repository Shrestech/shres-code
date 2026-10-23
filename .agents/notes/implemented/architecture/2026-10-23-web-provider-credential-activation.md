# Agent Note: web provider credentials resolve when the credentials seam activates late

Status: implemented

## Problem

A web search provider reads its API key through the [credentials seam](../../../../packages/credentials/credentials/README.md) when its plugin applies. Plugin activation order is not guaranteed: a [settings-file](../../../../packages/settings/settings-file/README.md) and a credentials provider both perform asynchronous startup work, so a provider can apply before `credentials` is registered. The fallback read the launch environment instead, which is empty for a GUI-launched application whose keys live in `$SHRES_HOME/.credentials.yaml`.

The resulting state was permanent for the process. The provider resolved once at apply time, its failure was swallowed by an empty `catch`, and the only other refresh trigger was the `credentials/updated` event, which never fires on its own. [WebRuntime](../../../../packages/web/web/README.md) then refused a pinned provider through the synchronous `available()` check before `search()` was entered, so the retry the code comment promised could never run. The keyless provider stayed unavailable for the lifetime of the process.

The symptom reached the model: `deep_research` pins `perplexity`, so it failed every call with `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`, while `web_search` kept working because it resolves through the ordered fallback list and skips unusable providers.

A second trigger produced the same dead end. `installSettingsSection` fires `onChange` on attach, on every committed section change, and on detach; the provider passed a no-op. A committed settings change that renamed `apiKeyEnv` left the cached reference pointing at the old name, and the option projection refuses to serve a cached key whose reference no longer matches the section, so `available()` went false with the same unreachable retry.

## Decision

Both keyed search providers, [Perplexity](../../../../packages/web/web-search-perplexity/README.md) and [Brave](../../../../packages/web/web-search-brave/README.md), converge their credential cache without a restart.

`ctx.inject(['credentials'], …)` re-runs the resolution when the seam registers, which closes the activation race; the child rides the plugin's own fiber, so it disposes with the plugin and re-runs when a replacement service appears. `onChange` runs the same resolution on every committed settings change, which closes the renamed-reference case. Failures at both off-search sites are reported with `ctx.logger.warn`, naming the credential reference and then the cause, and never the value; the empty `catch` is gone.

The `credentials` service is deliberately absent from the plugins' exported `inject`. Declaring it would make the plugin refuse to load in an assembly that never mounts the seam; those assemblies keep the launch-environment read as their only credential source, exactly as before.

The [WebSearchProvider service definition](../../../../packages/web/web/README.md) is unchanged.

## Alternatives considered

**Async availability on the service definition.** An optional `ready()` hook that `resolveProvider` awaits before judging `available()` would fix the class of problem generically. Rejected for this change: it alters a seam every provider and consumer implements, and the provider-side convergence removes the need.

**Single-flight over the boot and activation resolutions.** Merging the two refreshes would emit one warning pair instead of two. Rejected: if the launch-environment read is in flight when the seam appears, the activation refresh joins it and the race that this change closes reopens. Suppressing by error identity is also fragile and hides a genuine second failure.

**Declaring `credentials` in the exported `inject`.** This would order activation but force every environment-only deployment to mount the seam. Rejected: it replaces a race with a load failure.

**Keeping the swallowed boot failure.** Rejected: it is what made the dead end silent.

## Consequences

An assembly that mounts the credentials seam before the provider now resolves twice at boot. The writes are adjacent assignments after an await with the reference captured before it, and the option projection serves a cached key only when its reference equals the section's current reference, so the interleaving cannot serve a stale key; the visible cost is a repeated warning pair when both refreshes fail. A refresh outside a search can therefore report one root cause twice.

A persistent resolution failure still leaves a pinned provider unavailable for the process lifetime, because the service definition is unchanged and selection runs before any search. That path now names the credential reference in the host log, which is the operator surface; recovery is a restart. Providers that a deployment addresses through the fallback list are unaffected, since unusable members are skipped.

The two provider plugins remain separate copies rather than sharing a credential-resolution helper, mirroring the symmetry their `jscpd` ignore markers record. The regression coverage for the Brave settings surface is a near-copy of the Perplexity suite for the same reason.
