/**
 * Plugin configuration and the one provider route it resolves. The route
 * reuses shres-llm-pi-ai's profile resolution wholesale — a hand-declared
 * `openai-responses` route over the ChatGPT backend the Codex CLI itself
 * dispatches against — so a bad model entry or capacity fails with the same
 * named diagnostics any pi-ai route produces, and the built provider is the
 * one that package would serve.
 * @module @shres-code/shres-code-llm-codex-session/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@shres-code/schemastery'
import type { PiAiModality, PiAiProviderProfile } from '@shres-code/shres-code-llm-pi-ai'

/** Route id this adapter registers under. */
export const CODEX_SESSION_PROVIDER_ID = 'codex-session'

/** ChatGPT backend the Codex CLI itself dispatches against. */
export const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex'

/** Display name selectors show. */
export const DEFAULT_DISPLAY_NAME = 'Codex (subscription)'

/**
 * Default auth document: the Codex CLI's own session store.
 * @returns the absolute path of `~/.codex/auth.json` for the current user.
 */
export function defaultAuthPath(): string {
  return join(homedir(), '.codex', 'auth.json')
}

/** Refresh when the token is at or within this distance of its expiry. */
export const DEFAULT_REFRESH_LEEWAY_MS = 300_000

/**
 * Reasoning efforts the backend's models accept, in pi-ai's escalation
 * order. The wire set is `none`/`low`/`medium`/`high`/`xhigh`/`max`
 * (verified live: `minimal` is rejected); `off` and `minimal` stay
 * undeclared — a request without reasoning is the off mode, and `minimal`
 * has no honest wire spelling.
 */
const SHIPPED_REASONING_EFFORTS = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

/**
 * Models the subscription backend served when this catalog shipped
 * (modalities and the effort set verified live). A release this list has
 * not caught up with is a settings `models` entry, not a code change.
 *
 * `gpt-6-astra` names a window because the backend publishes none — `GET /models`
 * answers 400 and `GET /v1/models` 403 — and an undeclared window leaves
 * usage comparison and pressure policy on the adapter's fallback. 311,000 is a
 * deliberate lower bound: the session behind it (session-8bec6678, seq 52100)
 * completed a response reporting a 311,781-token prompt, which proves that much
 * served capacity without bounding it from above. Raise it through the settings
 * `models` entry as evidence accumulates. `gpt-5.6-luna` stays undeclared because
 * nothing observed bounds it.
 */
export const SHIPPED_MODELS: readonly CodexSessionModelConfig[] = [
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', contextWindow: 311_000, input: ['text', 'image'] },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', input: ['text', 'image'] },
]

/** One advisory model entry a deployment may declare. */
export interface CodexSessionModelConfig {
  /** Model id the backend accepts. */
  id: string
  /** Selector label; defaults to the id. */
  name?: string
  /** Maximum combined request and response context in tokens. */
  contextWindow?: number
  /** Maximum output tokens; configuring one also makes it the request default. */
  maxTokens?: number
  /**
   * Request modalities this model accepts; absent keeps the text floor. Both
   * shipped models serve image input (verified live), so the shipped
   * entries declare `['text', 'image']`, which is what admits image blocks.
   */
  input?: PiAiModality[]
}

/** Plugin / settings section configuring the one route. */
export interface Config {
  /** When false, the route is omitted from the live adapter registry. Defaults to on. */
  enabled?: boolean
  /** Auth document path; defaults to `~/.codex/auth.json`. */
  authPath?: string
  /** Endpoint base for the backend; defaults to {@link DEFAULT_BASE_URL}. */
  baseURL?: string
  /** Selector label; defaults to {@link DEFAULT_DISPLAY_NAME}. */
  displayName?: string
  /** Model catalog; defaults to {@link SHIPPED_MODELS}. */
  models?: CodexSessionModelConfig[]
  /** Refresh leeway in milliseconds; defaults to {@link DEFAULT_REFRESH_LEEWAY_MS}. */
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
 * Resolve the credential-source facts of the section, with every default
 * decided here rather than inline at use sites.
 * @param config - composition or settings section value.
 * @returns the credential spec the session manager runs with.
 */
export function resolveCredentialSpec(config: Config): CredentialSpec {
  const refreshLeewayMs = config.refreshLeewayMs ?? DEFAULT_REFRESH_LEEWAY_MS
  if (!Number.isFinite(refreshLeewayMs) || refreshLeewayMs < 0) {
    throw new Error('llm-codex-session: refreshLeewayMs must be a non-negative finite number')
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
 * @param accountId - ChatGPT account id the request header carries; empty
 *   keeps the route listable while no login exists (the request path fails
 *   loud before anything reaches the backend).
 * @returns the profile shres-llm-pi-ai's resolution validates and builds.
 */
export function resolveRoute(config: Config, accountId: string): Omit<PiAiProviderProfile, 'displayName'> & { displayName: string } {
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL
  if (baseURL.length === 0) throw new Error('llm-codex-session: baseURL must be non-empty when set')
  const models = config.models ?? SHIPPED_MODELS
  if (models.length === 0) throw new Error('llm-codex-session: models must list at least one model')
  return {
    displayName: config.displayName ?? DEFAULT_DISPLAY_NAME,
    api: 'openai-responses',
    baseURL,
    headers: {
      'chatgpt-account-id': accountId,
      originator: 'codex_cli_rs',
      'openai-beta': 'responses=experimental',
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
