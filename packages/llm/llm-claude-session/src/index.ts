/**
 * Claude subscription-session adapter plugin. Registers one provider route,
 * `claude-session`, that serves api.anthropic.com over the
 * `anthropic-messages` wire with the credential the Claude Code CLI's
 * subscription sign-in stored: the transport, streaming, tool, and replay
 * machinery are the shared shres-llm-pi-ai adapter, and this plugin owns only
 * the credential — read from the CLI's store, refreshed through
 * console.anthropic.com's `refresh_token` grant, rotated values persisted
 * back for the CLI. Use bills the Claude subscription (Pro/Max), not the
 * Anthropic API; a delegated `claude-code` CLI route is the spawn-based
 * alternative.
 *
 * The route ships enabled and dormant: without a signed-in CLI login on the
 * machine, listing and selection work and the first request fails loud with
 * `MISSING_CREDENTIAL`, the same posture as a shipped API-key route whose
 * key was never stored.
 *
 * @module @shres-code/shres-code-llm-claude-session
 */

import type { Context } from '@shres-code/cordis'
import { ClaudeSessionManager } from '@shres-code/shres-code-claude-credential'
import { LlmError } from '@shres-code/shres-code-llm'
import type {
  AdapterRegistrationHandle,
  DirectoryRegistrationHandle,
  LlmConfigurableProvider,
} from '@shres-code/shres-code-llm'
import { PiAiAdapter, resolveProfiles } from '@shres-code/shres-code-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@shres-code/shres-code-llm-pi-ai'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@shres-code/shres-code-settings'
import {
  CLAUDE_SESSION_PROVIDER_ID,
  Config,
  PROMPT_CACHE_TTL_MS,
  resolveCredentialSpec,
  resolveRoute,
} from './config.ts'
import type { CredentialSpec } from './config.ts'

export {
  CLAUDE_SESSION_PROVIDER_ID,
  Config,
  DEFAULT_BASE_URL,
  DEFAULT_CACHE_RETENTION,
  DEFAULT_DISPLAY_NAME,
  DEFAULT_REFRESH_LEEWAY_MS,
  PROMPT_CACHE_TTL_MS,
  SHIPPED_MODELS,
  defaultAuthPath,
  resolveCredentialSpec,
  resolveRoute,
} from './config.ts'
export type { ClaudeSessionCacheRetention, ClaudeSessionModelConfig } from './config.ts'
export { ClaudeSessionManager, KEYCHAIN_SERVICE, TOKEN_URL, selectSessionEntry } from '@shres-code/shres-code-claude-credential'
export type { ClaudeSessionEntry, ClaudeSessionOptions, ClaudeSessionToken } from '@shres-code/shres-code-claude-credential'

export const name = 'llm-claude-session'
export const inject = ['llm']

const NS = settingsNamespace('llm-claude-session')

/**
 * The registry captures these per route; a change here must re-register.
 * The credential facts are deliberately absent: the adapter instance is
 * stable and reads the current section per request, so a credential-source
 * change reaches the next request without touching the registry.
 * @param current - read of the current section value.
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
    // Model metadata declares the lifetime this retention requests, so a
    // change republishes the route for listings to refresh.
    cacheRetention: route.cacheRetention,
  }
}

/**
 * The memoization key for one credential spec, shared by this plugin's local
 * fallback and the managers the shared service hands back: two specs agreeing
 * on every source fact share one in-flight resolve.
 * @param spec - the credential spec.
 * @returns the key under which one manager is reused.
 */
function credentialKey(spec: CredentialSpec): string {
  return [
    spec.useKeychain ? 'keychain' : 'file',
    spec.securityPath,
    spec.authPath,
    spec.keychainAccount,
    String(spec.refreshLeewayMs),
  ].join('\u0000')
}

/**
 * The credential hook: a session manager keyed by the credential facts it was
 * built with, rebuilt only when they change. Keying preserves the
 * single-flight refresh across requests while a live section read moves the
 * store, the keychain account, or the leeway. The shared claude-credential
 * service owns the memoization when the composition mounts it; a local
 * fallback with the same keying covers compositions that only boot this
 * adapter.
 * @param ctx - context carrying the optional claude-credential service.
 * @returns the manager for a resolved credential spec.
 */
function createCredentialResolver(ctx: Context): (spec: CredentialSpec) => ClaudeSessionManager {
  const local = new Map<string, ClaudeSessionManager>()
  return (spec) => {
    // Re-read the shared service each request so a composition that mounts it
    // after startup (or unloads it) is honored without a captured reference.
    const service = ctx.get('claudeCredential')
    if (service !== undefined) return service.managerFor(spec)
    const key = credentialKey(spec)
    let manager = local.get(key)
    if (manager === undefined) {
      manager = new ClaudeSessionManager(spec)
      local.set(key, manager)
    }
    return manager
  }
}

/**
 * Build the adapter over the one resolved route, with the credential hook
 * owned here and everything else delegated to the shared pi-ai adapter. The
 * instance is built once and stays registered: every config fact it depends on
 * is read live per request.
 * @param ctx - context carrying attachments and the logger.
 * @param current - read of the current section value.
 * @param managerFor - the credential-fact resolver for {@link createCredentialResolver}.
 * @param profiles - memoized resolved-profile read.
 * @returns the adapter instance.
 */
function buildAdapter(
  ctx: Context,
  current: () => Config,
  managerFor: (spec: CredentialSpec) => ClaudeSessionManager,
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>,
): PiAiAdapter {
  return new PiAiAdapter({
    profiles,
    resolveApiKey: async () => {
      const manager = managerFor(resolveCredentialSpec(current()))
      try {
        return (await manager.current()).accessToken
      } catch (error) {
        if (error instanceof LlmError) throw error
        throw new LlmError(
          `llm-claude-session: reading the Claude Code session failed: ${String(error)}`,
          'MISSING_CREDENTIAL',
        )
      }
    },
    resolveAttachments: () => ctx.get('attachments'),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(
        `llm-claude-session: unusable replay state on assistant history for route "${provider}/${model}";`
        + ` sending that message as provider-neutral content (${reason})`,
      )
    },
    // Every model on the route requests the section's one retention.
    promptCacheTtlMs: () => PROMPT_CACHE_TTL_MS[resolveRoute(current()).cacheRetention],
  })
}

/**
 * Register the Claude subscription-session route.
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
    const next = resolveProfiles({ [CLAUDE_SESSION_PROVIDER_ID]: resolveRoute(raw) })
    lastRaw = raw
    memoized = next
    return next
  }
  profiles()
  // Fail loud at mount for a self-contained misconfiguration, the same set
  // the settings validator refuses at write time below.
  resolveCredentialSpec(current())

  // The credential hook resolves through the shared service when present and
  // falls back to the local single-flight manager otherwise.
  const managerFor = createCredentialResolver(ctx)

  // One adapter for the plugin's whole life: the registry binds the instance
  // at register time, so every config fact is read live instead.
  const adapter = buildAdapter(ctx, () => current(), managerFor, profiles)

  const directoryEntry = (): LlmConfigurableProvider => ({
    provider: CLAUDE_SESSION_PROVIDER_ID,
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
      registration = ctx.llm.registerAdapter([CLAUDE_SESSION_PROVIDER_ID], adapter)
    } else {
      registration.replace(enabled ? [CLAUDE_SESSION_PROVIDER_ID] : [])
    }
    registeredFacts = facts
  }
  ensureRegistrationFacts()

  installSettingsSection(ctx, NS, Config, config as never, {
    validate: (section: Config) => {
      resolveRoute(section)
      resolveCredentialSpec(section)
    },
    setSource: (source) => { current = () => source() },
    onChange: () => {
      ensureDirectory()
      ensureRegistrationFacts()
    },
  })
}
/* jscpd:ignore-end */
