/**
 * Config schema and the one explicit resolve step of the TypeSafe judgment
 * engine: raw composition config in, validated ask facts out.
 *
 * @module @shres-code/shres-code-judgment-typesafe/config
 */

import { credentialRef } from '@shres-code/shres-code-credentials'
import { MAX_TIMER_DELAY_MS } from '@shres-code/shres-code-timeout'
import type { CredentialRef } from '@shres-code/shres-code-credentials'
import type { JudgmentTier } from '@shres-code/shres-code-judgment'
import type { TypesafeJudgmentConfig, TypesafeJudgmentModels } from './types.ts'

/** Vendor endpoint used when config omits `endpoint`. */
export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai'

/** Deadline used when config omits `timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Tier mapping used when config omits `models`. */
export const DEFAULT_MODELS: TypesafeJudgmentModels = {
  fast: 'jev-preview',
  accurate: 'jev-latest',
}

/** Keys one composition entry may set; every other key is rejected by name. */
const CONFIG_KEYS: ReadonlySet<string> = new Set(['apiKeyRef', 'endpoint', 'models', 'timeoutMs'])

/** One ask's resolved and validated engine facts. */
export interface ResolvedTypesafeJudgmentConfig {
  /** Reference re-resolved through the credentials seam on every ask. */
  readonly apiKeyRef: CredentialRef
  /** Vendor endpoint base with no trailing slash. */
  readonly endpoint: string
  /** Model id each tier resolves to. */
  readonly models: TypesafeJudgmentModels
  /** Deadline for one vendor request, in milliseconds. */
  readonly timeoutMs: number
}

/**
 * Resolve, validate, and detach the facts one ask runs on.
 *
 * Schemastery normalizes a composition entry before the plugin starts, but
 * programmatic construction bypasses it, so every default, bound, and key is
 * re-judged here and a rejected config fails plugin load with the offending key
 * named.
 *
 * @param config - raw plugin config from a composition entry or a caller.
 * @returns validated ask facts with detached values.
 * @throws Error naming the offending key when the config carries an unknown
 *   key, a missing or empty reference, an empty model id, or a deadline that is
 *   not a positive finite number no greater than `MAX_TIMER_DELAY_MS`.
 */
export function resolveConfig(config: TypesafeJudgmentConfig): ResolvedTypesafeJudgmentConfig {
  validateKeys(config, CONFIG_KEYS, 'TypesafeJudgmentConfig')
  assertNonEmptyString('TypesafeJudgmentConfig.apiKeyRef', config.apiKeyRef)
  const endpoint = trimTrailingSlashes(config.endpoint ?? DEFAULT_ENDPOINT)
  assertNonEmptyString('TypesafeJudgmentConfig.endpoint', endpoint)
  const models = config.models ?? DEFAULT_MODELS
  assertNonEmptyString('TypesafeJudgmentConfig.models.fast', models.fast)
  assertNonEmptyString('TypesafeJudgmentConfig.models.accurate', models.accurate)
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  assertPositiveFinite('TypesafeJudgmentConfig.timeoutMs', timeoutMs)
  if (timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `TypesafeJudgmentConfig.timeoutMs (${timeoutMs}) must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return {
    apiKeyRef: credentialRef(config.apiKeyRef),
    endpoint,
    models: { fast: models.fast, accurate: models.accurate },
    timeoutMs,
  }
}

/**
 * Resolve one ask's model id from its tier.
 *
 * Omission resolves to `accurate`: the cheap tier is an explicit optimization,
 * so silence must not weaken a decision. This is the engine's single resolve
 * step, and the request never re-decides it.
 *
 * @param models - the config's validated tier mapping.
 * @param tier - the ask's tier, absent when the caller named none.
 * @returns the model id to send.
 */
export function resolveTierModel(models: TypesafeJudgmentModels, tier: JudgmentTier | undefined): string {
  return models[tier ?? 'accurate']
}

/** Reject stale or misspelled keys before defaults can hide them. */
function validateKeys(config: object, keys: ReadonlySet<string>, name: string): void {
  for (const key of Object.keys(config)) {
    if (!keys.has(key)) throw new Error(`${name}: unknown key "${key}"`)
  }
}

/** Drop trailing slashes so the request path is always `{endpoint}/v1/systemone`. */
function trimTrailingSlashes(endpoint: string): string {
  let end = endpoint.length
  while (end > 0 && endpoint[end - 1] === '/') end -= 1
  return endpoint.slice(0, end)
}

/** Require one field to be a string with content. */
function assertNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
}

/** Require one field to be a positive finite number. */
function assertPositiveFinite(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`)
  }
}
