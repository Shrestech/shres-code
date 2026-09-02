# @shres-code/shres-code-web-search-brave

A `WebSearchProvider` backed by the [Brave Search API](https://api-dashboard.search.brave.com/): one `GET /res/v1/web/search` per query with the subscription token header, returning the link engine's `web.results[]` rows as the seam's `sources[]`. A link engine has no answer synthesis, so `content` is never set — the shape routine `web_search` lookups want, which is why the base bundle serves this provider from the routine chain while Perplexity is reserved for the `deep_research` tool's request-level pin.

This is an **implementation** package: it registers provider id `brave` into `ctx.web` and does not register a model-facing tool.

## When it is usable

`available()` is true when the section is enabled, a key resolves (literal `apiKey`, or the credential reference `apiKeyEnv` names — default `BRAVE_API_KEY` — through the credentials seam with `.env`/launch-environment fallback), the endpoint base parses, and `count` is a positive integer. A key stored after boot activates on the credentials commit event and on the next search's refresh; availability never makes network calls.

## Mapping

`web.results[]` rows become `{ url, title?, snippet: description?, publishedAt: page_age ?? age? }` — `page_age` (machine form) wins over `age` (humanized). A row without a usable URL is dropped. A 200 body without a `web.results` array is `WEB_PROVIDER_ERROR` (unprocessable), an empty array is a valid zero-source result. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`; caller cancellation surfaces as `WEB_ABORTED`. The seam enforces `maxResults`.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `BRAVE_API_KEY` | Credential reference resolved per search through the credentials seam. |
| `apiKey` | — | Literal subscription token; prefer `apiKeyEnv` so no secret enters configuration files. |
| `baseURL` | `https://api.search.brave.com/res/v1` | Endpoint base; `/web/search` is appended. |
| `count` | `8` | Upper bound on result rows requested per search. |
| `enabled` | `true` | When false, the provider is omitted from the search pool. |

```yaml
- id: web-search-brave
  name: '@shres-code/shres-code-web-search-brave'
```

## Model Experience

Indirectly, through [`shres-tool-web`](../tool-web/README.md), which retains this provider's URLs, titles, snippets, and published dates or its exact `Brave search aborted`, `Brave search request failed: <error>`, `Brave API error (HTTP <status>)`, `Brave search returned an unprocessable response body: <error>`, and missing-credential failures under the consumer's error wrapper. No auxiliary model turn exists.
