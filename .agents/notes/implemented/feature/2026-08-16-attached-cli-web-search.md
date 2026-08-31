# Agent Note: Attached-CLI web search default

Status: implemented

## Problem

Shipped `web_search` pinned `searchProvider: deepseek-official`. A user who attached Grok, Claude, Codex, or Kimi as a conversation CLI still paid DeepSeek for search, or had no search at all without `DEEPSEEK_API_KEY`. Spawning those CLIs for search would run a second full agent (`--yolo` / `--always-approve`) and return prose instead of `sources[]`.

## Decision

`ctx.web` accepts an ordered `searchProviders` / `fetchProviders` list. A singular pin stays exclusive. The list is first-usable-wins and is ignored when a pin is set.

`web-search-attached-cli` registers id `attached-cli`. It POSTs to the attached vendor's hosted search tool with the same credential that conversation adapter already stores (`XAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MOONSHOT_API_KEY`, `OLLAMA_API_KEY`, `ZAI_API_KEY`). It does not spawn `grok`, `claude`, `codex`, or `kimi`.

Backend pick: the current conversation vendor when that route is a shipped id in this list; otherwise the first usable id in preference (default Grok, Claude, Codex, Kimi, Ollama Cloud, Z.AI). The shipped base composition lists `attached-cli`, then `perplexity`, then `deepseek-official` ([the Perplexity settings note](2026-08-30-settings-websearch-perplexity.md) owns the middle entry's key-presence availability).

The Plugins **Web search** card exposes one on/off switch per method (Grok, Claude, Codex, Kimi, Ollama, Z.AI, Perplexity, DeepSeek). A switch off removes that method from the pool. DeepSeek off stops the DeepSeek-missing-key failure when the user is not using DeepSeek.

Grok calls `POST https://api.x.ai/v1/responses` with `{ type: "web_search" }`. Ollama Cloud calls `POST https://ollama.com/api/web_search`. Z.AI calls `POST https://api.z.ai/api/paas/v4/web_search` (retrieval-only, no model turn; its fixed `search_result[]` envelope validates and maps `link`/`title`/`content`/`publish_date` onto sources). Claude, Codex, and Kimi use their vendor equivalents.

## Alternatives considered

**Spawn the attached CLI with a search prompt.** Rejected because those binaries are full agents, extraArgs include yolo/always-approve, and their stdout is prose without a stable `sources[]` mapping.

**One provider package per vendor.** Rejected because four usable search providers with no pin is `WEB_PROVIDER_AMBIGUOUS`. One multiplexer keeps a single registry id.

**Keep DeepSeek as the exclusive pin.** Rejected because an attached CLI already has a billed search tool, and a user without `DEEPSEEK_API_KEY` then has no search.

**Route search through `ctx.llm`.** Rejected because the conversation adapter is a spawned CLI, not the vendor HTTP search tool.

**Use Z.AI's chat-completions `web_search` tool.** Rejected for the Z.AI backend: that path spends a GLM model turn to generate an answer and returns citations the tolerant walker would have to scrape, while the standalone Web Search API returns structured `search_result[]` rows (title, summary, link, publish date) with no model turn at all — the Ollama Cloud retrieval precedent with a validated envelope.

## Consequences

Attaching a CLI or Ollama Cloud on the Models page also attaches web search to that vendor. DeepSeek search remains the fallback when no listed vendor has a key. `available()` is a sync snapshot of env, the credential cache, and the current conversation vendor; a keyless attached vendor fails the search instead of silently selecting DeepSeek. `search()` refreshes credentials then re-reads the snapshot so a key that lands during refresh is used on that same call. CLI search still costs a vendor model turn; Ollama Cloud is a retrieval endpoint.
