# Agent Note: Attached-CLI web search default

Status: implemented

## Problem

Shipped `web_search` pinned `searchProvider: deepseek-official`. A user who attached Grok, Claude, Codex, or Kimi as a conversation CLI still paid DeepSeek for search, or had no search at all without `DEEPSEEK_API_KEY`. Spawning those CLIs for search would run a second full agent (`--yolo` / `--always-approve`) and return prose instead of `sources[]`.

## Decision

`ctx.web` accepts an ordered `searchProviders` / `fetchProviders` list. A singular pin stays exclusive. The list is first-usable-wins and is ignored when a pin is set.

`web-search-attached-cli` registers id `attached-cli`. It POSTs to the attached vendor's hosted search tool with the same credential `llm-cli-bridge` already stores (`XAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MOONSHOT_API_KEY`). It does not spawn `grok`, `claude`, `codex`, or `kimi`.

Backend pick: the current conversation CLI when that route is a shipped CLI id; otherwise the first usable id in `preference` (default Grok, Claude, Codex, Kimi). The shipped base composition lists `attached-cli` then `deepseek-official`.

The Plugins **Web search** card exposes one on/off switch per method (Grok, Claude, Codex, Kimi, DeepSeek). A switch off removes that method from the pool. DeepSeek off stops the DeepSeek-missing-key failure when the user is not using DeepSeek.

Grok calls `POST https://api.x.ai/v1/responses` with `{ type: "web_search" }`. Claude, Codex, and Kimi use their vendor equivalents.

## Alternatives considered

**Spawn the attached CLI with a search prompt.** Rejected because those binaries are full agents, extraArgs include yolo/always-approve, and their stdout is prose without a stable `sources[]` mapping.

**One provider package per vendor.** Rejected because four usable search providers with no pin is `WEB_PROVIDER_AMBIGUOUS`. One multiplexer keeps a single registry id.

**Keep DeepSeek as the exclusive pin.** Rejected because an attached CLI already has a billed search tool, and a user without `DEEPSEEK_API_KEY` then has no search.

**Route search through `ctx.llm`.** Rejected because the conversation adapter is a spawned CLI, not the vendor HTTP search tool.

## Consequences

Attaching a CLI on the Models page also attaches web search to that vendor. DeepSeek search remains the fallback when no CLI is attached. `available()` is a sync snapshot of env, the credential cache, and the current CLI route; a keyless attached CLI fails the search instead of silently selecting DeepSeek. Search still costs a vendor model turn.
