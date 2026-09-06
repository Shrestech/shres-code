/**
 * Codex subscription-session adapter plugin. Registers one provider route,
 * `codex-session`, that serves the ChatGPT backend's codex endpoint
 * (`chatgpt.com/backend-api/codex`) over the `openai-responses` wire with
 * the Codex CLI's ChatGPT-login credential: the transport, streaming, tool,
 * and replay machinery are the shared shres-llm-pi-ai adapter, and this
 * plugin owns only the credential — read from the CLI's auth document,
 * refreshed through the issuer's `refresh_token` grant, rotated values
 * persisted back for the CLI — plus the account header the backend routes
 * the subscription by.
 *
 * The route ships enabled and dormant: without a signed-in CLI login on the
 * machine, listing and selection work and the first request fails loud with
 * `MISSING_CREDENTIAL`, the same posture as a shipped API-key route whose
 * key was never stored.
 *
 * @module @shres-code/shres-code-llm-codex-session
 */

import type { Context } from '@shres-code/cordis'
import { LlmError } from '@shres-code/shres-code-llm'
import type {
  AdapterRegistrationHandle,
  DirectoryRegistrationHandle,
  LlmConfigurableProvider,
} from '@shres-code/shres-code-llm'
import { PiAiAdapter, resolveProfiles } from '@shres-code/shres-code-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@shres-code/shres-code-llm-pi-ai'
import { CodexSessionManager } from '@shres-code/shres-code-codex-credential'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@shres-code/shres-code-settings'
import {
  Config,
  CODEX_SESSION_PROVIDER_ID,
  resolveCredentialSpec,
  resolveRoute,
} from './config.ts'
import type { CredentialSpec } from './config.ts'

export {
  Config,
  CODEX_SESSION_PROVIDER_ID,
  DEFAULT_BASE_URL,
  DEFAULT_DISPLAY_NAME,
  DEFAULT_REFRESH_LEEWAY_MS,
  SHIPPED_MODELS,
  defaultAuthPath,
  resolveCredentialSpec,
  resolveRoute,
} from './config.ts'
export type { CodexSessionModelConfig } from './config.ts'
export {
  CLIENT_ID,
  CodexSessionManager,
  OIDC_ISSUER,
  TOKEN_URL,
  selectSessionEntry,
} from '@shres-code/shres-code-codex-credential'
export type { CodexSessionEntry, CodexSessionOptions, CodexSessionToken } from '@shres-code/shres-code-codex-credential'

export const name = 'llm-codex-session'
export const inject = ['llm']

const NS = settingsNamespace('llm-codex-session')

/**
 * The registry captures these per route; a change here must re-register.
 * The credential facts are deliberately absent: the adapter instance is
 * stable and reads the current section per request, so an auth-path or
 * leeway change reaches the next request without touching the registry.
 * @param config - current section value.
 * @returns a stable registration key.
 */
function registrationFacts(current: () => Config): unknown {
  const route = resolveRoute(current(), '')
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
 * document or the leeway. The shared codex-credential service owns the
 * memoization when the composition mounts it; a local fallback with the same
 * keying covers compositions that only boot this adapter.
 * @param ctx - context carrying the optional codex-credential service.
 * @returns the manager for a resolved credential spec.
 */
function createCredentialResolver(ctx: Context): (spec: CredentialSpec) => CodexSessionManager {
  const local = new Map<string, CodexSessionManager>()
  return (spec) => {
    // Re-read the shared service each request so a composition that mounts it
    // after startup (or unloads it) is honored without a captured reference.
    const service = ctx.get('codexCredential')
    if (service !== undefined) return service.managerFor(spec)
    const key = `${spec.authPath}\u0000${String(spec.refreshLeewayMs)}`
    let manager = local.get(key)
    if (manager === undefined) {
      manager = new CodexSessionManager(spec)
      local.set(key, manager)
    }
    return manager
  }
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
 * @param onAccount - receives the account id each credential resolve served,
 *   so the profile's account header tracks the document.
 * @returns the adapter instance.
 */
function buildAdapter(
  ctx: Context,
  current: () => Config,
  managerFor: (spec: CredentialSpec) => CodexSessionManager,
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  onAccount: (accountId: string) => void,
): PiAiAdapter {
  return new PiAiAdapter({
    profiles,
    resolveApiKey: async () => {
      const manager = managerFor(resolveCredentialSpec(current()))
      try {
        const token = await manager.current()
        onAccount(token.accountId)
        return token.accessToken
      } catch (error) {
        if (error instanceof LlmError) throw error
        throw new LlmError(
          `llm-codex-session: reading the Codex session failed: ${String(error)}`,
          'MISSING_CREDENTIAL',
        )
      }
    },
    resolveAttachments: () => ctx.get('attachments'),
    onPayload: (payload: unknown): unknown => {
      // The subscription backend rejects `max_output_tokens` outright
      // ("Unsupported parameter"), unlike the OpenAI API it descends from;
      // output caps are backend-owned on this wire, so the route strips the
      // parameter pi-ai's Responses transport derives from the model's size.
      if (typeof payload !== 'object' || payload === null) return undefined
      if (!('max_output_tokens' in payload)) return undefined
      const body: Record<string, unknown> = { ...(payload as Record<string, unknown>) }
      delete body['max_output_tokens']
      return body
    },
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(
        `llm-codex-session: unusable replay state on assistant history for route "${provider}/${model}";`
        + ` sending that message as provider-neutral content (${reason})`,
      )
    },
  })
}

/**
 * Register the Codex subscription-session route.
 * @param ctx - context carrying the llm service and optional settings.
 * @param config - composition entry; the settings section overlays it.
 */
/* jscpd:ignore-start -- deliberate lifecycle symmetry with llm-pi-ai's apply():
   the memoized-resolution, directory-entry, and registration-swap shape is the
   reviewed adapter-registration contract; extracting it would couple the two
   plugins' settings semantics. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  let current: () => Config = () => config
  // The account id the request header carries. Seeded from the document
  // below and kept current by every credential resolve; profiles rebuild
  // when it changes, because the header rides the profile.
  let accountId = ''
  let lastRaw: Config | undefined
  let lastAccountId: string | undefined
  let memoized: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  const profiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const raw = current()
    if (raw === lastRaw && accountId === lastAccountId && memoized !== undefined) return memoized
    const next = resolveProfiles({ [CODEX_SESSION_PROVIDER_ID]: resolveRoute(raw, accountId) })
    lastRaw = raw
    lastAccountId = accountId
    memoized = next
    return next
  }

  // Fail loud at mount for a self-contained misconfiguration, the same set
  // the settings validator refuses at write time below.
  resolveCredentialSpec(current())
  resolveRoute(current(), '')

  // The credential hook resolves through the shared service when present and
  // falls back to the local single-flight manager otherwise.
  const managerFor = createCredentialResolver(ctx)

  // Seed the account header from the document without refreshing anything:
  // the first request's profile snapshot is built before its credential
  // resolve runs, and a document that cannot serve one is that resolve's
  // error to report.
  accountId = await managerFor(resolveCredentialSpec(current())).peekAccountId()
  profiles()

  // One adapter for the plugin's whole life: the registry binds the instance
  // at register time, so every config fact is read live instead.
  const adapter = buildAdapter(ctx, () => current(), managerFor, profiles, (id) => { accountId = id })

  const directoryEntry = (): LlmConfigurableProvider => ({
    provider: CODEX_SESSION_PROVIDER_ID,
    displayName: resolveRoute(current(), accountId).displayName,
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
      registration = ctx.llm.registerAdapter([CODEX_SESSION_PROVIDER_ID], adapter)
    } else {
      registration.replace(enabled ? [CODEX_SESSION_PROVIDER_ID] : [])
    }
    registeredFacts = facts
  }
  ensureRegistrationFacts()

  installSettingsSection(ctx, NS, Config, config as never, {
    validate: (section: Config) => {
      resolveRoute(section, '')
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
