/**
 * Brave Search over its Web Search API: one GET returning a link engine's
 * result rows — no model turn, no answer synthesis — mapped onto the seam's
 * `sources[]` with `content` always absent. The wire format and native
 * `fetch` client are provider-private and do not use `ctx.llm`.
 * @module @shres-code/shres-code-web-search-brave/provider
 */

import { WebError } from '@shres-code/shres-code-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@shres-code/shres-code-web'
import type { CredentialRef } from '@shres-code/shres-code-credentials'

/** Stable id this provider registers under. */
export const BRAVE_PROVIDER_ID = 'brave'

/** Default Brave endpoint base; `/web/search` is the operation. */
export const BRAVE_DEFAULT_BASE_URL = 'https://api.search.brave.com/res/v1'

/** Default upper bound on result rows requested per search. */
export const BRAVE_DEFAULT_COUNT = 8

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'shres-code/0.0.1'

/** One `web.results[]` row the endpoint returns, as far as this mapping reads. */
interface BraveResultRow {
  url?: unknown
  title?: unknown
  description?: unknown
  age?: unknown
  page_age?: unknown
}

/** The response envelope the endpoint returns, as far as this mapping reads. */
interface BraveResponse {
  web?: { results?: unknown }
}

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface BraveSearchProviderOptions {
  /** Literal API key; the credential cache otherwise fills it per search. */
  apiKey?: string
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/web/search` is appended. */
  baseURL: string
  /** Upper bound on result rows requested. */
  count: number
  /** When false, `available()` is false. */
  enabled?: boolean
  /** Credential refresh the search awaits before reading its options. */
  refreshKey?: () => Promise<void>
}

/** Whether an error is the platform's abort shape, so cancellation stays cancellation. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new WebError('Brave search aborted', 'WEB_ABORTED', { cause: signal.reason })
  }
}

/** Whether a value is a non-empty string. */
function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Map one `web.results[]` row to a normalized source. A row without a usable
 * URL cannot be cited and is dropped rather than half-mapped; Brave's
 * `description` becomes the snippet and `page_age` (machine form) wins over
 * `age` (humanized) for `publishedAt`.
 * @param row - one result row.
 * @returns the normalized source, or `undefined` for a row without a URL.
 */
export function mapBraveResult(row: BraveResultRow): WebSearchSource | undefined {
  if (!nonEmptyString(row.url)) return undefined
  const pageAge = nonEmptyString(row.page_age) ? row.page_age : undefined
  const age = nonEmptyString(row.age) ? row.age : undefined
  const publishedAt = pageAge ?? age
  return {
    url: row.url,
    ...nonEmptyString(row.title) ? { title: row.title } : {},
    ...nonEmptyString(row.description) ? { snippet: row.description } : {},
    ...publishedAt !== undefined ? { publishedAt } : {},
  }
}

/**
 * Map a response envelope to a normalized result: every citable row becomes a
 * source and no answer text is invented — a link engine has none.
 * @param response - the parsed response body.
 * @returns the sources-only result.
 */
export function mapBraveResponse(response: BraveResponse): WebSearchResult {
  const results = Array.isArray(response.web?.results) ? response.web.results : []
  const sources = results
    .map(row => mapBraveResult(row as BraveResultRow))
    .filter((source): source is WebSearchSource => source !== undefined)
  return { sources, truncated: false }
}

/** The Brave-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class BraveSearchProvider implements WebSearchProvider {
  readonly id = BRAVE_PROVIDER_ID

  /**
   * @param resolveOptions - options for the NEXT search, snapshotted once per
   * availability check and per operation.
   */
  constructor(private readonly resolveOptions: () => BraveSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return options.enabled !== false
      && (options.apiKey?.length ?? 0) > 0
      && URL.canParse(options.baseURL)
      && Number.isSafeInteger(options.count)
      && options.count > 0
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // Refresh mutates the credential cache. Re-read after it so this search's
    // key is the one just resolved, not the empty pre-refresh copy.
    await this.refreshKey(signal)
    const options = this.resolveOptions()
    throwIfSearchAborted(signal)
    const apiKey = options.apiKey
    if (apiKey === undefined || apiKey.length === 0) {
      const ref = options.apiKeyEnv ?? 'BRAVE_API_KEY'
      throw new WebError(
        `Brave search has no API key for "${String(ref)}"; store it through the credentials service`
        + ' (the web Settings page writes it), export it in the launching environment, or set a literal'
        + ' "apiKey" in the web-search-brave config',
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      )
    }
    // Join on the base string, not URL-relative resolution: a base without a
    // trailing slash (`.../res/v1`) would resolve against its parent and drop
    // the version segment.
    const url = new URL(`${options.baseURL.replace(/\/+$/, '')}/web/search`)
    url.searchParams.set('q', request.query)
    url.searchParams.set('count', String(options.count))
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'accept': 'application/json',
          'x-subscription-token': apiKey,
          'user-agent': USER_AGENT,
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Brave search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Brave search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Brave API error (HTTP ${status})`
      try {
        const parsed = await response.json() as { message?: unknown }
        if (nonEmptyString(parsed.message)) message = parsed.message
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('Brave search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body can only cost a richer provider
        // message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as BraveResponse
      if (payload.web === undefined || !Array.isArray(payload.web.results)) {
        throw new Error('response carries no web.results array')
      }
      return mapBraveResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Brave search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Brave search returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /**
   * Await the credential refresh as part of the operation's cancellation
   * contract: an abort-shaped rejection is cancellation, anything else is a
   * credential-backend failure, never a missing key.
   * @param signal - abort signal for the surrounding search.
   */
  private async refreshKey(signal?: AbortSignal): Promise<void> {
    const refresh = this.resolveOptions().refreshKey
    if (refresh === undefined) return
    try {
      await refresh()
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) {
        throw new WebError('Brave search aborted', 'WEB_ABORTED', {
          cause: signal?.aborted === true ? signal.reason : error,
        })
      }
      throw new WebError(`Brave search credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}
