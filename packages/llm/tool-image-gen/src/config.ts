/**
 * Plugin configuration and the credential spec the image_gen tool resolves. The
 * model, endpoint, and output location are deployment-varying, so every one is a
 * validated Config field here; the defaults mirror the Grok Build CLI's own
 * Imagine defaults (the api.x.ai/v1 base and the grok-imagine-image-quality
 * model), never a hardcoded local choice.
 * @module @shres-code/shres-code-tool-image-gen/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@shres-code/schemastery'

/** Imagine API base the Grok Build CLI's image_gen dispatches against. */
export const DEFAULT_BASE_URL = 'https://api.x.ai/v1'

/** Default Imagine model for image_gen; mirrors the CLI's default quality model. */
export const DEFAULT_MODEL = 'grok-imagine-image-quality'

/** Refresh when the session token is at or within this distance of its expiry. */
export const DEFAULT_REFRESH_LEEWAY_MS = 300_000

/** Where generated images are written when no outputDirectory is configured. */
export const DEFAULT_OUTPUT_DIRECTORY = 'images'

/** Default cooperative tool-call budget (ms) for one generation. */
export const DEFAULT_TIMEOUT_MS = 300_000

/**
 * Default auth document: the Grok Build CLI's own session store.
 * @returns the absolute path of `~/.grok/auth.json` for the current user.
 */
export function defaultAuthPath(): string {
  return join(homedir(), '.grok', 'auth.json')
}

/** Plugin / cordis.yml section configuring the image_gen tool. */
export interface Config {
  /** Register the tool. Defaults to off. */
  enabled?: boolean
  /** Imagine model id; defaults to {@link DEFAULT_MODEL}. */
  model?: string
  /** Imagine API base including the version prefix; defaults to {@link DEFAULT_BASE_URL}. */
  baseURL?: string
  /** Auth document path; defaults to {@link defaultAuthPath}. */
  authPath?: string
  /** Token refresh leeway in milliseconds; defaults to {@link DEFAULT_REFRESH_LEEWAY_MS}. */
  refreshLeewayMs?: number
  /** Directory generated images are written into; defaults to {@link DEFAULT_OUTPUT_DIRECTORY}. */
  outputDirectory?: string
  /** Cooperative tool-call budget (ms); defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
}

/** Schema for {@link Config}; only `enabled` has a default so it can default off. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  model: z.string(),
  baseURL: z.string(),
  authPath: z.string(),
  refreshLeewayMs: z.number().step(1).min(1),
  outputDirectory: z.string(),
  timeoutMs: z.number().step(1).min(1),
})

/** Fully resolved configuration with every deployment field applied. */
export interface ResolvedConfig {
  enabled: boolean
  model: string
  baseURL: string
  authPath: string
  refreshLeewayMs: number
  outputDirectory: string
  timeoutMs: number
}

/**
 * Resolve a configuration value to the concrete facts the tool reads, failing
 * loud on an invalid deployment choice. Every field gets its documented default,
 * and a blank model, base URL, auth path, or output directory is a load error
 * rather than a surprising silent request.
 * @param raw - the (possibly partial) configured section.
 * @returns the resolved, validated facts.
 */
export function resolveConfig(raw: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    enabled: raw.enabled === true,
    model: raw.model ?? DEFAULT_MODEL,
    baseURL: raw.baseURL ?? DEFAULT_BASE_URL,
    authPath: raw.authPath ?? defaultAuthPath(),
    refreshLeewayMs: raw.refreshLeewayMs ?? DEFAULT_REFRESH_LEEWAY_MS,
    outputDirectory: raw.outputDirectory ?? DEFAULT_OUTPUT_DIRECTORY,
    timeoutMs: raw.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  for (const [name, value] of [
    ['model', resolved.model],
    ['baseURL', resolved.baseURL],
    ['authPath', resolved.authPath],
    ['outputDirectory', resolved.outputDirectory],
  ] as const) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`tool-image-gen: ${name} must be a non-empty string`)
    }
  }
  if (!Number.isInteger(resolved.refreshLeewayMs) || resolved.refreshLeewayMs < 1) {
    throw new Error('tool-image-gen: refreshLeewayMs must be a positive integer')
  }
  if (!Number.isInteger(resolved.timeoutMs) || resolved.timeoutMs < 1) {
    throw new Error('tool-image-gen: timeoutMs must be a positive integer')
  }
  return resolved
}

/** The credential facts one session manager is memoized on. */
export interface CredentialSpec {
  authPath: string
  refreshLeewayMs: number
}

/**
 * Extract the credential spec the shared grok-credential service keys a session
 * manager on.
 * @param resolved - resolved configuration carrying the credential facts.
 * @returns the spec passed to `ctx.grokCredential.managerFor`.
 */
export function resolveCredentialSpec(resolved: Pick<ResolvedConfig, 'authPath' | 'refreshLeewayMs'>): CredentialSpec {
  return { authPath: resolved.authPath, refreshLeewayMs: resolved.refreshLeewayMs }
}
