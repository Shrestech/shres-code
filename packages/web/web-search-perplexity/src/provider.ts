/**
 * Perplexity search over its OpenAI-compatible chat-completions endpoint. The generated answer
 * becomes `content`; sources prefer structured `search_results[]` and fall back to URL-only
 * `citations[]`. The wire format and native `fetch` client are provider-private and do not use
 * `ctx.llm`.
 * @module @shres-code/shres-code-web-search-perplexity/provider
 */

import { WebError } from '@shres-code/shres-code-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@shres-code/shres-code-web'
import type { CredentialRef } from '@shres-code/shres-code-credentials'
import type { PerplexityError, PerplexityResponse, PerplexitySearchResult } from './types.ts'

/** Stable id this provider registers under. */
export const PERPLEXITY_PROVIDER_ID = 'perplexity'

/** Default Perplexity endpoint; `/chat/completions` is the operation. */
export const PERPLEXITY_DEFAULT_BASE_URL = 'https://api.perplexity.ai'

/** Default search model. */
export const PERPLEXITY_DEFAULT_MODEL = 'sonar'

/** Default upper bound on generated answer tokens. */
export const PERPLEXITY_DEFAULT_MAX_TOKENS = 1024

/** Recency filter values Perplexity accepts for `search_recency_filter`. */
export type PerplexityRecency = 'day' | 'week' | 'month' | 'year'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'shres-code/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface PerplexitySearchProviderOptions {
  /**
   * The last resolved Perplexity API key: the literal config key, or the
   * credential cache's snapshot. Absent until a key exists, which keeps the
   * provider out of the fallback chain instead of shadowing later providers.
   */
  apiKey?: string
  /**
   * Refresh the credential cache from the credentials seam before one search,
   * so a key stored after boot (the Settings page writes it) takes effect
   * without a restart. Sync `available()` reads the last snapshot only.
   */
  refreshKey?: () => Promise<void>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /** Search model name. */
  model: string
  /** Upper bound on generated answer tokens (`max_tokens`). */
  maxTokens: number
  /** Optional recency window sent as `search_recency_filter`; omitted = no filter. */
  searchRecency?: PerplexityRecency
  /** When false, `available()` is false. */
  enabled?: boolean
}

/**
 * Map one structured Perplexity search result to a normalized source.
 *
 * @param result - one entry of the response's `search_results[]`.
 * @returns the normalized source; blank fields are omitted rather than set empty.
 */
export function mapPerplexityResult(result: PerplexitySearchResult): WebSearchSource {
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    ...result.snippet != null && result.snippet.length > 0 ? { snippet: result.snippet } : {},
    ...result.date != null && result.date.length > 0 ? { publishedAt: result.date } : {},
  }
}

/**
 * Map a Perplexity response envelope to a normalized search result. Prefers
 * structured `search_results[]`; falls back to URL-only `citations[]` (those
 * sources carry just a `url`) only when `search_results` is absent.
 *
 * @param response - the parsed chat-completions response body.
 * @returns the normalized result; `content` is omitted when the answer is empty.
 */
export function mapPerplexityResponse(response: PerplexityResponse): WebSearchResult {
  const content = response.choices?.[0]?.message?.content
  const sources: WebSearchSource[] = response.search_results !== undefined
    ? response.search_results.map(mapPerplexityResult)
    : (response.citations ?? []).map(url => ({ url }))
  return {
    ...content != null && content.length > 0 ? { content } : {},
    sources,
    truncated: false,
  }
}

/** The Perplexity-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class PerplexitySearchProvider implements WebSearchProvider {
  readonly id = PERPLEXITY_PROVIDER_ID

  /**
   * @param resolveOptions - options for the NEXT search, snapshotted once per
   * availability check and per operation.
   */
  constructor(private readonly resolveOptions: () => PerplexitySearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return options.enabled !== false
      && (options.apiKey?.length ?? 0) > 0
      && URL.canParse(options.baseURL)
      && isPositiveInteger(options.maxTokens)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // Refresh mutates the credential cache. Re-read after it so this search's
    // key is the one just resolved, not the empty pre-refresh copy.
    await this.refreshKey(signal)
    const options = this.resolveOptions()
    throwIfSearchAborted(signal)
    const apiKey = options.apiKey
    if (apiKey === undefined || apiKey.length === 0) {
      const ref = options.apiKeyEnv ?? 'PERPLEXITY_API_KEY'
      throw new WebError(
        `Perplexity search has no API key for "${ref}"; store it through the credentials service`
        + ' (the web Settings page writes it), export it in the launching environment, or set a literal'
        + ' "apiKey" in the web-search-perplexity config',
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      )
    }
    let response: Response
    try {
      response = await fetch(`${options.baseURL}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          model: options.model,
          max_tokens: options.maxTokens,
          messages: [{ role: 'user', content: request.query }],
          ...options.searchRecency !== undefined ? { search_recency_filter: options.searchRecency } : {},
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Perplexity search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Perplexity API error (HTTP ${status})`
      try {
        const parsed = await response.json() as PerplexityError
        const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as PerplexityResponse
      return mapPerplexityResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Perplexity returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
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
        throw new WebError('Perplexity search aborted', 'WEB_ABORTED', {
          cause: signal?.aborted === true ? signal.reason : error,
        })
      }
      throw new WebError(`Perplexity search credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: signal.reason })
  }
}

// These two predicates are intentionally local: exporting generic internals
// from the public web seam would add more API than these pure checks.
/* jscpd:ignore-start */
/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** True for a request limit that can be sent to Perplexity (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
/* jscpd:ignore-end */
