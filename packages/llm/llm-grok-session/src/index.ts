/**
 * Grok subscription-session adapter plugin. Registers one provider route,
 * `grok-session`, that serves `cli-chat-proxy.grok.com/v1` over the
 * `openai-responses` wire with the Grok Build CLI's OIDC session credential:
 * the transport, streaming, tool, and replay machinery are the shared
 * shres-llm-pi-ai adapter, and this plugin owns only the credential — read
 * from the CLI's auth document, refreshed through the issuer's
 * `refresh_token` grant, rotated values persisted back for the CLI.
 *
 * The route ships enabled and dormant: without a signed-in CLI login on the
 * machine, listing and selection work and the first request fails loud with
 * `MISSING_CREDENTIAL`, the same posture as a shipped API-key route whose
 * key was never stored.
 *
 * @module @shres-code/shres-code-llm-grok-session
 */

import type { Context } from '@shres-code/cordis'
import { LlmError } from '@shres-code/shres-code-llm'
import type {
  AdapterRegistrationHandle,
  DirectoryRegistrationHandle,
  LlmConfigurableProvider,
} from '@shres-code/shres-code-llm'
import {
  HOSTED_X_SEARCH_NAME,
  LOCAL_WEB_SEARCH_NAME,
  PiAiAdapter,
  resolveProfiles,
  webSearchToolEntry,
  xSearchToolEntry,
} from '@shres-code/shres-code-llm-pi-ai'
import type { PiAiAdapterHostedSearch, ResolvedPiAiProviderProfile } from '@shres-code/shres-code-llm-pi-ai'
import { GrokSessionManager } from '@shres-code/shres-code-grok-credential'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@shres-code/shres-code-settings'
import {
  Config,
  GROK_SESSION_PROVIDER_ID,
  resolveCredentialSpec,
  resolveHostedSearch,
  resolveRoute,
} from './config.ts'
import type { CredentialSpec } from './config.ts'

export {
  Config,
  DEFAULT_BASE_URL,
  DEFAULT_DISPLAY_NAME,
  DEFAULT_REFRESH_LEEWAY_MS,
  GROK_SESSION_PROVIDER_ID,
  SHIPPED_MODELS,
  defaultAuthPath,
  resolveCredentialSpec,
  resolveHostedSearch,
  resolveRoute,
} from './config.ts'
export type { GrokSessionModelConfig, ResolvedHostedSearch } from './config.ts'
export { GrokSessionManager, OIDC_ISSUER, selectSessionEntry } from '@shres-code/shres-code-grok-credential'
export type { GrokSessionEntry, GrokSessionOptions } from '@shres-code/shres-code-grok-credential'

export const name = 'llm-grok-session'
export const inject = ['llm']

const NS = settingsNamespace('llm-grok-session')

/**
 * The registry captures these per route; a change here must re-register.
 * The credential facts are deliberately absent: the adapter instance is
 * stable and reads the current section per request, so an auth-path or
 * leeway change reaches the next request without touching the registry.
 * @param config - current section value.
 * @param profiles - the resolved profile map the registry captures.
 * @returns a stable registration key.
 */
function registrationFacts(current: () => Config): unknown {
  const route = resolveRoute(current())
  return {
    // The settings schema defaults `enabled` to true, so the section value
    // is always a boolean here.
    enabled: current().enabled,
    displayName: route.displayName,
    baseURL: route.baseURL,
    modelIds: current().models?.map(model => model.id),
  }
}

/**
 * The credential hook: a session manager keyed by the credential facts it
 * was built with, rebuilt only when they change. Keying preserves the
 * single-flight refresh across requests while a live section read moves the
 * document or the leeway. The shared grok-credential service owns the
 * memoization when the composition mounts it; a local fallback with the same
 * keying covers compositions that only boot this adapter.
 * @param ctx - context carrying the optional grok-credential service.
 * @returns the manager for a resolved credential spec.
 */
function createCredentialResolver(ctx: Context): (spec: CredentialSpec) => GrokSessionManager {
  const local = new Map<string, GrokSessionManager>()
  return (spec) => {
    // Re-read the shared service each request so a composition that mounts it
    // after startup (or unloads it) is honored without a captured reference.
    const service = ctx.get('grokCredential')
    if (service !== undefined) return service.managerFor(spec)
    const key = `${spec.authPath}\u0000${String(spec.refreshLeewayMs)}`
    let manager = local.get(key)
    if (manager === undefined) {
      manager = new GrokSessionManager(spec)
      local.set(key, manager)
    }
    return manager
  }
}

/**
 * Resolve the route's hosted-search facts from the current section. Both
 * switches default off; when either is on the matching tool entry is spliced
 * into the outgoing request, the local `web_search` tool is dropped while a
 * hosted web search is on, and a hosted tool pi-ai surfaces as a tool call is
 * promoted to a server-tool-call block. Read live per request so a settings
 * change reaches the next stream without touching the registry.
 * @param current - read of the current section value.
 * @returns the hosted-search facts, or undefined when both switches are off.
 */
function buildHostedSearch(current: () => Config): PiAiAdapterHostedSearch | undefined {
  const { webSearch, xSearch } = resolveHostedSearch(current())
  if (!webSearch && !xSearch) return undefined
  const entries: Record<string, unknown>[] = []
  const dropLocalTools: string[] = []
  const callNames: string[] = []
  if (webSearch) {
    entries.push(webSearchToolEntry())
    // hosted wins: the colliding local web_search function tool is omitted
    dropLocalTools.push(LOCAL_WEB_SEARCH_NAME)
  }
  if (xSearch) {
    entries.push(xSearchToolEntry())
    // pi-ai surfaces the hosted x_search custom tool call as a tool call
    callNames.push(HOSTED_X_SEARCH_NAME)
  }
  return { entries, dropLocalTools, callNames }
}

/**
 * Build the adapter over the one resolved route, with the credential hook
 * owned here and everything else delegated to the shared pi-ai adapter. The
 * instance is built once and stays registered: every config fact it depends
 * on is read live per request.
 * @param ctx - context carrying attachments and the logger.
 * @param current - read of the current section value.
 * @param managerFor - the credential-fact resolver for {@link createCredentialResolver}.
 * @param profiles - memoized resolved-profile read.
 * @returns the adapter instance.
 */
function buildAdapter(
  ctx: Context,
  current: () => Config,
  managerFor: (spec: CredentialSpec) => GrokSessionManager,
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>,
): PiAiAdapter {
  return new PiAiAdapter({
    profiles,
    resolveApiKey: async () => {
      const manager = managerFor(resolveCredentialSpec(current()))
      try {
        return await manager.accessToken()
      } catch (error) {
        if (error instanceof LlmError) throw error
        throw new LlmError(
          `llm-grok-session: reading the Grok session failed: ${String(error)}`,
          'MISSING_CREDENTIAL',
        )
      }
    },
    resolveAttachments: () => ctx.get('attachments'),
    hostedSearch: () => buildHostedSearch(current),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(
        `llm-grok-session: unusable replay state on assistant history for route "${provider}/${model}";`
        + ` sending that message as provider-neutral content (${reason})`,
      )
    },
  })
}


/**
 * Register the Grok subscription-session route.
 * @param ctx - context carrying the llm service and optional settings.
 * @param config - composition entry; the settings section overlays it.
 */
/* jscpd:ignore-start -- deliberate lifecycle symmetry with llm-pi-ai's apply():
   the memoized-resolution, directory-entry, and registration-swap shape is the
   reviewed adapter-registration contract; extracting it would couple the two
   plugins' settings semantics. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let memoized: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  const profiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const raw = current()
    if (raw === lastRaw && memoized !== undefined) return memoized
    const next = resolveProfiles({ [GROK_SESSION_PROVIDER_ID]: resolveRoute(raw) })
    lastRaw = raw
    memoized = next
    return next
  }
  profiles()
  // Fail loud at mount for a self-contained misconfiguration, the same set
  // the settings validator refuses at write time below.
  resolveCredentialSpec(current())
  resolveHostedSearch(current())

  // The credential hook resolves through the shared service when present and
  // falls back to the local single-flight manager otherwise.
  const managerFor = createCredentialResolver(ctx)

  // One adapter for the plugin's whole life: the registry binds the instance
  // at register time, so every config fact is read live instead.
  const adapter = buildAdapter(ctx, () => current(), managerFor, profiles)

  const directoryEntry = (): LlmConfigurableProvider => ({
    provider: GROK_SESSION_PROVIDER_ID,
    displayName: resolveRoute(current()).displayName,
    settingsNs: NS,
    settingsPath: [],
    declared: false,
  })
  let directory: DirectoryRegistrationHandle | undefined
  let directoryFacts: unknown
  const ensureDirectory = (): void => {
    const entry = directoryEntry()
    if (deepEqualJson(entry, directoryFacts)) return
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders([entry])
    } else {
      directory.replace([entry])
    }
    directoryFacts = entry
  }
  ensureDirectory()

  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: unknown
  const ensureRegistrationFacts = (): void => {
    const facts = registrationFacts(current)
    if (deepEqualJson(facts, registeredFacts)) return
    // The settings schema defaults `enabled` to true, so it is always a boolean.
    const enabled = current().enabled
    if (registration === undefined) {
      if (!enabled) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter([GROK_SESSION_PROVIDER_ID], adapter)
    } else {
      registration.replace(enabled ? [GROK_SESSION_PROVIDER_ID] : [])
    }
    registeredFacts = facts
  }
  ensureRegistrationFacts()

  installSettingsSection(ctx, NS, Config, config as never, {
    validate: (section: Config) => {
      resolveRoute(section)
      resolveCredentialSpec(section)
      resolveHostedSearch(section)
    },
    setSource: (source) => { current = () => source() },
    onChange: () => {
      ensureDirectory()
      ensureRegistrationFacts()
    },
  })
}
/* jscpd:ignore-end */
