/**
 * Register a multiplexer that searches through an attached CLI vendor's
 * hosted web-search API (Grok, Claude, Codex, Kimi) using the same credential
 * `llm-cli-bridge` already stores. It does not spawn those CLIs.
 * @module @roos-code/roos-code-web-search-attached-cli
 */

import type { Context } from '@roos-code/cordis'
import z from '@roos-code/schemastery'
import { credentialRef } from '@roos-code/roos-code-credentials'
import { installSettingsSection, settingsNamespace } from '@roos-code/roos-code-settings'
import { launchEnvironmentOf } from '@roos-code/roos-code-launch-environment'
import type {} from '@roos-code/roos-code-web'
import type {} from '@roos-code/roos-code-agent-default-model'
import {
  ATTACHED_CLI_BACKENDS,
  AttachedCliSearchProvider,
  BACKEND_API_KEY_ENV,
  BACKEND_DEFAULT_BASE_URL,
  DEFAULT_PREFERENCE,
  isBackendId,
  type AttachedCliBackend,
  type AttachedCliBackendId,
  type AttachedCliSearchOptions,
} from './provider.ts'

export {
  ATTACHED_CLI_BACKENDS,
  ATTACHED_CLI_PROVIDER_ID,
  AttachedCliSearchProvider,
  BACKEND_API_KEY_ENV,
  BACKEND_DEFAULT_BASE_URL,
  BACKEND_DEFAULT_MODEL,
  DEFAULT_PREFERENCE,
  backendUsable,
  buildRequest,
  isBackendId,
  selectBackend,
} from './provider.ts'
export type { AttachedCliBackend, AttachedCliBackendId, AttachedCliSearchOptions } from './provider.ts'
export { mapVendorSearchPayload } from './parse.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-attached-cli'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config. */
export interface Config {
  /** Preference after the current conversation model. */
  preference?: AttachedCliBackendId[]
}

export const Config: z<Config> = z.object({
  preference: z.array(z.union(['grok-cli', 'claude-cli', 'codex-cli', 'kimi-cli'] as const)),
})

/** Settings namespace for preference order. */
export const WEB_SEARCH_ATTACHED_CLI_SETTINGS_NAMESPACE = settingsNamespace('web-search-attached-cli')

/**
 * Build one search snapshot from env, credential cache, and the live default model.
 * @param ctx - plugin context.
 * @param config - current section.
 * @param resolvedKeys - per-plugin credential cache.
 * @returns options for {@link AttachedCliSearchProvider}.
 */
function resolveOptions(
  ctx: Context,
  config: Config,
  resolvedKeys: Map<AttachedCliBackendId, string>,
): AttachedCliSearchOptions {
  const preference = (config.preference ?? DEFAULT_PREFERENCE).filter(isBackendId)
  const currentProvider = ctx.get('agentDefaultModel')?.currentSelection().provider
  const backends = {} as Record<AttachedCliBackendId, AttachedCliBackend>
  for (const id of ATTACHED_CLI_BACKENDS) {
    const envName = BACKEND_API_KEY_ENV[id]
    const ambient = launchEnvironmentOf(ctx).get(envName)?.value
    const cached = resolvedKeys.get(id)
    const apiKey = (ambient !== undefined && ambient.length > 0 ? ambient : undefined)
      ?? (cached !== undefined && cached.length > 0 ? cached : undefined)
    backends[id] = {
      id,
      ...apiKey !== undefined ? { apiKey } : {},
      // The current conversation CLI is attached even before the credential
      // cache fills: search stays on that vendor instead of falling through.
      hasResolver: currentProvider === id,
      baseURL: BACKEND_DEFAULT_BASE_URL[id],
    }
  }
  return {
    preference: preference.length > 0 ? preference : DEFAULT_PREFERENCE,
    ...currentProvider !== undefined ? { currentProvider } : {},
    backends,
    refreshKeys: async () => {
      const credentials = ctx.get('credentials')
      for (const id of ATTACHED_CLI_BACKENDS) {
        const envName = BACKEND_API_KEY_ENV[id]
        const ambient = launchEnvironmentOf(ctx).get(envName)?.value
        if (ambient !== undefined && ambient.length > 0) {
          resolvedKeys.set(id, ambient)
          continue
        }
        if (credentials === undefined) {
          resolvedKeys.delete(id)
          continue
        }
        const resolved = await credentials.resolve(credentialRef(envName))
        if (resolved !== undefined && resolved.value.length > 0) resolvedKeys.set(id, resolved.value)
        else resolvedKeys.delete(id)
      }
    },
  }
}

/** Register the attached-CLI search provider with `ctx.web`. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolvedKeys = new Map<AttachedCliBackendId, string>()
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_ATTACHED_CLI_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {},
  })
  const provider = new AttachedCliSearchProvider(() => resolveOptions(ctx, current(), resolvedKeys))
  ctx.web.registerSearchProvider(provider)
  await resolveOptions(ctx, current(), resolvedKeys).refreshKeys?.()
}
