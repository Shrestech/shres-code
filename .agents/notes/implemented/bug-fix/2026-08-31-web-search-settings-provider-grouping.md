# Agent Note: Group each web-search method's fields under its switch

Status: implemented

## Problem

The Settings web-search card listed every method switch first, then Perplexity's key and endpoint, then DeepSeek's key, endpoint, and budget. Both methods ship on, so Perplexity's fields rendered directly under the DeepSeek switch, and DeepSeek's key and endpoint used the generic labels `API key` and `Endpoint`. A user opening Plugins → Web search therefore read Perplexity's credential fields as DeepSeek's.

The shipped Perplexity surface is [the Settings Perplexity web-search note](../feature/2026-08-30-settings-websearch-perplexity.md); this note owns only the grouping and the DeepSeek-prefixed labels.

## Decision

Each method's extra fields render immediately under that method's switch, still as siblings inside the methods list so adjacent `.field` borders continue to apply. DeepSeek's key and endpoint copy is `DeepSeek API key` and `DeepSeek endpoint`, matching Perplexity's prefixed labels so two password fields in one card cannot share an accessible name.

## Alternatives considered

**Keep all extra fields after the last switch, and rely on prefixed Perplexity labels.** Rejected: document order still places Perplexity's key under DeepSeek's heading, which is the mix-up the Settings page actually shows.

**Add indent or a nested group chrome around each method's extra fields.** Rejected: grouping is already the document order; extra structure would restyle a list that already has per-field borders.

**Leave DeepSeek's labels generic once the fields sit under the DeepSeek switch.** Rejected: both methods default on, so two password fields remain in the accessibility tree, and a generic `API key` is still an ambiguous name next to `Perplexity API key`.

## Consequences

Expanding Web search shows Perplexity's switch, key, and endpoint as one block, then DeepSeek's switch and its own fields. Turning a method off still hides only that method's extra fields.

## Testing

`packages/client/ui-settings-plugins/tests/section.client.spec.tsx` pins document order: Perplexity switch, Perplexity key, Perplexity endpoint, DeepSeek switch, DeepSeek key. `apps/web/tests/plugin-config.e2e.ts` expands the real shipped card and asserts the same vertical order, the distinct DeepSeek labels, and an expanded-card golden `web-search.expected.md`.
