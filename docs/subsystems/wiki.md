# Wiki

Types shared by `ctx.wiki`, the markdown filesystem provider, the wiki tools, and the librarian seat. The [group README](../../packages/wiki/README.md) owns composition; this page records the frontmatter model, write request/spec, search hits, lint findings, and log-only events from [`packages/wiki/wiki/src/types.ts`](../../packages/wiki/wiki/src/types.ts).

Wiki content reaches the model only through tools. Temperature and archive demotion are computed folds: COLD-past-`demoteDays` pages leave the default search set into `archive/` and are never deleted. `writePage` accepts a `WikiWriteRequest` and resolves it through `resolveWrite(request): WikiWriteSpec`. Providers never re-default.

```ts type-equiv
/**
 * Frontmatter every knowledge page carries. `created`/`updated`/`touched` are
 * ISO-8601 instants; missing freshness fields are lint issues, not parse failures.
 */
interface WikiFrontmatter {
  /** Instant the page was first written. */
  readonly created: string
  /** Instant of the last body or frontmatter write. */
  readonly updated: string
  /** Instant of the last write or read-path access bump. */
  readonly touched: string
  /** Whether the page is in the default search set. */
  readonly status: WikiPageStatus
  /** Wiki-relative path of the page this one supersedes, when set. */
  readonly superseded_by?: string
  /** Wiki-relative paths of pages this one structurally contradicts. */
  readonly contradicts?: readonly string[]
  /** Optional classification tags. */
  readonly tags?: readonly string[]
}
```

```ts type-equiv
/** One parsed wiki page as the service and tools see it. */
interface WikiPage {
  /** Wiki-relative path, posix separators, `.md` suffix (for example `notes.md`). */
  readonly path: string
  /** Title from the first markdown heading, else the stem of `path`. */
  readonly title: string
  /** Markdown body after the frontmatter fence. */
  readonly body: string
  /** Parsed frontmatter. */
  readonly frontmatter: WikiFrontmatter
}
```

```ts type-equiv
/** Caller's page write REQUEST. `path` and `body` are required. */
interface WikiWriteRequest {
  /** Wiki-relative destination path. */
  readonly path: string
  /** Markdown body (frontmatter may be omitted; the seam fills freshness). */
  readonly body: string
  /** Optional title override; otherwise derived from the body heading or path. */
  readonly title?: string
  /** Optional tags stored on the page. */
  readonly tags?: readonly string[]
  /** Optional structural contradiction pointers. */
  readonly contradicts?: readonly string[]
  /** Optional successor path. */
  readonly superseded_by?: string
}
```

```ts type-equiv
/**
 * Fully resolved page write spec. Handed to providers by {@link resolveWrite};
 * persist paths never re-default.
 */
interface WikiWriteSpec {
  readonly path: string
  readonly title: string
  readonly body: string
  readonly tags: readonly string[]
  readonly contradicts: readonly string[]
  readonly superseded_by?: string
}
```

```ts type-equiv
/** One ranked search hit. */
interface WikiSearchHit {
  readonly path: string
  readonly title: string
  readonly temperature: WikiTemperature
  /** Combined ranking score (BM25 and optional cosine). Higher is better. */
  readonly score: number
  /** Short excerpt around the first query match, when one exists. */
  readonly excerpt: string
}
```

```ts type-equiv
/** One lint finding. */
interface WikiLintIssue {
  readonly code: WikiLintCode
  readonly path: string
  /** Extra path for `dead-link` (the missing target) or `index-stale`. */
  readonly target?: string
  readonly detail: string
}
```

`writePage` / `touch` / `appendLog` / demotion write the log-only, `ignorable` event `wiki/page`. The librarian appends `wiki/librarian-request` before every auxiliary model call.

```ts type-equiv
/** Durable payload of the log-only `wiki/page` event. */
interface WikiPageEvent {
  /** Wiki-relative path that was written, touched, archived, or appended. */
  readonly path: string
  /** The operation that produced this event. */
  readonly op: WikiPageOp
}
```

```ts type-equiv
/** Durable payload of the log-only `wiki/librarian-request` event. */
interface WikiLibrarianRequestEvent {
  /** Why this auxiliary call ran. */
  readonly purpose: WikiLibrarianPurpose
  /** Exact auxiliary LLM route. */
  readonly route: { readonly provider: string; readonly model: string }
  /** Exact auxiliary system prompt. */
  readonly system: string
  /** Exact auxiliary user prompt. */
  readonly prompt: string
  /** Exact auxiliary output-token cap. */
  readonly maxTokens: number
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxwiki--wikiservice-abstract-seam"></a>

### `ctx.wiki` — `WikiService` (abstract seam)

The abstract wiki service. Registered as `ctx.wiki` (one provider per context). A provider subclasses this, implements the persistence hooks, and loads the subclass as a plugin.

Persist and load hooks receive the calling session's project directory (session `cwd`): a provider roots relative store locations there, so each session lands in its own repository's wiki. Sessions without a recorded `cwd` fall back to the provider's deployment default.

Implementations must honor these semantics:

- persistPage writes a resolved spec under its path, creating directories on first write (lazy materialization).
- persistTouch updates only `touched` on an existing page.
- persistLog appends one timestamped JSONL line to the day shard.
- persistDemote moves a COLD-past-`demoteDays` page into `archive/`.
- persistIndex replaces generated `index.md`.
- loadPages reads the provider's authoritative page store.
- loadIndex returns generated `index.md` text, or `''` when absent.
- hasPage reports whether a path is present in any store root.

```ts cordis-catalog
/**
 * Persist a resolved page spec. Implemented by the provider.
 * @param projectCwd - absolute project directory of the calling session, when recorded.
 * @param spec - a resolved spec from {@link resolveWrite}.
 * @param nowMs - write clock used for freshness timestamps.
 * @returns the stored page.
 */
abstract persistPage(projectCwd: string | undefined, spec: WikiWriteSpec, nowMs: number): Promise<WikiPage>

/**
 * Update only `touched` on an existing page.
 * @param projectCwd - absolute project directory of the calling session, when recorded.
 * @param path - wiki-relative path.
 * @param nowMs - access clock.
 * @returns the updated page.
 */
abstract persistTouch(projectCwd: string | undefined, path: string, nowMs: number): Promise<WikiPage>

/**
 * Append one JSONL line (`ts`, `session`, `body`) to the day shard for
 * `nowMs`. The service owns all timestamps; specs never carry dates.
 * @param projectCwd - absolute project directory of the calling session, when recorded.
 * @param spec - resolved log spec.
 * @param nowMs - append clock (selects the shard, stamps the line).
 * @returns the shard path that received the append.
 */
abstract persistLog(projectCwd: string | undefined, spec: WikiLogSpec, nowMs: number): Promise<string>

/**
 * Move a page into `archive/`. The original path must no longer be listed.
 * @param projectCwd - absolute project directory of the calling session, when recorded.
 * @param path - active wiki-relative path.
 * @param nowMs - demotion clock.
 */
abstract persistDemote(projectCwd: string | undefined, path: string, nowMs: number): Promise<void>

/**
 * Replace generated `index.md`.
 * @param projectCwd - absolute project directory of the calling session, when recorded.
 * @param markdown - generated projection.
 */
abstract persistIndex(projectCwd: string | undefined, markdown: string): Promise<void>

/**
 * Load pages from the provider's store.
 * @param projectCwd - absolute project directory of the calling session, when recorded.
 * @param includeArchive - when true, include `archive/` pages.
 * @returns the matching pages; empty when the wiki directory does not exist yet.
 */
abstract loadPages(projectCwd: string | undefined, includeArchive: boolean): Promise<WikiPage[]>

/**
 * Load generated `index.md` text.
 * @param projectCwd - absolute project directory of the calling session, when recorded.
 * @returns the file contents, or `''` when the wiki has not been materialized.
 */
abstract loadIndex(projectCwd: string | undefined): Promise<string>

/**
 * Whether the store holds a page at `path`. Synchronous so the invariant
 * companion can check a `wiki/page` event without awaiting a query.
 * @param path - wiki-relative path.
 * @returns whether the page or log shard is present.
 */
abstract hasPage(path: string): boolean

/**
 * Project-level `config.yaml` overlay, when the provider keeps one.
 * @param session - owning session; selects the repository overlay. Optional
 *   callers fall back to the provider's deployment default.
 * @returns the parsed project config, or `{}` when absent.
 */
async projectConfig(session?: Session): Promise<WikiProjectConfig>

/**
 * Engine tunables from the composition entry (not overlaid by the settings
 * document; the session's project `config.yaml` may still overlay them in
 * the provider).
 * @param session - owning session; selects the repository overlay. Optional
 *   callers fall back to the provider's deployment default.
 * @returns the resolved engine config.
 */
async engineConfig(session?: Session): Promise<WikiEngineConfig>

/**
 * Subscribe to status remounts.
 * @param listener - called with the current status immediately and on change.
 * @returns disposer.
 */
watch(listener: (status: WikiStatus) => void): () => void

/**
 * Register an embeddings provider. A later registration replaces the
 * previous one. Dispose removes it so search falls back to BM25.
 * @param provider - embeddings implementation.
 * @returns disposer that unregisters this provider if it is still current.
 */
registerEmbeddings(provider: WikiEmbeddings): () => void

/**
 * Currently registered embeddings provider, if any.
 * @returns the provider, or `undefined`.
 */
embeddingsProvider(): WikiEmbeddings | undefined

/**
 * Bound librarian route from the settings namespace, when both fields are set.
 * @returns the pair, or `undefined` when unbound at the settings layer.
 */
settingsLibrarian(): { provider: string; model: string } | undefined

/**
 * Read one page without bumping `touched`.
 * @param session - owning session; selects the repository wiki.
 * @param path - wiki-relative path.
 * @returns the page, or `undefined` when missing or the wiki is not materialized.
 */
async read(session: Session, path: string): Promise<WikiPage | undefined>

/**
 * List pages, temperature-ranked. Archive is omitted unless requested.
 * @param session - owning session; selects the repository wiki.
 * @param filter - optional filters.
 * @param nowMs - evaluation clock; defaults to `Date.now()`.
 * @returns matching pages HOT first.
 */
async list(session: Session, filter: WikiListFilter = {}, nowMs: number = Date.now()): Promise<WikiPage[]>

/**
 * Search pages. BM25 always runs; cosine mix-in applies when embeddings are
 * registered and available. Default result set excludes archive. HOT ranks
 * above COLD regardless of score.
 * @param session - owning session; selects the repository wiki.
 * @param query - raw query string.
 * @param options - limit and archive inclusion.
 * @param nowMs - evaluation clock.
 * @param signal - optional cancellation around embeddings.
 * @returns ranked hits.
 */
async search( session: Session, query: string, options: WikiSearchOptions = {}, nowMs: number = Date.now(), signal?: AbortSignal, ): Promise<WikiSearchHit[]>

/**
 * Shortlist pages most similar to `path` (embeddings when available, else
 * BM25 against the page title). Used by the librarian for dedup/link
 * proposals. Archive is excluded.
 * @param session - owning session; selects the repository wiki.
 * @param path - wiki-relative path of the seed page.
 * @param limit - maximum hits, default 5.
 * @param nowMs - evaluation clock.
 * @param signal - optional cancellation around embeddings.
 * @returns ranked other pages.
 */
async similar( session: Session, path: string, limit: number = 5, nowMs: number = Date.now(), signal?: AbortSignal, ): Promise<WikiSearchHit[]>

/**
 * Write a page. Resolves the request, persists, logs `wiki/page`, regenerates
 * the index, and mechanically demotes COLD-past-`demoteDays` pages.
 * @param session - owning session; the page event is appended to its log.
 * @param request - the caller's write request.
 * @param nowMs - write clock.
 * @returns the write outcome.
 */
async writePage( session: Session, request: WikiWriteRequest, nowMs: number = Date.now(), ): Promise<WikiWriteResult>

/**
 * Append to the day-sharded log and write `wiki/page` with `op: 'log'`.
 * @param session - owning session.
 * @param request - the caller's log request.
 * @param nowMs - append clock.
 * @returns the append outcome.
 */
async appendLog( session: Session, request: WikiLogRequest, nowMs: number = Date.now(), ): Promise<WikiLogResult>

/**
 * Bump `touched` on a page (the read-path access recorder) and log
 * `wiki/page` with `op: 'touch'`. Missing pages fail with `not-found`.
 * @param session - owning session.
 * @param path - wiki-relative path.
 * @param nowMs - access clock.
 * @returns the updated page, or a failed result.
 */
async touch( session: Session, path: string, nowMs: number = Date.now(), ): Promise<WikiWriteResult>

/**
 * Mechanically lint every page plus the generated index.
 * @param session - owning session; selects the repository wiki.
 * @returns the issue list.
 */
async lint(session: Session): Promise<WikiLintIssue[]>

/**
 * Rebuild `index.md` and demote COLD-past-`demoteDays` pages into `archive/`.
 * Records a `wiki/page` archive event per demoted page when `session` is given.
 * @param session - optional session to log archive events on.
 * @param nowMs - evaluation clock.
 */
async reindex(session?: Session, nowMs: number = Date.now()): Promise<void>

/**
 * Fill freshness fields for a newly persisted page. Providers call this
 * when the stored page had no frontmatter yet.
 * @param nowIso - ISO-8601 instant.
 * @param existing - previous frontmatter, when updating.
 * @param archived - whether the destination is under `archive/`.
 * @returns complete frontmatter.
 */
freshness(nowIso: string, existing: WikiFrontmatter | undefined, archived: boolean): WikiFrontmatter
```

Types: [Session](session.md)

Source: [`packages/wiki/wiki/src/index.ts:143`](../../packages/wiki/wiki/src/index.ts)
<!-- END GENERATED cordis-surface -->
