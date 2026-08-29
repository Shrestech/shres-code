# @shres-code/shres-code-wiki

The **`WikiService`** (`ctx.wiki`) defines WHAT long-term project memory the harness has — read, list, search, write, append a day-sharded log, lint, reindex — without binding the model contract to one store. Wiki content reaches the model only through the tool Consumer; this seam never injects pages into the system prompt.

This package owns the Service Definition role of the wiki capability. Persistence, tools, embeddings, and the librarian seat live in sibling packages:

| Package | Role |
|---|---|
| `@shres-code/shres-code-wiki` (this) | Service Definition: the service contract, frontmatter model, temperature/demotion/lint folds, request/spec split, settings namespace `wiki`, and the log-only `wiki/page` session event |
| `@shres-code/shres-code-wiki-filesystem` | Provider: markdown store at `<projectRoot>/.shres/wiki` |
| `@shres-code/shres-code-tool-wiki` | Consumer: `wiki_search` / `wiki_read` / `wiki_write` / `wiki_log` |
| `@shres-code/shres-code-wiki-embed-onnx` | Optional embeddings provider; absent search is BM25-only |
| `@shres-code/shres-code-wiki-librarian` | Cheap-model consolidator; unbound = dormant |

The seam follows the [capability seam](../../../docs/glossary.md#capability-seam) definition: a Service Definition / Service Provider / Consumer trio, complete, never one role.

## Service API (`ctx.wiki`)

| Member | Semantics |
|---|---|
| `read(path)` | Return one parsed page, or `undefined`. Does not bump `touched`. |
| `list(filter)` | Temperature-ranked pages. Archive is omitted unless `includeArchive`. |
| `search(query, options)` | BM25 plus optional cosine mix-in; HOT ranks above COLD. Archive omitted by default. |
| `similar(path)` | Dedup/link shortlist against one seed page. |
| `writePage(session, request)` | Validate, persist, log `wiki/page`, regenerate `index.md`, demote COLD-past-`demoteDays` pages. |
| `appendLog(session, request)` | Append to `log/YYYY-MM-DD.md` and log `wiki/page` with `op: 'log'`. |
| `touch(session, path)` | Read-path access bump. Tools call this; the model never sets `touched`. |
| `lint()` | Orphans, dead links, missing freshness, index drift. Zero LLM tokens. |
| `reindex(session?)` | Rebuild `index.md` and demote. |
| `registerEmbeddings(provider)` | Optional mix-in; dispose falls back to BM25. |
| `status` / `watch` | Seat remount. `enabled: false` sets `active: false`. |

Providers implement `persistPage`, `persistTouch`, `persistLog`, `persistDemote`, `persistIndex`, `loadPages`, `loadIndex`, and `hasPage`. The seam's concrete methods own defaulting, ranking, lint, and event logging so those never vary by provider.

## Request/spec split

`writePage` accepts a `WikiWriteRequest` and resolves it through the pure, exported `resolveWrite(request): WikiWriteSpec`. That step rejects a blank path (`required-field`), a path that is not wiki-relative markdown (`invalid-path` — no `..`, no `index.md`/`config.yaml`/`log/*`), and a blank title. `appendLog` goes through `resolveLog`. Providers never re-default.

## Temperature and demotion

`temperatureOf(touched, now, config)` is a fold: age ≤ `hotDays` is HOT, age ≤ `warmDays` is WARM, otherwise COLD. A COLD page whose age exceeds `demoteDays` leaves the default search/index set into `archive/` and is never deleted. All four numbers are Config fields.

## Settings

Namespace `wiki` (via `installSettingsSection`):

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master allow. False unloads tools and refuses writes, logs, touch, and librarian dispatch. No directory is created until the first write. |
| `hotDays` | `7` | HOT threshold in days. |
| `warmDays` | `30` | WARM threshold in days; must be ≥ `hotDays`. |
| `demoteDays` | `90` | Archive threshold in days; must be ≥ `warmDays`. |
| `indexMaxLines` | `200` | Cap on generated `index.md`. |
| `roles.librarian` | unbound | `{ provider, model }` pair; both required to bind. |

`enabled: false` wins over a stored librarian binding.

## Session events

`writePage` / `touch` / `appendLog` / demotion write the log-only, `ignorable` event `wiki/page` `{ path, op }` with `op` one of `create` / `update` / `archive` / `touch` / `log`. The event is written only after the provider returns.

## Model Experience

None, as this seat stores project markdown and ranked search results; the tool Consumer owns every model-visible byte.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No wiki→skill graduation** — pages never write skills. A later change would go through the skill hot-reload path behind `verifyDecisionRule`.
- **No cross-project index** — one wiki root per project `.git` walk.
- **Search mix-in is in-process** — semantic ranking requires the embeddings provider to be mounted in the same context; a missing provider is BM25-only, not an error.
