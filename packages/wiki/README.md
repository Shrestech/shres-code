# wiki/ — Project long-term markdown memory

Per-project wiki: the long-term knowledge tier of the memory stack (session log is episodic, the J-Space card is working memory, wiki is durable knowledge, skills are procedural). Markdown store, mechanical forgetting, cheap/local models for librarian work.

Wiki content reaches the model only through tools. The filesystem provider, tools, embeddings, and librarian are host-owned in the base bundle. Removing any one wiki package leaves the harness booting.

| Package | Role | ctx key |
|---|---|---|
| [`wiki/`](wiki/README.md) | Service Definition: contract, temperature/demotion/lint folds, settings namespace `wiki`, `wiki/page` | `ctx.wiki` |
| [`wiki-filesystem/`](wiki-filesystem/README.md) | Provider: markdown store at `<projectRoot>/.shres/wiki` | `ctx.wiki` |
| [`tool-wiki/`](tool-wiki/README.md) | Consumer: `wiki_search` / `wiki_read` / `wiki_write` / `wiki_log` | — |
| [`wiki-embed-onnx/`](wiki-embed-onnx/README.md) | Optional embeddings provider; absent search is BM25-only | — |
| [`wiki-librarian/`](wiki-librarian/README.md) | Cheap-model consolidator; unbound = dormant | — |

Design: LLM Wiki as project long-term memory.
