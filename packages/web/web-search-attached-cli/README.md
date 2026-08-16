# @roos-code/roos-code-web-search-attached-cli

A `WebSearchProvider` that reuses an **attached conversation vendor's hosted search API** — Grok (xAI), Claude (Anthropic), Codex (OpenAI), Kimi (Moonshot), or Ollama Cloud — with the same credential that adapter already stores.

This is an **implementation** package: it registers provider id `attached-cli` into `ctx.web` and does not register a model-facing tool. It does **not** spawn `grok`, `claude`, `codex`, or `kimi`. Those binaries are full agents. CLI vendors POST to a web-search server tool. Ollama Cloud POSTs to `https://ollama.com/api/web_search`. Citations map onto `{ sources[], content? }`.

## When it is usable

`available()` is true when the current default model is an enabled shipped vendor in this list, or when at least one backend has a non-empty key in the launch environment or the credentials cache (`XAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MOONSHOT_API_KEY`, `OLLAMA_API_KEY`).

`search()` refreshes the credential cache and then re-reads the snapshot before picking a backend, so a key that was only in the credentials store (not `$OLLAMA_API_KEY` in the process environment) is used on that same call. A selected backend whose key is still missing after refresh fails as `WEB_PROVIDER_CREDENTIAL_MISSING` instead of falling through to another vendor.

## Selection

1. If the current default model provider is an enabled shipped vendor in this list, use that vendor.
2. Else the first enabled usable id among Grok, Claude, Codex, Kimi, Ollama Cloud.

The Plugins **Web search** card turns each method on or off. The shipped web seam lists `attached-cli` before `deepseek-official`, so an enabled method with a key runs before DeepSeek.

## Config

| Key | Default | Meaning |
|---|---|---|
| `grok` / `claude` / `codex` / `kimi` / `ollama` | `true` | When false, that vendor is omitted from the search pool |

```yaml
- id: web-search-attached-cli
  name: '@roos-code/roos-code-web-search-attached-cli'
```

## Mapping

Vendor JSON is walked for http(s) URLs (`url` / `uri` / `link`) and optional `title` / `snippet` / `content`. Grok and Codex `output_text` plus assistant `content` become `content` when present. Duplicate URLs keep the first title and snippet. The seam enforces `maxResults`.

HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. Caller cancellation surfaces as `WEB_ABORTED`.

## Model Experience

Indirectly, through [`roos-tool-web`](../tool-web/README.md), which retains this provider's URLs, titles, snippets, and optional vendor answer text or its exact `attached CLI search aborted`, `attached CLI search request failed: <error>`, `attached CLI search (<id>) failed: HTTP <status>`, `attached CLI search (<id>) returned an unprocessable body: <error>`, and missing-credential failures under the consumer's error wrapper. A separate vendor model receives the query plus that vendor's native web-search tool; that request is not part of the conversation model's context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes. The auxiliary vendor request is independent of the conversation request cache.

## Known Limitations and Deferred Work

- **One search is a full vendor model turn for CLI vendors** — Grok, Claude, Codex, and Kimi expose search as a server tool on Messages/Responses. Ollama Cloud is a dedicated retrieval endpoint.
- **CLI aliases are not search model ids** — conversation ids such as `sonnet` and `k2` are not sent on the search request; each backend uses a fixed vendor model.
- **Credential cache is asynchronous** — `available()` can see the current CLI route before the credentials store answers; a keyless attached CLI then fails the search rather than silently selecting DeepSeek.
