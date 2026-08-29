/**
 * Pure temperature, demotion, BM25, lint, and index-projection folds for the
 * wiki seam. Zero LLM tokens. Projection-fold style: given pages and a clock,
 * the result is determined.
 *
 * @module @shres-code/shres-code-wiki/engine
 */

import { WIKI_DAY_MS, type WikiEngineConfig } from './resolve.ts'
import type {
  WikiLintIssue,
  WikiPage,
  WikiSearchHit,
  WikiTemperature,
} from './types.ts'

/** BM25 term-frequency saturation. Algorithm constant, not a deployment tunable. */
const BM25_K1 = 1.5
/** BM25 length normalization. Algorithm constant, not a deployment tunable. */
const BM25_B = 0.75
/** Cosine weight when embeddings are present. */
const SEMANTIC_WEIGHT = 0.7

/**
 * Age of `touched` in whole days relative to `nowMs`.
 * @param touchedIso - ISO-8601 instant from frontmatter.
 * @param nowMs - evaluation clock.
 * @returns non-negative whole days; unparseable timestamps count as infinitely old.
 */
export function ageDays(touchedIso: string, nowMs: number): number {
  const touched = Date.parse(touchedIso)
  if (!Number.isFinite(touched)) return Number.POSITIVE_INFINITY
  return Math.max(0, (nowMs - touched) / WIKI_DAY_MS)
}

/**
 * Compute the temperature rank of a page.
 * @param touchedIso - ISO-8601 `touched` instant.
 * @param nowMs - evaluation clock.
 * @param config - hot/warm thresholds.
 * @returns HOT, WARM, or COLD.
 */
export function temperatureOf(
  touchedIso: string,
  nowMs: number,
  config: WikiEngineConfig,
): WikiTemperature {
  const days = ageDays(touchedIso, nowMs)
  if (days <= config.hotDays) return 'HOT'
  if (days <= config.warmDays) return 'WARM'
  return 'COLD'
}

/**
 * Whether a COLD page has aged past `demoteDays` and must leave the default set.
 * @param touchedIso - ISO-8601 `touched` instant.
 * @param nowMs - evaluation clock.
 * @param config - demotion threshold.
 * @returns true when the page should move to `archive/`.
 */
export function shouldDemote(
  touchedIso: string,
  nowMs: number,
  config: WikiEngineConfig,
): boolean {
  return ageDays(touchedIso, nowMs) > config.demoteDays
}

/**
 * Whether a wiki-relative path lives under `archive/`.
 * @param path - wiki-relative path.
 * @returns true for archived paths.
 */
export function isArchivedPath(path: string): boolean {
  return path.startsWith('archive/')
}

/**
 * Archive destination for an active path.
 * @param path - wiki-relative path not already under `archive/`.
 * @returns `archive/<path>`.
 */
export function archivePathOf(path: string): string {
  return isArchivedPath(path) ? path : `archive/${path}`
}

const TEMPERATURE_RANK: Record<WikiTemperature, number> = { HOT: 0, WARM: 1, COLD: 2 }

/**
 * Sort hits so HOT outranks WARM outranks COLD, then by descending score.
 * @param hits - scored hits.
 * @returns a new sorted array.
 */
export function rankHits(hits: readonly WikiSearchHit[]): WikiSearchHit[] {
  return [...hits].sort((left, right) => {
    const rank = TEMPERATURE_RANK[left.temperature] - TEMPERATURE_RANK[right.temperature]
    if (rank !== 0) return rank
    return right.score - left.score
  })
}

/**
 * Tokenize text for BM25: lowercase runs of letters and digits.
 * @param text - source text.
 * @returns tokens.
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/u).filter(token => token.length > 0)
}

/**
 * Score pages with BM25 against a query.
 * @param pages - candidate pages.
 * @param query - raw query string.
 * @returns path → BM25 score; missing keys scored 0.
 */
export function bm25Scores(pages: readonly WikiPage[], query: string): Map<string, number> {
  const queryTokens = tokenize(query)
  const scores = new Map<string, number>()
  if (queryTokens.length === 0 || pages.length === 0) return scores
  const documents = pages.map(page => tokenize(`${page.title} ${page.body}`))
  const avgLength = documents.reduce((sum, tokens) => sum + tokens.length, 0) / documents.length
  const df = new Map<string, number>()
  for (const tokens of documents) {
    for (const token of new Set(tokens)) {
      df.set(token, (df.get(token) ?? 0) + 1)
    }
  }
  const n = pages.length
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]
    const tokens = documents[index]
    /* v8 ignore next -- pages and documents are built in lockstep */
    if (page === undefined || tokens === undefined) continue
    const tf = new Map<string, number>()
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
    let score = 0
    const seen = new Set<string>()
    for (const token of queryTokens) {
      if (seen.has(token)) continue
      seen.add(token)
      const freq = tf.get(token) ?? 0
      if (freq === 0) continue
      /* v8 ignore next -- present terms are in df */
      const docsWith = df.get(token) ?? 0
      const idf = Math.log((n - docsWith + 0.5) / (docsWith + 0.5) + 1)
      const lengthNorm = freq * (BM25_K1 + 1)
        / (freq + BM25_K1 * (1 - BM25_B + BM25_B * (tokens.length / avgLength)))
      score += idf * lengthNorm
    }
    if (score > 0) scores.set(page.path, score)
  }
  return scores
}

/**
 * Cosine similarity of two equal-orientation vectors.
 * @param left - first vector.
 * @param right - second vector.
 * @returns cosine in `[-1, 1]`, or 0 when either vector is zero-length or mismatched.
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    /* v8 ignore next -- index is in range */
    const a = left[index] ?? 0
    /* v8 ignore next -- lengths were equal */
    const b = right[index] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

/**
 * Combine BM25 and optional cosine into one score in `[0, ∞)`.
 * @param bm25 - lexical score (0 when absent).
 * @param cosine - semantic cosine, or `undefined` when embeddings are absent.
 * @returns the combined score.
 */
export function combinedScore(bm25: number, cosine: number | undefined): number {
  if (cosine === undefined) return bm25
  const lexical = bm25 / (1 + bm25)
  const semantic = (cosine + 1) / 2
  return SEMANTIC_WEIGHT * semantic + (1 - SEMANTIC_WEIGHT) * lexical
}

/**
 * First excerpt around a query token, or the leading body characters.
 * @param body - markdown body.
 * @param query - raw query.
 * @returns a short excerpt.
 */
export function excerptOf(body: string, query: string): string {
  const compact = body.replace(/\s+/gu, ' ').trim()
  const tokens = tokenize(query)
  const lower = compact.toLowerCase()
  for (const token of tokens) {
    const at = lower.indexOf(token)
    if (at < 0) continue
    const start = Math.max(0, at - 40)
    const end = Math.min(compact.length, at + token.length + 40)
    const prefix = start > 0 ? '…' : ''
    const suffix = end < compact.length ? '…' : ''
    return `${prefix}${compact.slice(start, end)}${suffix}`
  }
  return compact.slice(0, 80)
}

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)]+)\)/g
const WIKI_LINK = /\[\[([^\]]+)\]\]/g

/**
 * Collect outbound wiki-relative markdown targets from a body.
 * @param body - markdown body.
 * @returns unique `.md` targets, excluding http(s) and in-page hashes.
 */
export function outboundLinks(body: string): string[] {
  const found = new Set<string>()
  for (const match of body.matchAll(MARKDOWN_LINK)) {
    const raw = match[1]?.trim()
    /* v8 ignore next -- the markdown-link group is required */
    if (raw === undefined) continue
    /* v8 ignore next -- split always yields a string */
    const target = raw.split('#')[0] ?? ''
    if (target.length === 0) continue
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) continue
    if (target.endsWith('.md')) found.add(target)
  }
  for (const match of body.matchAll(WIKI_LINK)) {
    const raw = match[1]?.trim()
    /* v8 ignore next -- the wiki-link group is required */
    if (raw === undefined || raw.length === 0) continue
    found.add(raw.endsWith('.md') ? raw : `${raw}.md`)
  }
  return [...found]
}

/**
 * Lint pages for missing freshness, dead links, orphans, and index drift.
 * @param pages - every page including archive.
 * @param indexMarkdown - current generated `index.md` text, or empty when absent.
 * @returns the issue list; empty means clean.
 */
export function lintPages(pages: readonly WikiPage[], indexMarkdown: string): WikiLintIssue[] {
  const issues: WikiLintIssue[] = []
  const byPath = new Map(pages.map(page => [page.path, page]))
  const inbound = new Map<string, number>()
  for (const page of pages) inbound.set(page.path, 0)
  for (const page of pages) {
    if (page.frontmatter.created.trim().length === 0) {
      issues.push({
        code: 'missing-created',
        path: page.path,
        detail: `${page.path} is missing created frontmatter`,
      })
    }
    if (page.frontmatter.updated.trim().length === 0) {
      issues.push({
        code: 'missing-updated',
        path: page.path,
        detail: `${page.path} is missing updated frontmatter`,
      })
    }
    if (page.frontmatter.touched.trim().length === 0) {
      issues.push({
        code: 'missing-touched',
        path: page.path,
        detail: `${page.path} is missing touched frontmatter`,
      })
    }
    for (const target of outboundLinks(page.body)) {
      if (!byPath.has(target)) {
        issues.push({
          code: 'dead-link',
          path: page.path,
          target,
          detail: `${page.path} links to missing ${target}`,
        })
        continue
      }
      /* v8 ignore next -- inbound is prefilled */
      inbound.set(target, (inbound.get(target) ?? 0) + 1)
    }
  }
  for (const page of pages) {
    if (isArchivedPath(page.path) || page.frontmatter.status === 'archived') continue
    /* v8 ignore next -- inbound is prefilled */
    if ((inbound.get(page.path) ?? 0) === 0) {
      issues.push({
        code: 'orphan',
        path: page.path,
        detail: `${page.path} has no inbound links from other pages`,
      })
    }
  }
  const listed = indexListedPaths(indexMarkdown)
  for (const page of pages) {
    if (isArchivedPath(page.path) || page.frontmatter.status === 'archived') {
      if (listed.has(page.path)) {
        issues.push({
          code: 'archived-in-index',
          path: page.path,
          detail: `archived ${page.path} is listed in index.md`,
        })
      }
      continue
    }
    if (!listed.has(page.path)) {
      issues.push({
        code: 'index-missing',
        path: page.path,
        detail: `${page.path} is not listed in index.md`,
      })
    }
  }
  for (const path of listed) {
    if (!byPath.has(path)) {
      issues.push({
        code: 'index-stale',
        path: 'index.md',
        target: path,
        detail: `index.md lists missing ${path}`,
      })
    }
  }
  return issues
}

/**
 * Paths listed in a generated index (markdown link targets ending in `.md`).
 * @param indexMarkdown - `index.md` contents.
 * @returns the listed paths.
 */
export function indexListedPaths(indexMarkdown: string): Set<string> {
  const listed = new Set<string>()
  for (const match of indexMarkdown.matchAll(MARKDOWN_LINK)) {
    const target = match[1]?.trim()
    /* v8 ignore next -- link group is required */
    if (target !== undefined && target.endsWith('.md')) listed.add(target)
  }
  return listed
}

/**
 * Generate the size-capped `index.md` projection of active page frontmatter.
 * @param pages - pages to project; archive is omitted.
 * @param nowMs - evaluation clock for temperature headings.
 * @param config - temperature thresholds and line cap.
 * @returns generated markdown, never hand-edited.
 */
export function generateIndex(
  pages: readonly WikiPage[],
  nowMs: number,
  config: WikiEngineConfig,
): string {
  const active = pages.filter(page => !isArchivedPath(page.path) && page.frontmatter.status !== 'archived')
  const groups: Record<WikiTemperature, WikiPage[]> = { HOT: [], WARM: [], COLD: [] }
  for (const page of active) {
    groups[temperatureOf(page.frontmatter.touched, nowMs, config)].push(page)
  }
  for (const temperature of ['HOT', 'WARM', 'COLD'] as const) {
    groups[temperature].sort((left, right) => left.path.localeCompare(right.path))
  }
  const lines = [
    '# Wiki index',
    '',
    'Generated projection of page frontmatter. Do not edit.',
    '',
  ]
  for (const temperature of ['HOT', 'WARM', 'COLD'] as const) {
    lines.push(`## ${temperature}`, '')
    const group = groups[temperature]
    if (group.length === 0) {
      lines.push('_None._', '')
      continue
    }
    for (const page of group) {
      lines.push(`- [${page.title}](${page.path}) — touched ${page.frontmatter.touched}`)
    }
    lines.push('')
  }
  if (lines.length <= config.indexMaxLines) return lines.join('\n')
  const kept = lines.slice(0, config.indexMaxLines - 1)
  kept.push(`_Index truncated at ${String(config.indexMaxLines)} lines._`)
  return kept.join('\n')
}

/**
 * UTC calendar date `YYYY-MM-DD` for a millisecond timestamp.
 * @param nowMs - clock.
 * @returns the UTC date stamp used as a log shard name.
 */
export function utcDateStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}

/**
 * Wiki-relative path of the day-sharded log file.
 * @param nowMs - clock.
 * @returns `log/YYYY-MM-DD.md`.
 */
export function logPathOf(nowMs: number): string {
  return `log/${utcDateStamp(nowMs)}.md`
}
