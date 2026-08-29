/**
 * Pure types of the wiki capability seam (`ctx.wiki`): page frontmatter,
 * temperature ranks, write request/spec, search hits, lint issues, and the
 * log-only `wiki/page` session event. Free of host-side runtime imports.
 *
 * @module @shres-code/shres-code-wiki/types
 */

/** Temperature rank computed from `touched` age. Never stored; always derived. */
export type WikiTemperature = 'HOT' | 'WARM' | 'COLD'

/** Durable page status. `archived` pages leave the default search set. */
export type WikiPageStatus = 'active' | 'archived'

/** Wiki write operation recorded on the log-only `wiki/page` event. */
export type WikiPageOp = 'create' | 'update' | 'archive' | 'touch' | 'log'

/**
 * Frontmatter every knowledge page carries. `created`/`updated`/`touched` are
 * ISO-8601 instants; missing freshness fields are lint issues, not parse failures.
 */
export interface WikiFrontmatter {
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

/** One parsed wiki page as the service and tools see it. */
export interface WikiPage {
  /** Wiki-relative path, posix separators, `.md` suffix (for example `notes.md`). */
  readonly path: string
  /** Title from the first markdown heading, else the stem of `path`. */
  readonly title: string
  /** Markdown body after the frontmatter fence. */
  readonly body: string
  /** Parsed frontmatter. */
  readonly frontmatter: WikiFrontmatter
}

/** Caller's page write REQUEST. `path` and `body` are required. */
export interface WikiWriteRequest {
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

/**
 * Fully resolved page write spec. Handed to providers by {@link resolveWrite};
 * persist paths never re-default.
 */
export interface WikiWriteSpec {
  readonly path: string
  readonly title: string
  readonly body: string
  readonly tags: readonly string[]
  readonly contradicts: readonly string[]
  readonly superseded_by?: string
}

/** Caller's log-append REQUEST. */
export interface WikiLogRequest {
  /** Markdown to append to today's shard. */
  readonly body: string
}

/** Resolved log-append spec. */
export interface WikiLogSpec {
  readonly body: string
}

/** Filters for {@link WikiService.list}. Absent fields are not applied. */
export interface WikiListFilter {
  /** Restrict to one temperature rank. */
  readonly temperature?: WikiTemperature
  /** When true, include `archive/` pages. Default false. */
  readonly includeArchive?: boolean
  /** Match pages whose title or path contains this substring. */
  readonly substring?: string
}

/** Options for {@link WikiService.search}. */
export interface WikiSearchOptions {
  /** Maximum hits to return. */
  readonly limit?: number
  /** When true, include `archive/` pages. Default false. */
  readonly includeArchive?: boolean
}

/** One ranked search hit. */
export interface WikiSearchHit {
  readonly path: string
  readonly title: string
  readonly temperature: WikiTemperature
  /** Combined ranking score (BM25 and optional cosine). Higher is better. */
  readonly score: number
  /** Short excerpt around the first query match, when one exists. */
  readonly excerpt: string
}

/** Mechanical lint issue. Zero LLM tokens. */
export type WikiLintCode =
  | 'missing-created'
  | 'missing-updated'
  | 'missing-touched'
  | 'dead-link'
  | 'orphan'
  | 'index-missing'
  | 'index-stale'
  | 'archived-in-index'

/** One lint finding. */
export interface WikiLintIssue {
  readonly code: WikiLintCode
  readonly path: string
  /** Extra path for `dead-link` (the missing target) or `index-stale`. */
  readonly target?: string
  readonly detail: string
}

/** Why a wiki write or read did not land. */
export type WikiFailureReason =
  | 'required-field'
  | 'invalid-path'
  | 'disabled'
  | 'not-found'
  | 'not-materialized'

/** Outcome of a page write. */
export type WikiWriteResult =
  | { readonly kind: 'written'; readonly page: WikiPage }
  | { readonly kind: 'failed'; readonly reason: WikiFailureReason; readonly detail: string }

/** Outcome of a log append. */
export type WikiLogResult =
  | { readonly kind: 'appended'; readonly path: string }
  | { readonly kind: 'failed'; readonly reason: WikiFailureReason; readonly detail: string }

/** Durable payload of the log-only `wiki/page` event. */
export interface WikiPageEvent {
  /** Wiki-relative path that was written, touched, archived, or appended. */
  readonly path: string
  /** The operation that produced this event. */
  readonly op: WikiPageOp
}

/** Auxiliary wiki librarian purpose stamped on `GenerateOptions.purpose`. */
export type WikiLibrarianPurpose = 'wiki-summarize' | 'wiki-extract'

/** Durable payload of the log-only `wiki/librarian-request` event. */
export interface WikiLibrarianRequestEvent {
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

/** Stored provider/model pair for one wiki role. Omitted fields leave the role unbound. */
export interface WikiRoleBinding {
  /** Live `ctx.llm` route id. */
  readonly provider?: string
  /** Provider-owned model id on that route. */
  readonly model?: string
}

/** User and composition document for the `wiki` settings section. */
export interface WikiSettings {
  /** Master allow. Default true. Off unloads tools and refuses dispatch. */
  readonly enabled?: boolean
  /** Per-role bindings; an omitted or empty librarian stays dormant. */
  readonly roles?: {
    readonly librarian?: WikiRoleBinding
  }
}

/** Seat status consumers remount from. */
export interface WikiStatus {
  /** Whether tools and librarian dispatch should run. */
  readonly active: boolean
  /** Why the seat is active or not. */
  readonly reason: 'active' | 'disabled'
}

/** Optional in-process embeddings provider registered on `ctx.wiki`. */
export interface WikiEmbeddings {
  /** Cheap usability check; must not load weights. */
  available(): boolean
  /**
   * Embed one or more texts.
   * @param texts - non-empty strings to embed.
   * @param signal - optional cancellation around load and inference.
   * @returns one vector per input text, same length and order.
   */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]>
}

/** Project-level wiki settings stored beside the pages as `config.yaml`. */
export interface WikiProjectConfig {
  readonly enabled?: boolean
  readonly hotDays?: number
  readonly warmDays?: number
  readonly demoteDays?: number
  readonly roles?: {
    readonly librarian?: WikiRoleBinding
  }
}

declare module '@shres-code/shres-code-session/types' {
  interface SessionEventMap {
    /**
     * One wiki page write, touch, archive, or log append through `ctx.wiki`.
     * Log-only. Writers pass `{ ignorable: true }`.
     * @param path - wiki-relative path that was written.
     * @param op - the operation that produced this event.
     */
    'wiki/page': WikiPageEvent
    /**
     * Pre-dispatch record of one wiki librarian auxiliary model request.
     * Log-only. Writers pass `{ ignorable: true }`.
     * @param purpose - why this auxiliary call ran.
     * @param route - exact provider and model used for the call.
     * @param system - exact auxiliary system prompt.
     * @param prompt - exact auxiliary user prompt.
     * @param maxTokens - exact auxiliary output-token cap.
     */
    'wiki/librarian-request': WikiLibrarianRequestEvent
  }
}
