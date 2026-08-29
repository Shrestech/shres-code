# @shres-code/shres-code-tool-wiki

Model-facing Consumer for `ctx.wiki`. Registers `wiki_search`, `wiki_read`, `wiki_write`, and `wiki_log` while the seat is active. Disabling the `wiki` settings namespace unloads every schema. Wiki content reaches the model only through these tools — never as a system-prompt section.

`wiki_read` bumps `touched` itself so temperature decay cannot be gamed by omitting an honor-system field.

## Tools

See the generated [tool catalog](../../../docs/tool-catalog.md). Deltas not in the catalog:

- `wiki_read` records access on the page it returns.
- `wiki_write` never lets the model set `created` / `updated` / `touched`.
- Failed writes surface the seam's `WikiFailureReason` verbatim.

UI render intent is `generic` with `kind` `search` / `read` / `edit`.

## Model Experience

### Via wiki_search / wiki_read / wiki_write / wiki_log

#### What the model sees

The four tool schemas in the generated [tool catalog](../../../docs/tool-catalog.md#wiki_search), plus the rendered result text of each call. No prompt section.

#### Token effect

Conditional: zero until a tool is listed in the request catalog and called. Results replace nothing in the system prompt; they append as `tool/result`.

#### KV Cache effect

Append-only on call: listing the four schemas is prefix-stable while the seat stays enabled. Disabling the seat removes the schemas and invalidates a reusable prefix that included them.

## Known Limitations and Deferred Work

- **No prompt section** — by design. A disabled seat leaves zero wiki tokens in the request.
- **Search does not bump `touched`** — only `wiki_read` records access, so a search-only session does not warm pages.
