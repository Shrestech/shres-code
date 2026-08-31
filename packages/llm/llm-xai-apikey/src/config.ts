/**
 * Plugin configuration and the one provider route it resolves. The route
 * reuses shres-llm-pi-ai's profile resolution wholesale, a hand-declared
 * openai-responses route against xAI's pay-per-token API (api.x.ai): a bad
 * model entry or capacity fails with the same named diagnostics any pi-ai
 * route produces, and the built provider is the one that package would
 * serve. The route ships off by default: no request is served until a
 * deployment enables it and stores a key through the credentials seam.
 *
 * @module @shres-code/shres-code-llm-xai-apikey/config
 */

import z from '@shres-code/schemastery'
import type { PiAiModality, PiAiProviderProfile } from '@shres-code/shres-code-llm-pi-ai'

/** Route id this adapter registers under. */
export const XAI_PROVIDER_ID = 'xai-apikey'

/** Pay-per-token X API endpoint the route serves. */
export const DEFAULT_BASE_URL = 'https://api.x.ai/v1'

/** Display name selectors show. */
export const DEFAULT_DISPLAY_NAME = 'xAI (pay-per-token)'

/** Default credential reference: the environment-variable name the key is stored under. */
export const DEFAULT_API_KEY_ENV = 'XAI_API_KEY'

/**
 * Service tiers the xAI Responses wire accepts. The underlying API enum,
 * extracted from the Grok CLI's generated request types (async-openai's
 * responses.ServiceTier), is auto / default / flex / scale / priority; this
 * route exposes only the two that map cleanly to a per-request choice,
 * because auto is server-side project policy and flex / scale are a separate
 * pricing track. default omits the field entirely (parity with the Grok
 * CLI, which never sends it); priority splices service_tier: priority to
 * opt into priority processing, which raises scheduling priority (lower
 * TTFT/ITL) and is billed differently.
 */
export const SERVICE_TIERS = ['default', 'priority'] as const

/** One selectable per-model service tier. */
export type ServiceTier = typeof SERVICE_TIERS[number]

/**
 * Models the X API served when this catalog shipped. A release this list
 * has not caught up with is a settings models entry, not a code change.
 * Every shipped model serves the default tier, matching the Grok CLI.
 */
export const SHIPPED_MODELS: readonly XaiModelConfig[] = [
  { id: 'grok-4.6', name: 'Grok 4.6', contextWindow: 500_000 },
  { id: 'grok-4.5', name: 'Grok 4.5', contextWindow: 500_000 },
  { id: 'grok-4.5-mini', name: 'Grok 4.5 Mini', contextWindow: 262_144 },
  { id: 'grok-4.5-vision', name: 'Grok 4.5 Vision', contextWindow: 500_000, input: ['text', 'image'] },
]

/** One advisory model entry a deployment may declare. */
export interface XaiModelConfig {
  /** Model id the X API accepts. */
  id: string
  /** Selector label; defaults to the id. */
  name?: string
  /** Maximum combined request and response context in tokens. */
  contextWindow?: number
  /** Maximum output tokens; configuring one also makes it the request default. */
  maxTokens?: number
  /**
   * Request modalities this model accepts; absent keeps the text floor. A
   * deployment serving a vision-capable Grok model declares image here,
   * which is what admits image blocks.
   */
  input?: PiAiModality[]
  /**
   * Serve tier for this model. default (the default) omits service_tier
   * from the request body; priority splices it in and is billed differently.
   */
  serviceTier?: ServiceTier
}

/** Plugin / settings section configuring the one route. */
export interface Config {
  /**
   * When false (or omitted), the route is omitted from the live adapter
   * registry. This route ships off by default: it is pay-per-token and
   * needs an explicit key, so nothing serves until a deployment turns it on.
   */
  enabled?: boolean
  /** Credential reference (env var) resolved per request; defaults to XAI_API_KEY. */
  apiKeyEnv?: string
  /** Endpoint base for the X API; defaults to DEFAULT_BASE_URL. */
  baseURL?: string
  /** Selector label; defaults to DEFAULT_DISPLAY_NAME. */
  displayName?: string
  /** Model catalog; defaults to SHIPPED_MODELS. */
  models?: XaiModelConfig[]
}

const MODEL_MODALITIES = ['text', 'image'] as const

const modelSchema = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  // Defaulting to the text floor keeps an absent list from materializing []
  // (which would read as a typed refusal), while an explicit empty list still
  // refuses below.
  input: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text']),
  serviceTier: z.union(SERVICE_TIERS).default('default'),
})

/** Runtime schema for Config. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  displayName: z.string(),
  // Absent must stay absent: schemastery would otherwise materialize [] for
  // an omitted list, and an empty list reads as a typed refusal to serve any
  // model rather than use the shipped catalog.
  models: z.array(modelSchema).default(undefined as unknown as never),
})

/** One resolved credential-source spec. */
export interface CredentialSpec {
  /** Credential reference this adapter resolves each request. */
  apiKeyEnv: string
}

/**
 * Resolve the credential-source facts of the section, with every default
 * decided here rather than inline at use sites.
 * @param config - composition or settings section value.
 * @returns the credential spec the request path resolves the key under.
 */
export function resolveCredentialSpec(config: Config): CredentialSpec {
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  if (apiKeyEnv.trim().length === 0) {
    throw new Error('llm-xai-apikey: apiKeyEnv must be non-empty when set')
  }
  return { apiKeyEnv }
}

/**
 * Resolve the section into the one route's profile, with every deployment
 * default decided here rather than inline at use sites.
 * @param config - composition or settings section value.
 * @returns the profile shres-llm-pi-ai's resolution validates and builds.
 */
export function resolveRoute(config: Config): Omit<PiAiProviderProfile, 'displayName'> & { displayName: string } {
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL
  if (baseURL.length === 0) throw new Error('llm-xai-apikey: baseURL must be non-empty when set')
  const models = config.models ?? SHIPPED_MODELS
  if (models.length === 0) throw new Error('llm-xai-apikey: models must list at least one model')
  for (const model of models) {
    if (model.id.length === 0) throw new Error('llm-xai-apikey: model ids must be non-empty')
    if (model.serviceTier !== undefined && !SERVICE_TIERS.includes(model.serviceTier)) {
      throw new Error(
        'llm-xai-apikey: model "' + model.id + '" serviceTier must be one of ' + SERVICE_TIERS.join(', '),
      )
    }
  }
  return {
    displayName: config.displayName ?? DEFAULT_DISPLAY_NAME,
    api: 'openai-responses',
    baseURL,
    /* jscpd:ignore-start -- the optional-field map is the reviewed pi-ai
       profile-shape contract grok-session's resolveRoute also spells; extracting
       it would couple the two routes' model semantics. */
    models: models.map(model => ({
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.input === undefined ? {} : { input: [...model.input] }),
    })),
    /* jscpd:ignore-end */
  }
}

/**
 * The service tier one model serves, decided from the live section so a
 * settings change reaches the next request.
 * @param config - composition or settings section value.
 * @param modelId - the model id the outgoing request names.
 * @returns the tier, defaulting to default for an unknown model.
 */
export function serviceTierForModel(config: Config, modelId: string): ServiceTier {
  const models = config.models ?? SHIPPED_MODELS
  for (const model of models) {
    if (model.id === modelId) return model.serviceTier ?? 'default'
  }
  return 'default'
}

/**
 * Splice service_tier into an outgoing request body when the tier opts out
 * of the default. The default tier is omitted entirely, matching the Grok
 * CLI, which never sends the field. A non-object payload (a request type
 * pi-ai serializes to something else) is left untouched.
 * @param payload - the provider request body pi-ai built.
 * @param tier - the resolved service tier for this model.
 */
export function applyServiceTier(payload: unknown, tier: ServiceTier): void {
  if (tier === 'default') return
  if (payload === null || typeof payload !== 'object') return
  ;(payload as Record<string, unknown>).service_tier = tier
}
