/**
 * Request resolution for the wiki capability seam: the pure
 * `resolveWrite` / `resolveLog` / `resolveEngine` steps that own all
 * defaulting and validation. Providers and `run()` paths never re-default.
 *
 * @module @shres-code/shres-code-wiki/resolve
 */

import type {
  WikiFailureReason,
  WikiLogRequest,
  WikiLogSpec,
  WikiRoleBinding,
  WikiWriteRequest,
  WikiWriteSpec,
} from './types.ts'

/** Milliseconds in one day. Protocol constant used by the temperature fold. */
export const WIKI_DAY_MS = 86_400_000

/** Engine tunables the temperature/demotion fold reads. */
export interface WikiEngineConfig {
  /** Age in days at or below which a page is HOT. */
  readonly hotDays: number
  /** Age in days at or below which a page is WARM (must be ≥ `hotDays`). */
  readonly warmDays: number
  /** Age in days beyond which a COLD page leaves the default set (must be ≥ `warmDays`). */
  readonly demoteDays: number
  /** Maximum lines the generated `index.md` may occupy. */
  readonly indexMaxLines: number
}

/** Typed error with a stable, machine-routable `code`. */
export class WikiError extends Error {
  /**
   * @param message - human-readable reason.
   * @param code - stable machine code.
   */
  constructor(
    message: string,
    readonly code: WikiFailureReason,
  ) {
    super(message)
    this.name = 'WikiError'
  }
}

const PATH_PATTERN = /^(?!\.\/)(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]*\.md$/

/**
 * Whether `path` is a legal wiki-relative markdown path.
 * @param path - candidate path.
 * @returns true when the path is posix-relative, `.md`-suffixed, and has no `..`.
 */
export function isWikiPath(path: string): boolean {
  if (path === 'index.md' || path === 'config.yaml') return false
  if (path.startsWith('log/')) return false
  return PATH_PATTERN.test(path)
}

/**
 * Derive a title from a markdown body or, failing that, the path stem.
 * @param body - markdown body.
 * @param path - wiki-relative path used as the fallback.
 * @returns a non-empty title.
 */
export function titleFrom(body: string, path: string): string {
  const heading = body.match(/^#\s+(.+)$/m)
  const fromHeading = heading?.[1]?.trim()
  if (fromHeading !== undefined && fromHeading.length > 0) return fromHeading
  const slash = path.lastIndexOf('/')
  const file = slash < 0 ? path : path.slice(slash + 1)
  /* v8 ignore next -- isWikiPath already requires a .md suffix */
  return file.endsWith('.md') ? file.slice(0, -3) : file
}

/**
 * Resolve a page write request into a fully-specified spec.
 * @param request - the caller's write request.
 * @returns the spec, safe to hand to a provider.
 * @throws {@link WikiError} naming the first violated rule.
 */
export function resolveWrite(request: WikiWriteRequest): WikiWriteSpec {
  if (typeof request.path !== 'string' || request.path.trim().length === 0) {
    throw new WikiError('wiki write requires a non-empty path', 'required-field')
  }
  if (!isWikiPath(request.path)) {
    throw new WikiError(`wiki write path is not a legal wiki-relative markdown path: ${request.path}`, 'invalid-path')
  }
  if (typeof request.body !== 'string') {
    throw new WikiError('wiki write requires a body string', 'required-field')
  }
  const title = request.title === undefined ? titleFrom(request.body, request.path) : request.title.trim()
  if (title.length === 0) {
    throw new WikiError('wiki write requires a non-empty title', 'required-field')
  }
  return {
    path: request.path,
    title,
    body: request.body,
    tags: request.tags ?? [],
    contradicts: request.contradicts ?? [],
    ...request.superseded_by === undefined ? {} : { superseded_by: request.superseded_by },
  }
}

/**
 * Resolve a log-append request.
 * @param request - the caller's log request.
 * @returns the spec.
 * @throws {@link WikiError} when `body` is missing or blank.
 */
export function resolveLog(request: WikiLogRequest): WikiLogSpec {
  if (typeof request.body !== 'string' || request.body.trim().length === 0) {
    throw new WikiError('wiki log requires a non-empty body', 'required-field')
  }
  return { body: request.body }
}

/**
 * Validate engine tunables. `warmDays` must be ≥ `hotDays` and `demoteDays` ≥ `warmDays`.
 * @param config - candidate tunables.
 * @returns the same values once proven legal.
 * @throws when a value is not a positive integer or the ordering is inverted.
 */
export function resolveEngine(config: WikiEngineConfig): WikiEngineConfig {
  assertPositiveInteger('hotDays', config.hotDays)
  assertPositiveInteger('warmDays', config.warmDays)
  assertPositiveInteger('demoteDays', config.demoteDays)
  assertPositiveInteger('indexMaxLines', config.indexMaxLines)
  if (config.warmDays < config.hotDays) {
    throw new Error('wiki: warmDays must be greater than or equal to hotDays')
  }
  if (config.demoteDays < config.warmDays) {
    throw new Error('wiki: demoteDays must be greater than or equal to warmDays')
  }
  return config
}

/**
 * Whether a role binding names both a provider and a model.
 * @param binding - stored pair.
 * @returns the trimmed pair, or `undefined` when unbound.
 */
export function boundRole(binding: WikiRoleBinding | undefined): { provider: string; model: string } | undefined {
  const provider = binding?.provider?.trim()
  const model = binding?.model?.trim()
  if (provider === undefined || provider.length === 0) return undefined
  if (model === undefined || model.length === 0) return undefined
  return { provider, model }
}

/**
 * Fail when exactly one of `provider`/`model` is a non-empty string.
 * @param binding - stored pair.
 * @throws when the pair is half-specified.
 */
export function assertRolePair(binding: WikiRoleBinding | undefined): void {
  const provider = binding?.provider?.trim()
  const model = binding?.model?.trim()
  const hasProvider = provider !== undefined && provider.length > 0
  const hasModel = model !== undefined && model.length > 0
  if (hasProvider !== hasModel) {
    throw new Error('wiki: roles.librarian.provider and model must be supplied together')
  }
}

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`wiki: ${field} must be a positive integer`)
  }
}
