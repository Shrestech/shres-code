/**
 * Service Definition for the wiki capability seam (`ctx.wiki`): the
 * read/list/search/write/log/lint/reindex contract, the temperature and
 * demotion folds, the request/spec split, and the log-only `wiki/page`
 * session event. Providers subclass {@link WikiService} and implement the
 * persistence hooks; the seam's concrete methods own defaulting, ranking,
 * lint, event logging, and embeddings mix-in.
 *
 * @module @shres-code/shres-code-wiki
 */

import { Context, Service } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { installSettingsSection, settingsNamespace } from '@shres-code/shres-code-settings'
import type { Session } from '@shres-code/shres-code-session'
import {
  archivePathOf,
  bm25Scores,
  combinedScore,
  cosineSimilarity,
  excerptOf,
  generateIndex,
  isArchivedPath,
  lintPages,
  rankHits,
  shouldDemote,
  temperatureOf,
} from './engine.ts'
import { assertRolePair, boundRole, resolveEngine, resolveLog, resolveWrite, WikiError } from './resolve.ts'
import type { WikiEngineConfig } from './resolve.ts'
import type {
  WikiEmbeddings,
  WikiFrontmatter,
  WikiLintIssue,
  WikiListFilter,
  WikiLogRequest,
  WikiLogResult,
  WikiLogSpec,
  WikiPage,
  WikiProjectConfig,
  WikiRoleBinding,
  WikiSearchHit,
  WikiSearchOptions,
  WikiSettings,
  WikiStatus,
  WikiWriteRequest,
  WikiWriteResult,
  WikiWriteSpec,
} from './types.ts'

export {
  archivePathOf,
  ageDays,
  bm25Scores,
  combinedScore,
  cosineSimilarity,
  excerptOf,
  generateIndex,
  indexListedPaths,
  isArchivedPath,
  lintPages,
  logPathOf,
  outboundLinks,
  rankHits,
  shouldDemote,
  temperatureOf,
  tokenize,
  utcDateStamp,
} from './engine.ts'
export {
  assertRolePair,
  boundRole,
  isWikiPath,
  resolveEngine,
  resolveLog,
  resolveWrite,
  titleFrom,
  WikiError,
  WIKI_DAY_MS,
} from './resolve.ts'
export type { WikiEngineConfig } from './resolve.ts'
export type * from './types.ts'

/** Settings namespace the J-Space Settings page and librarian seat write. */
export const WIKI_SETTINGS_NAMESPACE = settingsNamespace('wiki')

/** Host-seat and engine config. */
export interface Config extends WikiSettings {
  /** Age in days at or below which a page is HOT. */
  hotDays?: number
  /** Age in days at or below which a page is WARM. */
  warmDays?: number
  /** Age in days beyond which a COLD page is demoted to `archive/`. */
  demoteDays?: number
  /** Maximum lines the generated `index.md` may occupy. */
  indexMaxLines?: number
}

const roleBinding: z<WikiRoleBinding> = z.object({
  provider: z.string(),
  model: z.string(),
})

/** Loader-validated plugin config. Enabled defaults on; roles start unbound. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  hotDays: z.number().step(1).min(1).default(7),
  warmDays: z.number().step(1).min(1).default(30),
  demoteDays: z.number().step(1).min(1).default(90),
  indexMaxLines: z.number().step(1).min(8).default(200),
  roles: z.object({
    librarian: roleBinding,
  }),
})

declare module '@shres-code/cordis' {
  interface Context {
    wiki: WikiService
  }
}

/**
 * The abstract wiki service. Registered as `ctx.wiki` (one provider per
 * context). A provider subclasses this, implements the persistence hooks, and
 * loads the subclass as a plugin.
 *
 * Implementations must honor these semantics:
 * - {@link persistPage} writes a resolved spec under its path, creating
 *   directories on first write (lazy materialization).
 * - {@link persistTouch} updates only `touched` on an existing page.
 * - {@link persistLog} appends to the day-sharded log.
 * - {@link persistDemote} moves a COLD-past-`demoteDays` page into `archive/`.
 * - {@link persistIndex} replaces generated `index.md`.
 * - {@link loadPages} reads the provider's authoritative page store.
 * - {@link loadIndex} returns generated `index.md` text, or `''` when absent.
 * - {@link hasPage} reports whether a path is present.
 */
export abstract class WikiService extends Service {
  static Config = Config

  private readonly entry: Config
  private override: (() => WikiSettings) | undefined
  private current: WikiStatus = { active: true, reason: 'active' }
  private readonly listeners = new Set<(status: WikiStatus) => void>()
  private embeddings: WikiEmbeddings | undefined
  private readonly engine: WikiEngineConfig

  /**
   * @param ctx - Cordis context.
   * @param entry - composition entry; settings overlay `enabled` and `roles`.
   */
  constructor(ctx: Context, entry: Config = {}) {
    super(ctx, 'wiki')
    this.entry = entry
    assertRolePair(entry.roles?.librarian)
    this.engine = resolveEngine({
      hotDays: entry.hotDays ?? 7,
      warmDays: entry.warmDays ?? 30,
      demoteDays: entry.demoteDays ?? 90,
      indexMaxLines: entry.indexMaxLines ?? 200,
    })
    installSettingsSection(ctx, WIKI_SETTINGS_NAMESPACE, Config, Object.assign({}, entry), {
      setSource: (current) => { this.override = current },
      onChange: () => { this.sync() },
    })
    this.sync()
  }

  /**
   * Persist a resolved page spec. Implemented by the provider.
   * @param spec - a resolved spec from {@link resolveWrite}.
   * @param nowMs - write clock used for freshness timestamps.
   * @returns the stored page.
   */
  abstract persistPage(spec: WikiWriteSpec, nowMs: number): Promise<WikiPage>

  /**
   * Update only `touched` on an existing page.
   * @param path - wiki-relative path.
   * @param nowMs - access clock.
   * @returns the updated page.
   */
  abstract persistTouch(path: string, nowMs: number): Promise<WikiPage>

  /**
   * Append a resolved log body to the day shard for `nowMs`.
   * @param spec - resolved log spec.
   * @param nowMs - append clock (selects the shard).
   * @returns the shard path that received the append.
   */
  abstract persistLog(spec: WikiLogSpec, nowMs: number): Promise<string>

  /**
   * Move a page into `archive/`. The original path must no longer be listed.
   * @param path - active wiki-relative path.
   * @param nowMs - demotion clock.
   */
  abstract persistDemote(path: string, nowMs: number): Promise<void>

  /**
   * Replace generated `index.md`.
   * @param markdown - generated projection.
   */
  abstract persistIndex(markdown: string): Promise<void>

  /**
   * Load pages from the provider's store.
   * @param includeArchive - when true, include `archive/` pages.
   * @returns the matching pages; empty when the wiki directory does not exist yet.
   */
  abstract loadPages(includeArchive: boolean): Promise<WikiPage[]>

  /**
   * Load generated `index.md` text.
   * @returns the file contents, or `''` when the wiki has not been materialized.
   */
  abstract loadIndex(): Promise<string>

  /**
   * Whether the store holds a page at `path`. Synchronous so the invariant
   * companion can check a `wiki/page` event without awaiting a query.
   * @param path - wiki-relative path.
   * @returns whether the page or log shard is present.
   */
  abstract hasPage(path: string): boolean

  /**
   * Project-level `config.yaml` overlay, when the provider keeps one.
   * @returns the parsed project config, or `{}` when absent.
   */
  projectConfig(): WikiProjectConfig {
    return {}
  }

  /**
   * Current seat status.
   * @returns whether consumers should be mounted.
   */
  get status(): WikiStatus {
    return this.current
  }

  /**
   * Resolved seat document (settings overlaying the composition entry).
   * @returns the current settings-or-entry document.
   */
  get settings(): WikiSettings {
    return this.override === undefined ? this.entry : this.override()
  }

  /**
   * Engine tunables from the composition entry (not overlaid by the settings
   * document; project `config.yaml` may still overlay them in the provider).
   * @returns the resolved engine config.
   */
  get engineConfig(): WikiEngineConfig {
    const project = this.projectConfig()
    return resolveEngine({
      hotDays: project.hotDays ?? this.engine.hotDays,
      warmDays: project.warmDays ?? this.engine.warmDays,
      demoteDays: project.demoteDays ?? this.engine.demoteDays,
      indexMaxLines: this.engine.indexMaxLines,
    })
  }

  /**
   * Subscribe to status remounts.
   * @param listener - called with the current status immediately and on change.
   * @returns disposer.
   */
  watch(listener: (status: WikiStatus) => void): () => void {
    this.listeners.add(listener)
    listener(this.current)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Register an embeddings provider. A later registration replaces the
   * previous one. Dispose removes it so search falls back to BM25.
   * @param provider - embeddings implementation.
   * @returns disposer that unregisters this provider if it is still current.
   */
  registerEmbeddings(provider: WikiEmbeddings): () => void {
    this.embeddings = provider
    return () => {
      if (this.embeddings === provider) this.embeddings = undefined
    }
  }

  /**
   * Currently registered embeddings provider, if any.
   * @returns the provider, or `undefined`.
   */
  embeddingsProvider(): WikiEmbeddings | undefined {
    return this.embeddings
  }

  /**
   * Bound librarian route from the settings namespace, when both fields are set.
   * @returns the pair, or `undefined` when unbound at the settings layer.
   */
  settingsLibrarian(): { provider: string; model: string } | undefined {
    if (this.settings.enabled === false) return undefined
    return boundRole(this.settings.roles?.librarian)
  }

  /**
   * Read one page without bumping `touched`.
   * @param path - wiki-relative path.
   * @returns the page, or `undefined` when missing or the wiki is not materialized.
   */
  async read(path: string): Promise<WikiPage | undefined> {
    const pages = await this.loadPages(true)
    return pages.find(page => page.path === path)
  }

  /**
   * List pages, temperature-ranked. Archive is omitted unless requested.
   * @param filter - optional filters.
   * @param nowMs - evaluation clock; defaults to `Date.now()`.
   * @returns matching pages HOT first.
   */
  async list(filter: WikiListFilter = {}, nowMs: number = Date.now()): Promise<WikiPage[]> {
    const pages = await this.loadPages(filter.includeArchive === true)
    const engine = this.engineConfig
    const substring = filter.substring?.toLowerCase()
    const filtered = pages.filter((page) => {
      if (filter.includeArchive !== true && (isArchivedPath(page.path) || page.frontmatter.status === 'archived')) {
        return false
      }
      if (filter.temperature !== undefined
        && temperatureOf(page.frontmatter.touched, nowMs, engine) !== filter.temperature) {
        return false
      }
      if (substring !== undefined) {
        const haystack = `${page.title} ${page.path}`.toLowerCase()
        if (!haystack.includes(substring)) return false
      }
      return true
    })
    return filtered.sort((left, right) => {
      const rank = rankOf(left, nowMs, engine) - rankOf(right, nowMs, engine)
      if (rank !== 0) return rank
      return left.path.localeCompare(right.path)
    })
  }

  /**
   * Search pages. BM25 always runs; cosine mix-in applies when embeddings are
   * registered and available. Default result set excludes archive. HOT ranks
   * above COLD regardless of score.
   * @param query - raw query string.
   * @param options - limit and archive inclusion.
   * @param nowMs - evaluation clock.
   * @param signal - optional cancellation around embeddings.
   * @returns ranked hits.
   */
  async search(
    query: string,
    options: WikiSearchOptions = {},
    nowMs: number = Date.now(),
    signal?: AbortSignal,
  ): Promise<WikiSearchHit[]> {
    const pages = (await this.loadPages(options.includeArchive === true))
      .filter(page => options.includeArchive === true
        || (!isArchivedPath(page.path) && page.frontmatter.status !== 'archived'))
    const engine = this.engineConfig
    const lexical = bm25Scores(pages, query)
    let cosine: Map<string, number> | undefined
    const embeddings = this.embeddings
    if (embeddings !== undefined && embeddings.available() && query.trim().length > 0 && pages.length > 0) {
      const vectors = await embeddings.embed(
        [query, ...pages.map(page => `${page.title}\n${page.body}`)],
        signal,
      )
      const queryVector = vectors[0]
      if (queryVector !== undefined) {
        cosine = new Map()
        for (let index = 0; index < pages.length; index += 1) {
          const page = pages[index]
          const vector = vectors[index + 1]
          /* v8 ignore next -- pages and vectors are indexed in lockstep */
          if (page === undefined || vector === undefined) continue
          cosine.set(page.path, cosineSimilarity(queryVector, vector))
        }
      }
    }
    const hits: WikiSearchHit[] = []
    for (const page of pages) {
      const bm25 = lexical.get(page.path) ?? 0
      const semantic = cosine?.get(page.path)
      const score = combinedScore(bm25, semantic)
      if (score <= 0 && query.trim().length > 0) continue
      hits.push({
        path: page.path,
        title: page.title,
        temperature: temperatureOf(page.frontmatter.touched, nowMs, engine),
        score,
        excerpt: excerptOf(page.body, query),
      })
    }
    const ranked = rankHits(hits)
    const limit = options.limit
    return limit === undefined ? ranked : ranked.slice(0, limit)
  }

  /**
   * Shortlist pages most similar to `path` (embeddings when available, else
   * BM25 against the page title). Used by the librarian for dedup/link
   * proposals. Archive is excluded.
   * @param path - wiki-relative path of the seed page.
   * @param limit - maximum hits, default 5.
   * @param nowMs - evaluation clock.
   * @param signal - optional cancellation around embeddings.
   * @returns ranked other pages.
   */
  async similar(
    path: string,
    limit: number = 5,
    nowMs: number = Date.now(),
    signal?: AbortSignal,
  ): Promise<WikiSearchHit[]> {
    const seed = await this.read(path)
    if (seed === undefined) return []
    const hits = await this.search(`${seed.title} ${seed.body}`, { limit: limit + 1 }, nowMs, signal)
    return hits.filter(hit => hit.path !== path).slice(0, limit)
  }

  /**
   * Write a page. Resolves the request, persists, logs `wiki/page`, regenerates
   * the index, and mechanically demotes COLD-past-`demoteDays` pages.
   * @param session - owning session; the page event is appended to its log.
   * @param request - the caller's write request.
   * @param nowMs - write clock.
   * @returns the write outcome.
   */
  async writePage(
    session: Session,
    request: WikiWriteRequest,
    nowMs: number = Date.now(),
  ): Promise<WikiWriteResult> {
    if (!this.current.active) {
      return { kind: 'failed', reason: 'disabled', detail: 'wiki is disabled' }
    }
    let spec: WikiWriteSpec
    try {
      spec = resolveWrite(request)
    } catch (error) {
      if (error instanceof WikiError) {
        return { kind: 'failed', reason: error.code, detail: error.message }
      }
      throw error
    }
    const existing = await this.read(spec.path)
    const page = await this.persistPage(spec, nowMs)
    session.append('wiki/page', {
      path: page.path,
      op: existing === undefined ? 'create' : 'update',
    }, { ignorable: true })
    await this.maintain(nowMs)
    return { kind: 'written', page }
  }

  /**
   * Append to the day-sharded log and write `wiki/page` with `op: 'log'`.
   * @param session - owning session.
   * @param request - the caller's log request.
   * @param nowMs - append clock.
   * @returns the append outcome.
   */
  async appendLog(
    session: Session,
    request: WikiLogRequest,
    nowMs: number = Date.now(),
  ): Promise<WikiLogResult> {
    if (!this.current.active) {
      return { kind: 'failed', reason: 'disabled', detail: 'wiki is disabled' }
    }
    let spec: WikiLogSpec
    try {
      spec = resolveLog(request)
    } catch (error) {
      /* v8 ignore start -- resolveLog only throws WikiError */
      if (!(error instanceof WikiError)) throw error
      /* v8 ignore stop */
      return { kind: 'failed', reason: error.code, detail: error.message }
    }
    const path = await this.persistLog(spec, nowMs)
    session.append('wiki/page', { path, op: 'log' }, { ignorable: true })
    return { kind: 'appended', path }
  }

  /**
   * Bump `touched` on a page (the read-path access recorder) and log
   * `wiki/page` with `op: 'touch'`. Missing pages fail with `not-found`.
   * @param session - owning session.
   * @param path - wiki-relative path.
   * @param nowMs - access clock.
   * @returns the updated page, or a failed result.
   */
  async touch(
    session: Session,
    path: string,
    nowMs: number = Date.now(),
  ): Promise<WikiWriteResult> {
    if (!this.current.active) {
      return { kind: 'failed', reason: 'disabled', detail: 'wiki is disabled' }
    }
    const existing = await this.read(path)
    if (existing === undefined) {
      return { kind: 'failed', reason: 'not-found', detail: `wiki page not found: ${path}` }
    }
    const page = await this.persistTouch(path, nowMs)
    session.append('wiki/page', { path: page.path, op: 'touch' }, { ignorable: true })
    return { kind: 'written', page }
  }

  /**
   * Mechanically lint every page plus the generated index.
   * @returns the issue list.
   */
  async lint(): Promise<WikiLintIssue[]> {
    const pages = await this.loadPages(true)
    const index = await this.loadIndex()
    return lintPages(pages, index)
  }

  /**
   * Rebuild `index.md` and demote COLD-past-`demoteDays` pages into `archive/`.
   * Records a `wiki/page` archive event per demoted page when `session` is given.
   * @param session - optional session to log archive events on.
   * @param nowMs - evaluation clock.
   */
  async reindex(session?: Session, nowMs: number = Date.now()): Promise<void> {
    await this.maintain(nowMs, session)
  }

  /**
   * Fill freshness fields for a newly persisted page. Providers call this
   * when the stored page had no frontmatter yet.
   * @param nowIso - ISO-8601 instant.
   * @param existing - previous frontmatter, when updating.
   * @param archived - whether the destination is under `archive/`.
   * @returns complete frontmatter.
   */
  freshness(nowIso: string, existing: WikiFrontmatter | undefined, archived: boolean): WikiFrontmatter {
    return {
      created: existing?.created ?? nowIso,
      updated: nowIso,
      touched: nowIso,
      status: archived ? 'archived' : 'active',
      ...existing?.superseded_by === undefined ? {} : { superseded_by: existing.superseded_by },
      ...existing?.contradicts === undefined ? {} : { contradicts: existing.contradicts },
      ...existing?.tags === undefined ? {} : { tags: existing.tags },
    }
  }

  private async maintain(nowMs: number, session?: Session): Promise<void> {
    const engine = this.engineConfig
    const pages = await this.loadPages(true)
    for (const page of pages) {
      if (isArchivedPath(page.path) || page.frontmatter.status === 'archived') continue
      if (!shouldDemote(page.frontmatter.touched, nowMs, engine)) continue
      await this.persistDemote(page.path, nowMs)
      session?.append('wiki/page', { path: archivePathOf(page.path), op: 'archive' }, { ignorable: true })
    }
    const next = await this.loadPages(true)
    await this.persistIndex(generateIndex(next, nowMs, engine))
  }

  private sync(): void {
    const enabled = this.settings.enabled !== false
    this.current = enabled
      ? { active: true, reason: 'active' }
      : { active: false, reason: 'disabled' }
    for (const listener of this.listeners) listener(this.current)
  }
}

function rankOf(page: WikiPage, nowMs: number, engine: WikiEngineConfig): number {
  const temperature = temperatureOf(page.frontmatter.touched, nowMs, engine)
  return temperature === 'HOT' ? 0 : temperature === 'WARM' ? 1 : 2
}

export default WikiService
