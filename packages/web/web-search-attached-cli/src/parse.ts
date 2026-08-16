/**
 * Map vendor search/tool payloads onto {@link WebSearchResult} without
 * requiring every backend to share one envelope.
 * @module @roos-code/roos-code-web-search-attached-cli/parse
 */

import type { WebSearchResult, WebSearchSource } from '@roos-code/roos-code-web'

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
      snippet: readString(record, ['snippet', 'cited_text', 'text', 'description']),
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
