/**
 * Service Definition for the web access capability seam (`ctx.web`): registries and provider-selecting execution for search and
 * fetch. Duplicate ids are rejected. At execution time, a configured provider must exist and
 * be usable; without one, exactly one usable provider is required, so selection never depends
 * on registration order.
 * @module @shres-code/shres-code-web
 */

import { Context, Service } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from './types.ts'
import { WebError } from './types.ts'

export {
  WebError,
} from './types.ts'
export type {
  WebFetchBody,
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from './types.ts'

declare module '@shres-code/cordis' {
  interface Context {
    web: WebRuntime
  }
}

/** Selection inputs for execution-time provider resolution. */
interface Selection<P> {
  /** Exclusive pin; when set, fallback ids are ignored. */
  readonly configuredId?: string
  /** Ordered first-usable-wins ids. Ignored when {@link configuredId} is set. */
  readonly fallbackIds?: readonly string[]
  /** Providers registered for this capability kind. */
  readonly providers: ReadonlyMap<string, P>
}

/**
 * Config for the web seam. `searchProvider` / `fetchProvider` pin which provider
 * wins for each capability; both are optional (a single registered usable
 * provider auto-selects). `searchProviders` / `fetchProviders` are ordered
 * fallbacks used only when the singular pin is omitted. Operational overrides
 * such as environment variables must feed these same fields rather than
 * introduce a hidden priority chain.
 */
export interface WebRuntimeConfig {
  /** Exclusive search provider id. Wins over {@link searchProviders}. */
  readonly searchProvider?: string
  /** Ordered search ids; the first registered and `available()` provider runs. */
  readonly searchProviders?: string[]
  /** Exclusive fetch provider id. Wins over {@link fetchProviders}. */
  readonly fetchProvider?: string
  /** Ordered fetch ids; the first registered and `available()` provider runs. */
  readonly fetchProviders?: string[]
}

/**
 * The web access service. Registered as `ctx.web` (one instance per context).
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A singular configured id that is registered and `available()` → that provider.
 * - A singular configured id not registered → `WEB_PROVIDER_CONFIGURED_MISSING`.
 * - A singular configured id registered but unavailable →
 *   `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - An ordered fallback list → first listed id that is registered and usable.
 * - A fallback list whose members are all missing or unusable →
 *   `WEB_PROVIDER_UNAVAILABLE`.
 * - No pin, exactly one registered usable provider → that provider.
 * - No pin, multiple usable providers → `WEB_PROVIDER_AMBIGUOUS`.
 * - No pin, no usable provider → `WEB_PROVIDER_UNAVAILABLE`.
 */
export class WebRuntime extends Service {
  /**
   * Provider selection config. Operational env overrides feed the SAME fields:
   * `$SHRES_WEB_SEARCH_PROVIDER` / `$SHRES_WEB_FETCH_PROVIDER` are equivalent to
   * `searchProvider` / `fetchProvider` and are NOT a hidden priority chain.
   */
  static Config: z<WebRuntimeConfig> = z.object({
    searchProvider: z.string(),
    searchProviders: z.array(z.string()),
    fetchProvider: z.string(),
    fetchProviders: z.array(z.string()),
  })

  private searchProviders = new Map<string, WebSearchProvider>()
  private fetchProviders = new Map<string, WebFetchProvider>()
  private readonly searchProviderId: string | undefined
  private readonly searchProviderFallbackIds: readonly string[] | undefined
  private readonly fetchProviderId: string | undefined
  private readonly fetchProviderFallbackIds: readonly string[] | undefined

  constructor(ctx: Context, config: WebRuntimeConfig = {}) {
    super(ctx, 'web')
    this.searchProviderId = config.searchProvider ?? process.env.SHRES_WEB_SEARCH_PROVIDER
    this.searchProviderFallbackIds = splitProviderList(
      config.searchProviders ?? splitEnvList(process.env.SHRES_WEB_SEARCH_PROVIDERS),
    )
    this.fetchProviderId = config.fetchProvider ?? process.env.SHRES_WEB_FETCH_PROVIDER
    this.fetchProviderFallbackIds = splitProviderList(
      config.fetchProviders ?? splitEnvList(process.env.SHRES_WEB_FETCH_PROVIDERS),
    )
  }

  /**
   * Register a search provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for search. Returns a disposer; disposed
   * with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerSearchProvider(provider: WebSearchProvider): () => void {
    return this.registerProvider(this.searchProviders, provider)
  }

  /**
   * Register a fetch provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for fetch. Returns a disposer; disposed
   * with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerFetchProvider(provider: WebFetchProvider): () => void {
    return this.registerProvider(this.fetchProviders, provider)
  }

  private registerProvider<P extends { readonly id: string }>(store: Map<string, P>, provider: P): () => void {
    if (store.has(provider.id)) {
      throw new WebError(`a web provider with id "${provider.id}" is already registered`, 'WEB_DUPLICATE_PROVIDER')
    }
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => store.delete(provider.id)
    }, 'web.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Run one search through the selected provider. Resolves the provider at call
   * time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. The seam enforces `request.maxResults` on the result:
   * if the provider over-returns, `sources[]` is truncated and `truncated` set.
   * @param request - the query and optional result limit.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the provider's results, capped to `request.maxResults`.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const provider = resolveProvider({
      providers: this.searchProviders,
      ...this.searchProviderId !== undefined ? { configuredId: this.searchProviderId } : {},
      ...this.searchProviderFallbackIds !== undefined
        ? { fallbackIds: this.searchProviderFallbackIds }
        : {},
    })
    const result = await provider.search(request, signal)
    return capSources(result, request.maxResults)
  }

  /**
   * Retrieve one URL through the selected provider. Resolves the provider at
   * call time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. A non-2xx response is a result, not a throw.
   * @param request - the URL plus retrieval options.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the retrieval outcome; non-2xx responses resolve descriptively.
   */
  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const provider = resolveProvider({
      providers: this.fetchProviders,
      ...this.fetchProviderId !== undefined ? { configuredId: this.fetchProviderId } : {},
      ...this.fetchProviderFallbackIds !== undefined
        ? { fallbackIds: this.fetchProviderFallbackIds }
        : {},
    })
    return provider.fetch(request, signal)
  }
}

interface ResolvableProvider {
  readonly id: string
  available(): boolean
}

/** Resolve the selected provider or throw the matching {@link WebError}. */
function resolveProvider<P extends ResolvableProvider>(selection: Selection<P>): P {
  const { configuredId, fallbackIds, providers } = selection
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw new WebError(`configured web provider "${configuredId}" is not registered`, 'WEB_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new WebError(`configured web provider "${configuredId}" is registered but unavailable`, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  if (fallbackIds !== undefined) {
    for (const id of fallbackIds) {
      const provider = providers.get(id)
      if (provider !== undefined && provider.available()) return provider
    }
    throw new WebError(
      `no usable web provider from [${fallbackIds.join(', ')}]`,
      'WEB_PROVIDER_UNAVAILABLE',
    )
  }
  const usable = [...providers.values()].filter(provider => provider.available())
  const [single] = usable
  if (single === undefined) {
    throw new WebError('no usable web provider is registered', 'WEB_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new WebError(`multiple usable web providers are registered (${ids}); configure one explicitly`, 'WEB_PROVIDER_AMBIGUOUS')
  }
  return single
}

/**
 * Drop blank ids from a configured fallback list.
 * @param ids - raw configured or env-split ids.
 * @returns a non-empty list, or `undefined` when nothing remains.
 */
function splitProviderList(ids: readonly string[] | undefined): string[] | undefined {
  if (ids === undefined) return undefined
  const cleaned = ids.map(id => id.trim()).filter(id => id.length > 0)
  return cleaned.length > 0 ? cleaned : undefined
}

/**
 * Split `$SHRES_WEB_*_PROVIDERS` (comma-separated) into ids.
 * @param value - raw environment value.
 * @returns ids, or `undefined` when the variable is unset or blank.
 */
function splitEnvList(value: string | undefined): readonly string[] | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  return value.split(',')
}

/** Enforce `maxResults` on a search result: truncate `sources[]` and flag it. */
function capSources(result: WebSearchResult, maxResults: number | undefined): WebSearchResult {
  if (maxResults === undefined || result.sources.length <= maxResults) return result
  return { ...result, sources: result.sources.slice(0, maxResults), truncated: true }
}

export default WebRuntime
