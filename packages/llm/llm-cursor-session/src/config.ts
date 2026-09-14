/**
 * Plugin configuration and the one provider route it resolves. The route is
 * adapter-owned — Cursor's agent wire is not OpenAI-shaped, so unlike the
 * codex/grok session adapters it does not ride shres-llm-pi-ai — and the
 * shipped catalog lists the models cursor-agent validated against the live
 * backend, with chat streaming gated behind a fail-loud diagnostic while the
 * wire's proprietary handshake is not replicated.
 * @module @shres-code/shres-code-llm-cursor-session/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@shres-code/schemastery'

/** Route id this adapter registers under. */
export const CURSOR_SESSION_PROVIDER_ID = 'cursor-session'

/** Cursor API host the JSON RPC family (model catalog) is served on. */
export const DEFAULT_BASE_URL = 'https://api2.cursor.sh'

/** Display name selectors show. */
export const DEFAULT_DISPLAY_NAME = 'Cursor (subscription)'

/**
 * Default file-store document: the Cursor Agent CLI's session file under
 * `AGENT_CLI_CREDENTIAL_STORE=file`.
 * @returns the absolute path of `~/.cursor/auth.json` for the current user.
 */
export function defaultAuthPath(): string {
  return join(homedir(), '.cursor', 'auth.json')
}

/**
 * Models cursor-agent validated against the live backend when this catalog
 * shipped. A release this list has not caught up with is a settings
 * `models` entry, not a code change.
 */
export const SHIPPED_MODELS: readonly CursorSessionModelConfig[] = [
  { id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: 272_000 },
  { id: 'claude-4.5-sonnet', name: 'Sonnet 4.5', contextWindow: 200_000 },
  { id: 'cursor-grok-4.6-high', name: 'Grok 4.6 (high)', contextWindow: 256_000 },
  { id: 'cursor-grok-4.6-high-fast', name: 'Grok 4.6 (high, fast)', contextWindow: 256_000 },
  { id: 'claude-fable-5-1-thinking-high', name: 'Fable 5.1 Thinking (high)', contextWindow: 200_000 },
  { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (high)', contextWindow: 1_000_000 },
]

/** One advisory model entry a deployment may declare. */
export interface CursorSessionModelConfig {
  /** Model id cursor-agent's backend accepts. */
  id: string
  /** Selector label; defaults to the id. */
  name?: string
  /** Maximum combined request and response context in tokens. */
  contextWindow?: number
  /** Maximum output tokens; configuring one also makes it the request default. */
  maxTokens?: number
}

/** The one route's resolved facts. */
export interface ResolvedCursorSessionRoute {
  /** Selector label. */
  displayName: string
  /** When false, the route is omitted from the live adapter registry. */
  enabled: boolean
  /** Endpoint base for the JSON RPC family. */
  baseURL: string
  /** macOS security tool path for the keychain credential source. */
  securityPath: string
  /** File-store document path, used when keychain is false. */
  authPath: string
  /** Read the login keychain instead of the file store. */
  useKeychain: boolean
  /** Advisory models. */
  models: CursorSessionModelConfig[]
}

/** Plugin / settings section configuring the one route. */
export interface Config {
  /** When false, the route is omitted from the live adapter registry. Defaults to on. */
  enabled?: boolean
  /** Endpoint base for the JSON RPC family. Defaults to the public API host. */
  baseURL?: string
  /** macOS security tool path for the keychain credential source. */
  securityPath?: string
  /** File-store document path, used when {@link useKeychain} is false. */
  authPath?: string
  /** Read the login keychain instead of the file store. Defaults to true on macOS. */
  useKeychain?: boolean
  /** Selector label; defaults to the shipped display name. */
  displayName?: string
  /** Advisory models; overlays the shipped catalog. */
  models?: CursorSessionModelConfig[]
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  baseURL: z.string(),
  securityPath: z.string(),
  authPath: z.string(),
  useKeychain: z.boolean().default(true),
  displayName: z.string(),
  models: z.array(z.object({
    id: z.string().required(),
    name: z.string(),
    contextWindow: z.number().step(1).min(1),
    maxTokens: z.number().step(1).min(1),
  })).default(undefined as unknown as { id: string; name: string; contextWindow: number; maxTokens: number }[]),
})

/**
 * Resolve the section with its explicit defaults.
 * @param config - the raw section from composition or settings.
 * @returns the resolved route facts.
 */
export function resolveConfig(config: Config): ResolvedCursorSessionRoute {
  return {
    displayName: config.displayName ?? DEFAULT_DISPLAY_NAME,
    enabled: config.enabled !== false,
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    securityPath: config.securityPath ?? '/usr/bin/security',
    authPath: config.authPath ?? defaultAuthPath(),
    useKeychain: config.useKeychain ?? process.platform === 'darwin',
    models: config.models ?? [...SHIPPED_MODELS],
  }
}
