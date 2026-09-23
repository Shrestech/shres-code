/**
 * Explicit configuration resolution for the local Shield judgment gateway.
 *
 * @module @shres-code/shres-code-judgment-shield/config
 */

import { MAX_TIMER_DELAY_MS } from '@shres-code/shres-code-timeout'
import type { JudgmentTier } from '@shres-code/shres-code-judgment'
import type { ShieldJudgmentConfig, ShieldJudgmentModels } from './types.ts'

/** Default deadline for one gateway request. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Default complete-response byte limit. */
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Default complete-request byte limit, matching the owned gateway. */
export const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024

/** Largest response limit accepted by the provider configuration. */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

/** Tolerance for four-decimal probability rounding and normalization. */
export const DISTRIBUTION_TOLERANCE = 0.001

/** Keys accepted in the provider's top-level config. */
const SHIELD_CONFIG_KEYS = new Set([
  'endpoint',
  'models',
  'timeoutMs',
  'maxResponseBytes',
  'maxRequestBytes',
])

/** Keys accepted in the tier model map. */
const SHIELD_MODEL_KEYS = new Set(['fast', 'accurate'])

/** Facts the provider uses for every ask. */
export interface ResolvedShieldJudgmentConfig {
  /** Loopback endpoint without a trailing slash. */
  readonly endpoint: string
  /** Detached, non-empty artifact ids per tier. */
  readonly models: ShieldJudgmentModels
  /** Request deadline in milliseconds. */
  readonly timeoutMs: number
  /** Complete response byte limit. */
  readonly maxResponseBytes: number
  /** Complete serialized UTF-8 request byte limit. */
  readonly maxRequestBytes: number
}

/**
 * Resolve and validate the provider configuration.
 *
 * @param config - raw composition configuration.
 * @returns detached facts used by the provider.
 * @throws Error naming an unknown key, missing field, non-loopback endpoint,
 *   invalid model id, timeout, or response limit.
 */
export function resolveConfig(config: ShieldJudgmentConfig): ResolvedShieldJudgmentConfig {
  validateKeys(config, SHIELD_CONFIG_KEYS, 'ShieldJudgmentConfig')
  const endpoint = resolveEndpoint(config.endpoint)
  const models = resolveModels(config.models)
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  assertPositiveFinite('ShieldJudgmentConfig.timeoutMs', timeoutMs)
  if (timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `ShieldJudgmentConfig.timeoutMs (${timeoutMs}) must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error('ShieldJudgmentConfig.maxResponseBytes must be a positive safe integer')
  }
  if (maxResponseBytes > MAX_RESPONSE_BYTES) {
    throw new Error(
      `ShieldJudgmentConfig.maxResponseBytes (${maxResponseBytes}) must be no greater than ${MAX_RESPONSE_BYTES}`,
    )
  }
  const maxRequestBytes = config.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) {
    throw new Error('ShieldJudgmentConfig.maxRequestBytes must be a positive safe integer')
  }
  return { endpoint, models, timeoutMs, maxResponseBytes, maxRequestBytes }
}

/**
 * Resolve one ask's artifact id. An omitted tier intentionally uses accurate.
 *
 * @param models - validated tier mapping.
 * @param tier - requested tier, when supplied.
 * @returns the pinned artifact id.
 */
export function resolveTierModel(models: ShieldJudgmentModels, tier: JudgmentTier | undefined): string {
  return models[tier ?? 'accurate']
}

/** Require a loopback URL with no authority or query escape. */
function resolveEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('ShieldJudgmentConfig.endpoint must be a non-empty loopback URL')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (error: unknown) {
    throw new Error(`ShieldJudgmentConfig.endpoint is not a valid URL: ${String(error)}`, { cause: error })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('ShieldJudgmentConfig.endpoint must use http or https')
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error('ShieldJudgmentConfig.endpoint must not contain credentials')
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error('ShieldJudgmentConfig.endpoint must not contain a query or fragment')
  }
  const hostname = parsed.hostname.toLowerCase()
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]') {
    throw new Error('ShieldJudgmentConfig.endpoint must target localhost, 127.0.0.1, or ::1')
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  return parsed.toString().replace(/\/$/, '')
}

/** Resolve and detach the two required artifact ids. */
function resolveModels(value: unknown): ShieldJudgmentModels {
  if (!isRecord(value)) throw new Error('ShieldJudgmentConfig.models must be an object')
  validateKeys(value, SHIELD_MODEL_KEYS, 'ShieldJudgmentConfig.models')
  assertNonEmptyString('ShieldJudgmentConfig.models.fast', value.fast)
  assertNonEmptyString('ShieldJudgmentConfig.models.accurate', value.accurate)
  return { fast: value.fast, accurate: value.accurate }
}

/** Reject stale or misspelled config keys before defaults hide them. */
function validateKeys(value: object, keys: ReadonlySet<string>, name: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new Error(`${name}: unknown key "${key}"`)
  }
}

/** Require one non-empty string field. */
function assertNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
}

/** Require one positive finite number field. */
function assertPositiveFinite(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`)
  }
}

/** Whether a value is a JSON object rather than null or an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
