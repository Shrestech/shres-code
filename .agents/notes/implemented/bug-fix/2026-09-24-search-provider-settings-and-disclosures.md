# Agent Note: Search-provider setup and independent disclosure

Status: implemented

## Problem

The shipped routine search order starts with Brave when its credential is available, but Customize exposed no Brave setup. Provider fields also used enablement as their visibility state, so closing Perplexity's fields required disabling deep research. The Web BFF omitted Brave and Perplexity from its explicit settings allowlist. Perplexity's hidden namespace was projected as an enabled switch even though its staged edits could not affect the provider.

## Decision

The BFF explicitly exposes both Brave and Perplexity settings while retaining rejection of unrelated namespaces and secret-role redaction. The Web search card binds Brave's existing settings namespace and writes its key through the credentials service using the configured `apiKeyEnv` reference. Brave appears first and its hint describes the shipped default order without claiming that every deployment uses that order. Routing remains deployment-owned; the card does not add a priority selector.

Brave, Perplexity, and DeepSeek share local disclosure behavior independent of their enable switches. With no explicit disclosure choice, setup stays collapsed until credential metadata arrives, then expands only for an enabled provider without a key or a provider with unsaved edits. User disclosure choices take precedence over later metadata responses. Folding preserves drafts and performs no mutation. Each provider uses its own namespace availability and writability. Missing sections show disabled, unchecked switches and no credential fields.

The card distinguishes routine `web_search`, Perplexity-backed `deep_research`, and Grok's subscription-hosted X search. The API-key-backed Grok web method does not expose X search to other chat routes.

The [provider grouping decision](2026-08-31-web-search-settings-provider-grouping.md) retains ownership of provider-specific labels and field order; independent disclosure supersedes only its flat presentation. The [Perplexity settings decision](../feature/2026-08-30-settings-websearch-perplexity.md) retains the credential-refresh and availability rationale. Neither is fully superseded or archived.

## Alternatives considered

- **Disable a provider to hide its settings.** This changes search availability for a reading gesture and makes enabled providers impossible to fold.
- **Store keys in ordinary settings.** Keys belong to the credential service, whose responses expose configured/writable state without returning values.
- **Add a default-provider selector.** Search priority is startup composition, not an existing live settings section. A selector would require a separate routing decision.
- **Expose a global X-search switch.** Hosted X search belongs to the Grok subscription route; that switch would promise functionality the generic web-search provider does not implement.

## Consequences

Brave can be configured without editing deployment files. Collapsing an enabled provider leaves behavior and drafts unchanged, while unavailable providers no longer appear usable. Controller and mounted-component tests cover provider isolation, custom credential references, secret-only writes, repeated toggles, and disclosure. The real-composition browser scenario covers Brave credential setup, staged Perplexity edits across folds, and the rendered accessibility snapshot. Grok hosted-search tests retain the existing X-search wire behavior.
