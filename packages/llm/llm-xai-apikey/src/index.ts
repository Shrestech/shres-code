/**
 * Pay-per-token xAI API-key adapter plugin. Registers one provider route,
 * `xai-apikey`, that serves https://api.x.ai/v1 over the `openai-responses`
 * wire: the transport, streaming, tool, reasoning, and replay machinery are
 * the shared shres-llm-pi-ai adapter, and this plugin owns only the route
 * config — the endpoint, model catalog, each model's service tier, and the
 * credential reference resolved per request through the credentials seam.
 *
 * The route is orthogonal to the Grok subscription path: there is no
 * ~/.grok/auth.json, no OIDC, and no cli-chat-proxy involvement. It is
 * pay-per-token and ships off by default. Enabling it without a stored key
 * leaves selection working while the first request fails loud with
 * `MISSING_CREDENTIAL`, the same posture as any shipped API-key route whose
 * key was never stored.
 *
 * @module @shres-code/shres-code-llm-xai-apikey
 */

import type { Context } from '@shres-code/cordis'
import { assertUsableApiKey, LlmError } from '@shres-code/shres-code-llm'
import type {
  AdapterRegistrationHandle,
  DirectoryRegistrationHandle,
  LlmConfigurableProvider,
} from '@shres-code/shres-code-llm'
import { PiAiAdapter, resolveProfiles } from '@shres-code/shres-code-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@shres-code/shres-code-llm-pi-ai'
import { credentialRef } from '@shres-code/shres-code-credentials'
import { launchEnvironmentOf } from '@shres-code/shres-code-launch-environment'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@shres-code/shres-code-settings'
import {
  Config,
  XAI_PROVIDER_ID,
  applyServiceTier,
  resolveCredentialSpec,
  resolveRoute,
  serviceTierForModel,
} from './config.ts'

export {
  Config,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_DISPLAY_NAME,
  SERVICE_TIERS,
  SHIPPED_MODELS,
  XAI_PROVIDER_ID,
  applyServiceTier,
  resolveCredentialSpec,
  resolveRoute,
  serviceTierForModel,
} from './config.ts'
export type { CredentialSpec, ServiceTier, XaiModelConfig } from './config.ts'

export const name = 'llm-xai-apikey'
export const inject = ['llm']

const NS = settingsNamespace('llm-xai-apikey')

/**
 * The registry captures these per route; a change here must re-register.
 * The credential facts are deliberately absent: the adapter instance is
 * stable and reads the current section per request, so an apiKeyEnv or
 * baseURL change reaches the next request without touching the registry.
 * @param current - read of the current section value.
 * @returns a stable registration key.
 */
function registrationFacts(current: () => Config): unknown {
  const route = resolveRoute(current())
  return {
    // The settings schema defaults enabled to false, so the section value is
    // always a boolean here; a bare entry that omits it reads as off, too.
    enabled: current().enabled === true,
    displayName: route.displayName,
    baseURL: route.baseURL,
    modelIds: current().models?.map(model => model.id),
  }
}

/**
 * Resolve the credential for the current config through the credentials seam
 * (the env/.env provider is the shipped backing store), falling back to the
 * trusted launch environment when no seam is mounted. A miss fails loud with
 * `MISSING_CREDENTIAL`, the established dormant-without-key posture.
 * @param ctx - context carrying the optional credentials service.
 * @param current - read of the current section value.
 * @returns the resolved API key.
 */
async function resolveApiKey(ctx: Context, current: () => Config): Promise<string> {
  const apiKeyEnv = resolveCredentialSpec(current()).apiKeyEnv
  const ref = credentialRef(apiKeyEnv)
  const credentials = ctx.get('credentials')
  const hit = credentials !== undefined
    ? (await credentials.resolve(ref))?.value
    : launchEnvironmentOf(ctx).get(ref)?.value
  if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, 'llm-xai-apikey', ref)
  throw new LlmError(
    'llm-xai-apikey: no API key for provider route "' + XAI_PROVIDER_ID + '"; store '
    + apiKeyEnv + ' through the credentials service (the web Models page writes it), or export '
    + apiKeyEnv + ' in the launching environment',
    'MISSING_CREDENTIAL',
  )
}

/**
 * Build the adapter over the one resolved route, with the credential and
 * service-tier hooks owned here and everything else delegated to the shared
 * pi-ai adapter. The instance is built once and stays registered: every
 * config fact it depends on is read live per request.
 * @param ctx - context carrying attachments and the logger.
 * @param current - read of the current section value.
 * @param profiles - memoized resolved-profile read.
 * @returns the adapter instance.
 */
function buildAdapter(
  ctx: Context,
  current: () => Config,
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>,
): PiAiAdapter {
  return new PiAiAdapter({
    profiles,
    resolveApiKey: async () => resolveApiKey(ctx, current),
    // Splice service_tier onto the outgoing body only for a model whose tier
    // opts out of the default; the default tier never sends the field.
    onPayload: (payload, request) => {
      applyServiceTier(payload, serviceTierForModel(current(), request.model))
    },
    resolveAttachments: () => ctx.get('attachments'),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(
        'llm-xai-apikey: unusable replay state on assistant history for route "' + provider + '/' + model
        + '"; sending that message as provider-neutral content (' + reason + ')',
      )
    },
  })
}

/**
 * Register the xAI API-key route. The route ships off by default and is
 * registered the moment a deployment enables it; without a stored key the
 * first request fails loud with `MISSING_CREDENTIAL`.
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
    const next = resolveProfiles({ [XAI_PROVIDER_ID]: resolveRoute(raw) })
    lastRaw = raw
    memoized = next
    return next
  }
  profiles()
  // Fail loud at mount for a self-contained misconfiguration, the same set
  // the settings validator refuses at write time below.
  resolveCredentialSpec(current())

  const adapter = buildAdapter(ctx, () => current(), profiles)

  const directoryEntry = (): LlmConfigurableProvider => ({
    provider: XAI_PROVIDER_ID,
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
    // Off by default: the route is omitted from the live registry until a
    // deployment enables it. A bare entry that omits enabled reads as off.
    const enabled = current().enabled === true
    if (registration === undefined) {
      if (!enabled) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter([XAI_PROVIDER_ID], adapter)
    } else {
      registration.replace(enabled ? [XAI_PROVIDER_ID] : [])
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
