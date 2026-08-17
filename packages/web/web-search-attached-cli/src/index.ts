/**
 * Register a multiplexer that searches through an attached conversation
 * vendor's hosted web-search API (Grok, Claude, Codex, Kimi, Ollama Cloud)
 * using the same credential that adapter already stores. It does not spawn
 * `grok`, `claude`, `codex`, or `kimi`.
 * @module @shres-code/shres-code-web-search-attached-cli
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { credentialRef } from '@shres-code/shres-code-credentials'
import { installSettingsSection, settingsNamespace } from '@shres-code/shres-code-settings'
import { launchEnvironmentOf } from '@shres-code/shres-code-launch-environment'
import type {} from '@shres-code/shres-code-web'
import type {} from '@shres-code/shres-code-agent-default-model'
import {
  ATTACHED_CLI_BACKENDS,
  AttachedCliSearchProvider,
  BACKEND_API_KEY_ENV,
  BACKEND_DEFAULT_BASE_URL,
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
  /** When false, Grok is omitted from the search pool. Defaults to on. */
  grok?: boolean
  /** When false, Claude is omitted from the search pool. Defaults to on. */
  claude?: boolean
  /** When false, Codex is omitted from the search pool. Defaults to on. */
  codex?: boolean
  /** When false, Kimi is omitted from the search pool. Defaults to on. */
  kimi?: boolean
  /** When false, Ollama Cloud is omitted from the search pool. Defaults to on. */
  ollama?: boolean
}

export const Config: z<Config> = z.object({
  grok: z.boolean().default(true),
  claude: z.boolean().default(true),
  codex: z.boolean().default(true),
  kimi: z.boolean().default(true),
  ollama: z.boolean().default(true),
})

/**
 * Enabled CLI backends in shipped order. An omitted flag is on.
 * @param config - current section.
 * @returns backends the multiplexer may use.
 */
export function enabledBackends(config: Config): AttachedCliBackendId[] {
  const flags: readonly [AttachedCliBackendId, boolean | undefined][] = [
    ['grok-cli', config.grok],
    ['claude-cli', config.claude],
    ['codex-cli', config.codex],
    ['kimi-cli', config.kimi],
    ['ollama-cloud', config.ollama],
  ]
  return flags.filter(([, on]) => on !== false).map(([id]) => id)
}

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
  const preference = enabledBackends(config)
  const enabled = new Set(preference)
  const currentProvider = ctx.get('agentDefaultModel')?.currentSelection().provider
  const backends = {} as Record<AttachedCliBackendId, AttachedCliBackend>
  for (const id of ATTACHED_CLI_BACKENDS) {
    const on = enabled.has(id)
    const envName = BACKEND_API_KEY_ENV[id]
    const ambient = launchEnvironmentOf(ctx).get(envName)?.value
    const cached = resolvedKeys.get(id)
    const apiKey = on
      ? (ambient !== undefined && ambient.length > 0 ? ambient : undefined)
        ?? (cached !== undefined && cached.length > 0 ? cached : undefined)
      : undefined
    backends[id] = {
      id,
      ...apiKey !== undefined ? { apiKey } : {},
      // The current conversation vendor is attached even before the credential
      // cache fills: search stays on that vendor instead of falling through.
      hasResolver: on && currentProvider === id,
      baseURL: BACKEND_DEFAULT_BASE_URL[id],
    }
  }
  return {
    preference,
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
