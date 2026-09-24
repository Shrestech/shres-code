/**
 * Plugin configuration and the one provider route it resolves. The route
 * reuses shres-llm-pi-ai's profile resolution wholesale — a hand-declared
 * `anthropic-messages` route over api.anthropic.com — so a bad model entry or
 * capacity fails with the same named diagnostics any pi-ai route produces, and
 * the built provider is the one that package would serve.
 * @module @shres-code/shres-code-llm-claude-session/config
 */

import { userInfo } from 'node:os'
import z from '@shres-code/schemastery'
import { defaultAuthPath, DEFAULT_SECURITY_PATH } from '@shres-code/shres-code-claude-credential'
import type { PiAiModality, PiAiProviderProfile } from '@shres-code/shres-code-llm-pi-ai'

// The engine's own store helper, re-exported so this package's route surface
// names one credential path rather than keeping a second copy of it.
export { defaultAuthPath }

/** Route id this adapter registers under. */
export const CLAUDE_SESSION_PROVIDER_ID = 'claude-session'

/** Anthropic API host the CLI's subscription login dispatches against. */
export const DEFAULT_BASE_URL = 'https://api.anthropic.com'

/** Display name selectors show. */
export const DEFAULT_DISPLAY_NAME = 'Claude (subscription)'

/** Refresh when the token is at or within this distance of its expiry. */
export const DEFAULT_REFRESH_LEEWAY_MS = 300_000

/**
 * Reasoning efforts the subscription models accept, in pi-ai's escalation
 * order. `off` stays undeclared: the live 5.x models reject
 * `thinking: {type: "disabled"}` and require adaptive thinking, so pinning
 * `off` unsupported keeps that parameter off the wire. `minimal` stays
 * undeclared too — the wire has no effort for it, and pi-ai's fallback would
 * alias it to `low`.
 */
const SHIPPED_REASONING_EFFORTS = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

/**
 * Models the subscription served when this catalog shipped: capacities and
 * the adaptive-thinking requirement as pi-ai's Anthropic catalog records them
 * for the 5 generation, with `claude-opus-5-5` added from the live
 * `GET /v1/models` catalog (display name "Claude Opus 5.5", the same 1,000,000 /
 * 128,000 capacities, adaptive thinking only). A release this list has not
 * caught up with is a settings `models` entry, not a code change.
 */
export const SHIPPED_MODELS: readonly ClaudeSessionModelConfig[] = [
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    input: ['text', 'image'],
    // The live model rejects budget thinking and, like Opus past 4.5, a stated
    // temperature. Adaptive thinking with an effort is the only thinking mode.
    compat: { forceAdaptiveThinking: true, supportsTemperature: false },
  },
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    input: ['text', 'image'],
    // Opus past 4.5 rejects a request that states a temperature, and every
    // adaptive-thinking model reads an effort instead of a token budget.
    compat: { forceAdaptiveThinking: true, supportsTemperature: false },
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    input: ['text', 'image'],
    compat: { forceAdaptiveThinking: true },
  },
]

/** One advisory model entry a deployment may declare. */
export interface ClaudeSessionModelConfig {
  /** Model id the subscription accepts. */
  id: string
  /** Selector label; defaults to the id. */
  name?: string
  /** Maximum combined request and response context in tokens. */
  contextWindow?: number
  /** Maximum output tokens; configuring one also makes it the request default. */
  maxTokens?: number
  /**
   * Request modalities this model accepts; absent keeps the text floor. The
   * shipped models serve image input, so their entries declare
   * `['text', 'image']`, which is what admits image blocks.
   */
  input?: PiAiModality[]
  /**
   * Anthropic request-format switches for this model: adaptive thinking when
   * its upstream requires it, and no `temperature` when it rejects one. A
   * hand-declared route inherits no pi-ai catalog metadata, so these are the
   * only way its models state what the catalog records for Anthropic's own.
   */
  compat?: {
    /** Whether the model requires adaptive thinking instead of a token budget. */
    forceAdaptiveThinking?: boolean
    /** Whether the model accepts the `temperature` request field. */
    supportsTemperature?: boolean
  }
}

/** Plugin / settings section configuring the one route. */
export interface Config {
  /** When false, the route is omitted from the live adapter registry. Defaults to on. */
  enabled?: boolean
  /** Credential document path, used where the login keychain is not read. */
  authPath?: string
  /** macOS security tool path for the keychain credential source. */
  securityPath?: string
  /** Keychain account a rotation writes its item under; defaults to the OS user name. */
  keychainAccount?: string
  /** Read the login keychain instead of the credential document. Defaults to true on macOS. */
  useKeychain?: boolean
  /** Endpoint base for the API host; defaults to `DEFAULT_BASE_URL`. */
  baseURL?: string
  /** Selector label; defaults to `DEFAULT_DISPLAY_NAME`. */
  displayName?: string
  /** Model catalog; defaults to `SHIPPED_MODELS`. */
  models?: ClaudeSessionModelConfig[]
  /** Refresh leeway in milliseconds; defaults to `DEFAULT_REFRESH_LEEWAY_MS`. */
  refreshLeewayMs?: number
}

// Mirrors pi-ai's modality gate (text|image); a pi-ai modality drift fails
// the profile layer's own Record gate before this copy can go stale silently.
const inputModalitySchema = z.union([z.const('text' as const), z.const('image' as const)])

const modelSchema = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  input: z.array(inputModalitySchema),
  compat: z.object({
    forceAdaptiveThinking: z.boolean(),
    supportsTemperature: z.boolean(),
  }),
})

/**
 * Runtime schema for {@link Config}. The section declares no `headers`: pi-ai
 * merges the OAuth header set — the Claude Code betas, the pinned CLI
 * user-agent, `x-app` — with configured ones later-wins, so a route header
 * would replace the beta set the subscription login needs rather than add to
 * it.
 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  authPath: z.string(),
  securityPath: z.string(),
  keychainAccount: z.string(),
  // No default: the platform decides in resolveCredentialSpec, where the
  // choice is explicit, and an absent field must stay absent.
  useKeychain: z.boolean(),
  baseURL: z.string(),
  displayName: z.string(),
  // Absent must stay absent: schemastery would otherwise materialize [] for
  // an omitted list, and an empty list reads as a typed refusal to serve any
  // model rather than "use the shipped catalog".
  models: z.array(modelSchema).default(undefined as unknown as never),
  refreshLeewayMs: z.number().step(1).min(0),
})

/** One resolved credential-source spec. */
export interface CredentialSpec {
  /** Whether the login keychain holds the credential. */
  useKeychain: boolean
  /** macOS security tool path for the keychain source. */
  securityPath: string
  /** Credential document path, read when the keychain is not. */
  authPath: string
  /** Keychain account a rotation writes its item under. */
  keychainAccount: string
  /** Refresh leeway in milliseconds. */
  refreshLeewayMs: number
}

/**
 * Resolve the credential-source facts of the section, with every default
 * decided here rather than inline at use sites.
 * @param config - composition or settings section value.
 * @returns the credential spec the session manager runs with.
 */
export function resolveCredentialSpec(config: Config): CredentialSpec {
  const refreshLeewayMs = config.refreshLeewayMs ?? DEFAULT_REFRESH_LEEWAY_MS
  if (!Number.isFinite(refreshLeewayMs) || refreshLeewayMs < 0) {
    throw new Error('llm-claude-session: refreshLeewayMs must be a non-negative finite number')
  }
  return {
    // The Claude Code CLI's own split: the login keychain on macOS, its
    // credential document everywhere else.
    useKeychain: config.useKeychain ?? process.platform === 'darwin',
    securityPath: config.securityPath ?? DEFAULT_SECURITY_PATH,
    keychainAccount: config.keychainAccount ?? userInfo().username,
    authPath: config.authPath ?? defaultAuthPath(),
    refreshLeewayMs,
  }
}

/**
 * Resolve the section into the one route's profile, with every deployment
 * default decided here rather than inline at use sites. The profile declares
 * no `headers`: pi-ai owns the OAuth header set, and a route header would
 * replace its betas instead of adding to them (see {@link Config}).
 * @param config - composition or settings section value.
 * @returns the profile shres-llm-pi-ai's resolution validates and builds.
 */
export function resolveRoute(config: Config): Omit<PiAiProviderProfile, 'displayName'> & { displayName: string } {
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL
  if (baseURL.length === 0) throw new Error('llm-claude-session: baseURL must be non-empty when set')
  const models = config.models ?? SHIPPED_MODELS
  if (models.length === 0) throw new Error('llm-claude-session: models must list at least one model')
  return {
    displayName: config.displayName ?? DEFAULT_DISPLAY_NAME,
    api: 'anthropic-messages',
    // Anthropic Messages reports cache reads and writes in every usage block.
    cacheUsage: 'reported',
    baseURL,
    models: models.map(model => ({
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.input === undefined ? {} : { input: [...model.input] }),
      reasoningEfforts: { ...SHIPPED_REASONING_EFFORTS },
      ...(model.compat === undefined ? {} : { compat: { ...model.compat } }),
    })),
  }
}
