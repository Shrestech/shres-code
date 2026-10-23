/**
 * `@shres-code/shres-code-web-search-perplexity`: registers a Perplexity-backed
 * `WebSearchProvider` with `ctx.web`. A function/namespace plugin (NOT a
 * default-export service): it registers INTO the seam's provider registry, like
 * `@shres-code/shres-code-llm-deepseek` registers an adapter into `ctx.llm`.
 *
 * The key comes from the credentials domain (the web Settings page writes it)
 * with the launching environment as the no-seam fallback. Availability is
 * key-presence based: a keyless provider stays out of the fallback chain so
 * later providers still serve, unlike the terminal DeepSeek fallback.
 *
 * @module @shres-code/shres-code-web-search-perplexity
 */

import type { Context } from '@shres-code/cordis'
import { credentialRef } from '@shres-code/shres-code-credentials'
import type { CredentialRef } from '@shres-code/shres-code-credentials'
import { launchEnvironmentOf } from '@shres-code/shres-code-launch-environment'
import z from '@shres-code/schemastery'
import { installSettingsSection, settingsNamespace } from '@shres-code/shres-code-settings'
import type {} from '@shres-code/shres-code-web'
import { PerplexitySearchProvider, PERPLEXITY_DEFAULT_BASE_URL, PERPLEXITY_DEFAULT_MAX_TOKENS, PERPLEXITY_DEFAULT_MODEL } from './provider.ts'
import type { PerplexitySearchProviderOptions } from './provider.ts'

export {
  PERPLEXITY_DEFAULT_BASE_URL,
  PERPLEXITY_DEFAULT_MAX_TOKENS,
  PERPLEXITY_DEFAULT_MODEL,
  PERPLEXITY_PROVIDER_ID,
  PerplexitySearchProvider,
} from './provider.ts'
export type { PerplexityRecency, PerplexitySearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-perplexity'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'PERPLEXITY_API_KEY'

/** Plugin config (all optional — `apply` fills credential and constant defaults). */
export interface Config {
  /** Literal Perplexity API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference resolved for each refresh; defaults to `PERPLEXITY_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; `/chat/completions` is appended. Defaults to the public API. */
  baseURL?: string
  /** Search model name. Defaults to `sonar`. */
  model?: string
  /** Upper bound on generated answer tokens. Defaults to 1024. */
  maxTokens?: number
  /** Recency window sent as `search_recency_filter`. Omitted = no filter. */
  searchRecency?: 'day' | 'week' | 'month' | 'year'
  /** When false, this provider is omitted from the search pool. Defaults to on. */
  enabled?: boolean
}

// The schema deliberately mirrors web-search-deepseek's settings-section
// shape (secret key, credential reference, endpoint, model, budget, enabled):
// one card pattern owns both, and a shared helper would couple two packages
// that otherwise evolve independently.
/* jscpd:ignore-start */
export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  // Declared here rather than only at the use site: a configuration surface
  // renders the resolved section, so a default the schema does not carry reads
  // there as no value at all.
  baseURL: z.string(),
  model: z.string().default(PERPLEXITY_DEFAULT_MODEL),
  maxTokens: z.number().step(1).min(1).default(PERPLEXITY_DEFAULT_MAX_TOKENS),
  searchRecency: z.union(['day', 'week', 'month', 'year'] as const),
  enabled: z.boolean().default(true),
})
/* jscpd:ignore-end */

/** Settings namespace carrying this provider's endpoint, model, and key reference. */
export const WEB_SEARCH_PERPLEXITY_SETTINGS_NAMESPACE = settingsNamespace('web-search-perplexity')

/** The credential cache behind sync availability: which reference filled it, and the key. */
interface CredentialBox {
  /** Reference the cached value was resolved under; a renamed reference never serves a stale key. */
  ref: CredentialRef | undefined
  /** The last resolved key; undefined when the reference has none. */
  value: string | undefined
}

/**
 * Project one resolved section into the options the provider serves its next
 * search with. The literal config key wins outright; otherwise the credential
 * cache answers, keyed to the reference the section currently names.
 * @param config - the currently authoritative section.
 * @param box - the credential cache the refresh closure mutates.
 * @returns options for one search.
 */
function resolveOptions(config: Config, box: CredentialBox): PerplexitySearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literal = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  const apiKey = literal ?? (box.ref === apiKeyEnv ? box.value : undefined)
  return {
    ...apiKey !== undefined ? { apiKey } : {},
    apiKeyEnv,
    baseURL: config.baseURL ?? PERPLEXITY_DEFAULT_BASE_URL,
    model: config.model ?? PERPLEXITY_DEFAULT_MODEL,
    maxTokens: config.maxTokens ?? PERPLEXITY_DEFAULT_MAX_TOKENS,
    ...config.searchRecency !== undefined ? { searchRecency: config.searchRecency } : {},
    enabled: config.enabled !== false,
  }
}

/** Register the Perplexity search provider with `ctx.web`. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const box: CredentialBox = { ref: undefined, value: undefined }
  let current: () => Config = () => config
  /**
   * The credential reference the current section names.
   * @returns the reference as written, before branding.
   */
  const sectionReference = (): string => current().apiKeyEnv ?? DEFAULT_API_KEY_ENV
  /**
   * Resolve the section's credential into the availability cache.
   * @returns a promise settled once the cache reflects this resolution.
   */
  const refreshKey = async (): Promise<void> => {
    const ref = credentialRef(sectionReference())
    const credentials = ctx.get('credentials')
    let value: string | undefined
    if (credentials !== undefined) {
      value = (await credentials.resolve(ref))?.value
    } else {
      // Without the seam the launch environment is the only credential source.
      const ambient = launchEnvironmentOf(ctx).get(ref)?.value
      value = ambient !== undefined && ambient.length > 0 ? ambient : undefined
    }
    box.ref = ref
    box.value = value !== undefined && value.length > 0 ? value : undefined
  }
  /**
   * Report one failed refresh that ran outside a search, against the reference
   * the section names. A dropped failure hides why a pinned provider stays
   * unavailable: `ctx.web` refuses it before `search()` can retry the
   * resolution. The reference is logged; a value never is.
   * @param error - the failure the refresh raised.
   */
  const logRefreshFailure = (error: unknown): void => {
    ctx.logger.warn(
      'web-search-perplexity: resolving credential "%s" failed; availability keeps whatever the last resolution produced until a later refresh succeeds',
      sectionReference(),
    )
    ctx.logger.warn(error)
  }
  installSettingsSection(ctx, WEB_SEARCH_PERPLEXITY_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    // The registration carries no resolved value: the provider projects the
    // section per search, so a committed change needs no re-registration. The
    // credential cache is keyed to the reference the section names, so a
    // committed change that renames `apiKeyEnv` must resolve it again; otherwise
    // the cache answers for the old reference, `available()` is false, and
    // `ctx.web` refuses a pinned provider before a search could refresh.
    onChange: () => {
      void refreshKey().catch(logRefreshFailure)
    },
  })
  ctx.web.registerSearchProvider(new PerplexitySearchProvider(() => ({
    ...resolveOptions(current(), box),
    refreshKey,
  })))
  // A key stored after boot activates this provider only through a refresh, and
  // a keyless provider is never searched — so the search-time refresh alone
  // could never observe the write. The commit event closes that gap, but only
  // the reference this section names is this provider's business.
  ctx.on('credentials/updated', (ref) => {
    if (ref !== sectionReference()) return
    void refreshKey().catch(logRefreshFailure)
  })
  // Activation order is not guaranteed. Applying before the credentials service
  // exists resolves the launch environment instead, and a GUI-launched desktop
  // app does not populate that environment with provider keys — so this child
  // re-resolves the moment the seam appears and the provider converges without a
  // restart. An assembly that never mounts the seam reads the launch environment,
  // which is then the only credential source.
  ctx.inject(['credentials'], () => {
    void refreshKey().catch(logRefreshFailure)
  })
  // Resolve once at boot so availability reflects an already-stored key; a
  // backend failure leaves the provider keyless rather than sinking the plugin,
  // and is reported instead of dropped.
  await refreshKey().catch(logRefreshFailure)
}
