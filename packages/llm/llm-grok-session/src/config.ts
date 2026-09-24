/**
 * Plugin configuration and the one provider route it resolves. The route
 * reuses shres-llm-pi-ai's profile resolution wholesale — a hand-declared
 * `openai-responses` route over the Grok subscription proxy — so a bad model
 * entry or capacity fails with the same named diagnostics any pi-ai route
 * produces, and the built provider is the one that package would serve.
 * @module @shres-code/shres-code-llm-grok-session/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@shres-code/schemastery'
import type { PiAiHostedTools, PiAiModality, PiAiProviderProfile } from '@shres-code/shres-code-llm-pi-ai'

/** Route id this adapter registers under. */
export const GROK_SESSION_PROVIDER_ID = 'grok-session'

/** Subscription proxy the Grok Build CLI itself dispatches against. */
export const DEFAULT_BASE_URL = 'https://cli-chat-proxy.grok.com/v1'

/** Display name selectors show. */
export const DEFAULT_DISPLAY_NAME = 'Grok (subscription)'

/**
 * Default auth document: the Grok Build CLI's own session store.
 * @returns the absolute path of `~/.grok/auth.json` for the current user.
 */
export function defaultAuthPath(): string {
  return join(homedir(), '.grok', 'auth.json')
}

/** Refresh when the token is at or within this distance of its expiry. */
export const DEFAULT_REFRESH_LEEWAY_MS = 300_000

/**
 * Reasoning efforts the proxy's models accept, in pi-ai's escalation order.
 * `off` stays undeclared: the proxy documents no effort-less mode, so the
 * map pins it unsupported instead of letting dispatch send nothing.
 */
const SHIPPED_REASONING_EFFORTS = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
}

/**
 * Models the subscription proxy served when this catalog shipped
 * (contextWindow from the CLI's own models cache). A release this list has
 * not caught up with is a settings ``models`` entry, not a code change.
 */
export const SHIPPED_MODELS: readonly GrokSessionModelConfig[] = [
  { id: 'grok-4.6', name: 'Grok 4.6', contextWindow: 500_000, input: ['text', 'image'] },
  { id: 'grok-4.5', name: 'Grok 4.5', contextWindow: 500_000, input: ['text', 'image'] },
]

/**
 * CLI generation the advertised version defaults to. The proxy requires
 * the CLI header set (x-grok-client-version with X-XAI-Token-Auth and
 * x-grok-client-identifier) and floors the reported version at its
 * current minimum, answering 426 'Your Grok CLI version (none) is
 * outdated' without them; this default tracks the CLI generation this
 * package was built against, and a proxy floor bump is a settings
 * cliVersion entry, not a code change.
 */
export const DEFAULT_CLI_VERSION = '1.0.13'

/** One advisory model entry a deployment may declare. */
export interface GrokSessionModelConfig {
  /** Model id the proxy accepts. */
  id: string
  /** Selector label; defaults to the id. */
  name?: string
  /** Maximum combined request and response context in tokens. */
  contextWindow?: number
  /** Maximum output tokens; configuring one also makes it the request default. */
  maxTokens?: number
  /**
   * Request modalities this model accepts; absent keeps the text floor. A
   * deployment serving a vision-capable Grok model declares
   * `['text', 'image']` here, which is what admits image blocks.
   */
  input?: PiAiModality[]
}

/** Plugin / settings section configuring the one route. */
export interface Config {
  /** When false, the route is omitted from the live adapter registry. Defaults to on. */
  enabled?: boolean
  /** Auth document path; defaults to `~/.grok/auth.json`. */
  authPath?: string
  /** Endpoint base for the proxy; defaults to {@link DEFAULT_BASE_URL}. */
  baseURL?: string
  /** Selector label; defaults to {@link DEFAULT_DISPLAY_NAME}. */
  displayName?: string
  /** Model catalog; defaults to {@link SHIPPED_MODELS}. */
  models?: GrokSessionModelConfig[]
  /** Refresh leeway in milliseconds; defaults to {@link DEFAULT_REFRESH_LEEWAY_MS}. */
  refreshLeewayMs?: number
  /** CLI version the route advertises; defaults to {@link DEFAULT_CLI_VERSION}. */
  cliVersion?: string
  /**
   * Serve web search as a hosted backend tool instead of the local `tool-web`
   * tool for this route. Defaults to off; when on, the colliding local
   * `web_search` function tool is dropped from the request (hosted wins).
   */
  hostedWebSearch?: boolean
  /** Serve X (Twitter) search as a hosted backend tool. Defaults to off. */
  hostedXSearch?: boolean
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
})

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  authPath: z.string(),
  baseURL: z.string(),
  displayName: z.string(),
  // Absent must stay absent: schemastery would otherwise materialize `[]`
  // for an omitted list, and an empty list reads as a typed refusal to serve
  // any model rather than "use the shipped catalog".
  models: z.array(modelSchema).default(undefined as unknown as never),
  refreshLeewayMs: z.number().step(1).min(0),
  cliVersion: z.string(),
  hostedWebSearch: z.boolean().default(true),
  hostedXSearch: z.boolean().default(true),
})

/**
 * One resolved credential-source spec.
 */
export interface CredentialSpec {
  /** Auth document path this adapter reads and refreshes. */
  authPath: string
  /** Refresh leeway in milliseconds. */
  refreshLeewayMs: number
}

/**
 * Resolve the section's hosted-tool switches into the profile declaration the
 * shared adapter enforces, failing loud on a value the boundary cannot serve.
 * A section comes through composition JSON as well as the typed settings
 * schema, so a non-boolean switch is refused here rather than silently
 * treated as off. Both switches default on, matching the Grok CLI's own
 * sampler: the proxy's models reach their freshest with both hosted tools.
 * @param config - composition or settings section value.
 * @returns the hosted-tool switches the route profile declares.
 */
export function resolveHostedTools(config: Config): PiAiHostedTools {
  const source = config as unknown as Record<string, unknown>
  for (const field of ['hostedWebSearch', 'hostedXSearch'] as const) {
    const value = source[field]
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`llm-grok-session: ${field} must be a boolean`)
    }
  }
  return {
    webSearch: config.hostedWebSearch ?? true,
    xSearch: config.hostedXSearch ?? true,
  }
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
    throw new Error('llm-grok-session: refreshLeewayMs must be a non-negative finite number')
  }
  return {
    authPath: config.authPath ?? defaultAuthPath(),
    refreshLeewayMs,
  }
}

/**
 * Resolve the section into the one route's profile, with every deployment
 * default decided here rather than inline at use sites.
 * @param config - composition or settings section value.
 * @returns the profile shres-llm-pi-ai's resolution validates and builds.
 */
export function resolveRoute(config: Config): Omit<PiAiProviderProfile, 'displayName'> & { displayName: string } {
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL
  if (baseURL.length === 0) throw new Error('llm-grok-session: baseURL must be non-empty when set')
  const models = config.models ?? SHIPPED_MODELS
  if (models.length === 0) throw new Error('llm-grok-session: models must list at least one model')
  const cliVersion = config.cliVersion ?? DEFAULT_CLI_VERSION
  if (cliVersion.trim().length === 0) throw new Error('llm-grok-session: cliVersion must be non-empty when set')
  return {
    displayName: config.displayName ?? DEFAULT_DISPLAY_NAME,
    api: 'openai-responses',
    // xAI's Responses endpoint reports cached input under input_tokens_details.
    cacheUsage: 'reported',
    baseURL,
    hostedTools: resolveHostedTools(config),
    headers: {
      'x-xai-token-auth': 'xai-grok-cli',
      'x-grok-client-version': cliVersion,
      'x-grok-client-identifier': 'grok-shell',
    },
    models: models.map(model => ({
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.input === undefined ? {} : { input: [...model.input] }),
      reasoningEfforts: { ...SHIPPED_REASONING_EFFORTS },
    })),
  }
}
