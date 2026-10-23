/**
 * Brave Search provider plugin for the web capability seam: registers the
 * `brave` search provider into `ctx.web`, resolving its subscription token
 * from the credentials seam (`BRAVE_API_KEY` by default) with the same
 * per-search refresh and hot-activation posture as the sibling providers.
 *
 * @module @shres-code/shres-code-web-search-brave
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { credentialRef } from '@shres-code/shres-code-credentials'
import type { CredentialRef } from '@shres-code/shres-code-credentials'
import { launchEnvironmentOf } from '@shres-code/shres-code-launch-environment'
import { installSettingsSection, settingsNamespace } from '@shres-code/shres-code-settings'
import {
  BRAVE_DEFAULT_BASE_URL,
  BRAVE_DEFAULT_COUNT,
  BraveSearchProvider,
} from './provider.ts'
import type { BraveSearchProviderOptions } from './provider.ts'

export {
  BRAVE_DEFAULT_BASE_URL,
  BRAVE_DEFAULT_COUNT,
  BRAVE_PROVIDER_ID,
  BraveSearchProvider,
  mapBraveResponse,
  mapBraveResult,
} from './provider.ts'
export type { BraveSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-brave'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'BRAVE_API_KEY'

/** Plugin config (all optional — `apply` fills credential and constant defaults). */
export interface Config {
  /** Literal Brave subscription token; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference resolved for each refresh; defaults to `BRAVE_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; `/web/search` is appended. Defaults to the public API. */
  baseURL?: string
  /** Upper bound on result rows requested per search. Defaults to 8. */
  count?: number
  /** When false, this provider is omitted from the search pool. Defaults to on. */
  enabled?: boolean
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  count: z.number().step(1).min(1).default(BRAVE_DEFAULT_COUNT),
  enabled: z.boolean().default(true),
})

/** Settings namespace carrying this provider's endpoint and key reference. */
export const WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE = settingsNamespace('web-search-brave')

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
function resolveOptions(config: Config, box: CredentialBox): BraveSearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literal = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  const apiKey = literal ?? (box.ref === apiKeyEnv ? box.value : undefined)
  return {
    ...apiKey !== undefined ? { apiKey } : {},
    apiKeyEnv,
    baseURL: config.baseURL ?? BRAVE_DEFAULT_BASE_URL,
    count: config.count ?? BRAVE_DEFAULT_COUNT,
    enabled: config.enabled !== false,
  }
}

/** Register the Brave search provider with `ctx.web`. */
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
      'web-search-brave: resolving credential "%s" failed; availability keeps whatever the last resolution produced until a later refresh succeeds',
      sectionReference(),
    )
    ctx.logger.warn(error)
  }
  installSettingsSection(ctx, WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE, Config, config, {
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
  ctx.web.registerSearchProvider(new BraveSearchProvider(() => ({
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
