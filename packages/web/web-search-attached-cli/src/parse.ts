/**
 * Map vendor search/tool payloads onto {@link WebSearchResult} without
 * requiring every backend to share one envelope.
 * @module @shres-code/shres-code-web-search-attached-cli/parse
 */

import { WebError } from '@shres-code/shres-code-web'
import type { WebSearchResult, WebSearchSource } from '@shres-code/shres-code-web'

/** One collected citation while walking a vendor payload. */
interface CollectedSource {
  url: string
  title?: string
  snippet?: string
}

/**
 * Pull citeable http(s) sources and optional answer text from a vendor JSON body.
 * @param payload - parsed response body (any vendor).
 * @returns a seam result; `truncated` is always false (the seam caps sources).
 */
export function mapVendorSearchPayload(payload: unknown): WebSearchResult {
  const sources = new Map<string, CollectedSource>()
  const texts: string[] = []
  walk(payload, sources, texts)
  const content = texts.map(text => text.trim()).find(text => text.length > 0)
  return {
    ...content === undefined ? {} : { content },
    sources: [...sources.values()].map((source): WebSearchSource => ({
      url: source.url,
      ...source.title !== undefined && source.title.length > 0 ? { title: source.title } : {},
      ...source.snippet !== undefined && source.snippet.length > 0 ? { snippet: source.snippet } : {},
    })),
    truncated: false,
  }
}

/** The Z.AI Web Search API response envelope (docs.z.ai/api-reference/tools/web-search). */
interface ZaiSearchResponse {
  /** Result rows; `link` is the citeable URL, `content` the summary. */
  search_result?: unknown
}

/**
 * Map the Z.AI Web Search API envelope onto a seam result. The endpoint is
 * retrieval-only, so there is no generated answer: every row with a citeable
 * http(s) `link` becomes a source carrying `title`, `content` as the snippet,
 * and `publish_date` as `publishedAt`. The envelope is fixed by the API
 * reference, so a 200 body that does not match it is a provider error rather
 * than an empty result; rows without a citeable link are dropped, and
 * site-name/icon fields have no seam counterpart.
 *
 * @param payload - parsed response body from `POST /api/paas/v4/web_search`.
 * @returns a seam result; `truncated` is always false (the seam caps sources).
 */
export function mapZaiSearchPayload(payload: unknown): WebSearchResult {
  if (payload === null || typeof payload !== 'object' || !Array.isArray((payload as ZaiSearchResponse).search_result)) {
    throw new WebError('Z.AI search returned an envelope without a search_result list', 'WEB_PROVIDER_ERROR')
  }
  const envelope = payload as ZaiSearchResponse
  const sources: WebSearchSource[] = []
  for (const row of envelope.search_result as unknown[]) {
    if (row === null || typeof row !== 'object') continue
    const entry = row as Record<string, unknown>
    const link = entry.link
    if (typeof link !== 'string' || !isHttpUrl(link)) continue
    sources.push({
      url: link,
      ...typeof entry.title === 'string' && entry.title.length > 0 ? { title: entry.title } : {},
      ...typeof entry.content === 'string' && entry.content.length > 0 ? { snippet: entry.content } : {},
      ...typeof entry.publish_date === 'string' && entry.publish_date.length > 0 ? { publishedAt: entry.publish_date } : {},
    })
  }
  return { sources, truncated: false }
}

/**
 * Walk one JSON value for URLs, titles, and answer text.
 * @param value - current node.
 * @param sources - URL-keyed citations.
 * @param texts - candidate answer strings.
 */
function walk(value: unknown, sources: Map<string, CollectedSource>, texts: string[]): void {
  if (typeof value === 'string') {
    if (isHttpUrl(value)) remember(sources, value, {})
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, sources, texts)
    return
  }
  if (value === null || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  const url = readHttpUrl(record)
  if (url !== undefined) {
    remember(sources, url, {
      title: readString(record, ['title', 'name']),
      snippet: readString(record, ['snippet', 'cited_text', 'text', 'description', 'content']),
    })
  }
  if (record.type === 'output_text') {
    const outputText = readString(record, ['text', 'output_text'])
    if (outputText !== undefined) texts.push(outputText)
  } else {
    const outputText = readString(record, ['output_text'])
    if (outputText !== undefined) texts.push(outputText)
  }
  if (typeof record.content === 'string' && record.role === 'assistant') texts.push(record.content)
  for (const child of Object.values(record)) walk(child, sources, texts)
}

/**
 * Record one URL, filling optional fields only when still empty.
 * @param sources - URL-keyed citations.
 * @param url - citeable http(s) URL.
 * @param extra - optional title/snippet.
 */
function remember(
  sources: Map<string, CollectedSource>,
  url: string,
  extra: { title?: string | undefined; snippet?: string | undefined },
): void {
  const existing = sources.get(url)
  if (existing === undefined) {
    const collected: CollectedSource = { url }
    if (extra.title !== undefined) collected.title = extra.title
    if (extra.snippet !== undefined) collected.snippet = extra.snippet
    sources.set(url, collected)
    return
  }
  if (existing.title === undefined && extra.title !== undefined) existing.title = extra.title
  if (existing.snippet === undefined && extra.snippet !== undefined) existing.snippet = extra.snippet
}

/**
 * Read the first non-empty string among named fields.
 * @param record - object node.
 * @param keys - field names in preference order.
 * @returns the first non-empty string, or `undefined`.
 */
function readString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

/**
 * Read an http(s) URL from common citation fields.
 * @param record - object node.
 * @returns the URL, or `undefined`.
 */
function readHttpUrl(record: Record<string, unknown>): string | undefined {
  const value = record.url ?? record.uri ?? record.link
  return typeof value === 'string' && isHttpUrl(value) ? value : undefined
}

/**
 * True for an absolute http(s) URL.
 * @param value - candidate string.
 * @returns whether the value is a citeable web URL.
 */
function isHttpUrl(value: string): boolean {
  return value.startsWith('https://') || value.startsWith('http://')
}
