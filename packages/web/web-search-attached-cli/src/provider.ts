/**
 * Multiplexed search provider that calls a vendor hosted web-search API using
 * the same credential the conversation adapter already stores. It does not
 * spawn `grok`, `claude`, `codex`, or `kimi`.
 * @module @roos-code/roos-code-web-search-attached-cli/provider
 */

import { WebError } from '@roos-code/roos-code-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from '@roos-code/roos-code-web'
import { mapVendorSearchPayload } from './parse.ts'

/** Stable id this provider registers under. */
export const ATTACHED_CLI_PROVIDER_ID = 'attached-cli'

/** Shipped conversation vendors this multiplexer can search through. */
export const ATTACHED_CLI_BACKENDS = [
  'grok-cli',
  'claude-cli',
  'codex-cli',
  'kimi-cli',
  'ollama-cloud',
] as const

/** One shipped CLI backend id. */
export type AttachedCliBackendId = (typeof ATTACHED_CLI_BACKENDS)[number]

/** Default preference when config omits one. */
export const DEFAULT_PREFERENCE: readonly AttachedCliBackendId[] = ATTACHED_CLI_BACKENDS

/** Credential env names already used by the matching conversation adapter. */
export const BACKEND_API_KEY_ENV: Record<AttachedCliBackendId, string> = {
  'grok-cli': 'XAI_API_KEY',
  'claude-cli': 'ANTHROPIC_API_KEY',
  'codex-cli': 'OPENAI_API_KEY',
  'kimi-cli': 'MOONSHOT_API_KEY',
  'ollama-cloud': 'OLLAMA_API_KEY',
}

/** Default HTTP bases for each vendor search call. */
export const BACKEND_DEFAULT_BASE_URL: Record<AttachedCliBackendId, string> = {
  'grok-cli': 'https://api.x.ai/v1',
  'claude-cli': 'https://api.anthropic.com/v1',
  'codex-cli': 'https://api.openai.com/v1',
  'kimi-cli': 'https://api.moonshot.ai/v1',
  'ollama-cloud': 'https://ollama.com',
}

/**
 * Auxiliary search models. These are vendor Messages/Responses ids, not the
 * CLI aliases (`sonnet`, `k2`) the conversation adapter stores. Ollama search
 * is a dedicated retrieval endpoint and does not send a model.
 */
export const BACKEND_DEFAULT_MODEL: Record<Exclude<AttachedCliBackendId, 'ollama-cloud'>, string> = {
  'grok-cli': 'grok-4.6',
  'claude-cli': 'claude-sonnet-4-5',
  'codex-cli': 'gpt-5.4',
  'kimi-cli': 'kimi-k2.6',
}

const USER_AGENT = 'roos-code/0.0.1'

/** One backend's resolved HTTP search target. */
export interface AttachedCliBackend {
  /** CLI route id this backend mirrors. */
  readonly id: AttachedCliBackendId
  /** Non-empty API key, when currently usable. */
  readonly apiKey?: string
  /** True when a credential resolver exists even if {@link apiKey} is empty. */
  readonly hasResolver: boolean
  /** Vendor API base. */
  readonly baseURL: string
}

/** Options snapshotted at the start of one search. */
export interface AttachedCliSearchOptions {
  /** Preference order after the current conversation model. */
  readonly preference: readonly AttachedCliBackendId[]
  /** Current default model provider, when the default-model service is mounted. */
  readonly currentProvider?: string
  /** Resolved backends keyed by route id. */
  readonly backends: Readonly<Record<AttachedCliBackendId, AttachedCliBackend>>
  /** Injected fetch (tests). Defaults to global fetch. */
  readonly fetch?: typeof fetch
  /**
   * Refresh backend `apiKey` fields from the credentials seam before pick.
   * Sync {@link available} uses the last snapshot only.
   */
  readonly refreshKeys?: () => Promise<void>
}

/**
 * True when this backend can run a search without waiting on the network.
 * @param backend - one vendor slot.
 * @returns whether a key is present or a resolver is wired.
 */
export function backendUsable(backend: AttachedCliBackend): boolean {
  return (backend.apiKey !== undefined && backend.apiKey.length > 0) || backend.hasResolver
}

/**
 * Pick the backend for one search: current CLI model if usable, else preference.
 * @param options - snapshotted options.
 * @returns the chosen backend id, or `undefined` when none are usable.
 */
export function selectBackend(options: AttachedCliSearchOptions): AttachedCliBackendId | undefined {
  const current = options.currentProvider
  if (current !== undefined && isBackendId(current) && backendUsable(options.backends[current])) {
    return current
  }
  for (const id of options.preference) {
    if (backendUsable(options.backends[id])) return id
  }
  return undefined
}

/**
 * Narrow a string to a shipped backend id.
 * @param value - candidate provider id.
 * @returns whether it is a shipped CLI backend.
 */
export function isBackendId(value: string): value is AttachedCliBackendId {
  return (ATTACHED_CLI_BACKENDS as readonly string[]).includes(value)
}

/** Multiplexed attached-CLI search provider. */
export class AttachedCliSearchProvider implements WebSearchProvider {
  readonly id = ATTACHED_CLI_PROVIDER_ID

  /**
   * @param resolveOptions - options for the NEXT search, snapshotted once per call.
   */
  constructor(private readonly resolveOptions: () => AttachedCliSearchOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return selectBackend(options) !== undefined
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    await this.resolveOptions().refreshKeys?.()
    // Refresh mutates the credential cache. Re-read after it so the chosen
    // backend's key is the one just resolved, not the empty pre-refresh copy.
    const options = this.resolveOptions()
    const id = selectBackend(options)
    if (id === undefined) {
      throw new WebError('no attached CLI search backend has a credential', 'WEB_PROVIDER_UNAVAILABLE')
    }
    const backend = options.backends[id]
    const apiKey = backend.apiKey
    if (apiKey === undefined || apiKey.length === 0) {
      throw new WebError(
        `attached CLI search (${id}) has no API key for "${BACKEND_API_KEY_ENV[id]}"`,
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      )
    }
    const { url, headers, body } = buildRequest(id, backend.baseURL, apiKey, request.query)
    const fetchImpl = options.fetch ?? fetch
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...signal !== undefined ? { signal } : {},
        redirect: 'error',
      })
    } catch (error) {
      if (signal?.aborted) {
        throw new WebError('attached CLI search aborted', 'WEB_ABORTED', { cause: error })
      }
      throw new WebError(`attached CLI search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (!response.ok) {
      throw new WebError(
        `attached CLI search (${id}) failed: HTTP ${String(response.status)}`,
        'WEB_PROVIDER_ERROR',
      )
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new WebError(
        `attached CLI search (${id}) returned an unprocessable body: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    return mapVendorSearchPayload(payload)
  }
}

/**
 * Build one vendor search HTTP call.
 * @param id - backend to call.
 * @param baseURL - vendor API base.
 * @param apiKey - resolved secret.
 * @param query - user search query.
 * @returns url, headers, and JSON body.
 */
export function buildRequest(
  id: AttachedCliBackendId,
  baseURL: string,
  apiKey: string,
  query: string,
): { url: string; headers: Record<string, string>; body: unknown } {
  const base = baseURL.replace(/\/$/, '')
  switch (id) {
    case 'grok-cli':
    case 'codex-cli':
      return responsesSearchRequest(base, apiKey, BACKEND_DEFAULT_MODEL[id], query)
    case 'claude-cli':
      return {
        url: `${base}/messages`,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: {
          model: BACKEND_DEFAULT_MODEL[id],
          max_tokens: 2048,
          messages: [{ role: 'user', content: `Perform a web search for the query: ${query}` }],
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        },
      }
    case 'kimi-cli':
      return {
        url: `${base}/chat/completions`,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: {
          model: BACKEND_DEFAULT_MODEL[id],
          messages: [{ role: 'user', content: query }],
          tools: [{ type: 'builtin_function', function: { name: '$web_search' } }],
        },
      }
    case 'ollama-cloud':
      return {
        url: `${base}/api/web_search`,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: { query },
      }
    default: {
      const never: never = id
      throw new WebError(`unknown attached CLI backend: ${String(never)}`, 'WEB_PROVIDER_ERROR')
    }
  }
}

/**
 * Shared Grok/Codex Responses body: both vendors accept `{ type: "web_search" }`.
 * @param base - vendor API base without a trailing slash.
 * @param apiKey - resolved secret.
 * @param model - vendor Responses model id.
 * @param query - user search query.
 * @returns url, headers, and JSON body.
 */
function responsesSearchRequest(
  base: string,
  apiKey: string,
  model: string,
  query: string,
): { url: string; headers: Record<string, string>; body: unknown } {
  return {
    url: `${base}/responses`,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
    },
    body: {
      model,
      input: [{ role: 'user', content: query }],
      tools: [{ type: 'web_search' }],
    },
  }
}
