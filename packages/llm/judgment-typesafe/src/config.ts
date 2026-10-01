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
import type { TypesafeJudgmentConfig, TypesafeJudgmentModels, TypesafeJudgmentRetry } from './types.ts'

/** Vendor endpoint used when config omits `endpoint`. */
export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai'

/** Deadline used when config omits `timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Tier mapping used when config omits `models`. */
export const DEFAULT_MODELS: TypesafeJudgmentModels = {
  fast: 'jev-preview',
  accurate: 'jev-latest',
}

/** Retries after the first request when config omits `retry.maxRetries`. */
export const DEFAULT_MAX_RETRIES = 1

/** Fixed wait before each retry when config omits `retry.delayMs`. */
export const DEFAULT_RETRY_DELAY_MS = 300

/**
 * Statuses eligible for retry when config omits `retry.statuses`: the vendor's
 * two documented transient responses, the rate limit and the overloaded
 * service, in the order the vendor documents them.
 */
export const DEFAULT_RETRY_STATUSES: readonly number[] = [429, 529]

/** Keys one composition entry may set; every other key is rejected by name. */
const CONFIG_KEYS: ReadonlySet<string> = new Set(['apiKeyRef', 'endpoint', 'models', 'timeoutMs', 'retry'])

/** Keys one `retry` entry may set. */
const RETRY_KEYS: ReadonlySet<string> = new Set(['maxRetries', 'delayMs', 'statuses'])

/** One ask's resolved and validated retry policy. */
export interface ResolvedTypesafeJudgmentRetry {
  /** Retries allowed after the first request; `0` retries nothing. */
  readonly maxRetries: number
  /** Fixed wait before each retry, in milliseconds. */
  readonly delayMs: number
  /** HTTP statuses eligible for retry, in the order they were configured. */
  readonly statuses: readonly number[]
}

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
  /** Resolved transient-failure retry policy. */
  readonly retry: ResolvedTypesafeJudgmentRetry
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
 *   key, a missing or empty reference, an empty model id, a deadline that is
 *   not a positive finite number no greater than `MAX_TIMER_DELAY_MS`, a retry
 *   budget or wait outside its bounds, a status outside 100 through 599, or a
 *   positive retry budget with no retryable status.
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
  const retry = resolveRetry(config.retry)
  return {
    apiKeyRef: credentialRef(config.apiKeyRef),
    endpoint,
    models: { fast: models.fast, accurate: models.accurate },
    timeoutMs,
    retry,
  }
}

/**
 * Resolve the retry policy: its budget, its fixed wait, and the statuses that
 * may spend the budget.
 *
 * A positive budget with no retryable status is refused rather than left inert,
 * because that combination can never retry anything: the deployment either
 * names the status it wants repeated or disables retry outright.
 *
 * @param retry - the raw retry entry, or undefined when the deployment omitted it.
 * @returns the resolved policy with a detached status list.
 * @throws Error naming the offending key when the entry carries an unknown key,
 *   a negative or non-integer budget, a negative, non-finite, or unschedulable
 *   wait, a status outside 100 through 599, or a positive budget with no status.
 */
function resolveRetry(retry: TypesafeJudgmentRetry | undefined): ResolvedTypesafeJudgmentRetry {
  const path = 'TypesafeJudgmentConfig.retry'
  if (retry !== undefined) validateKeys(retry, RETRY_KEYS, path)
  const maxRetries = retry?.maxRetries ?? DEFAULT_MAX_RETRIES
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error(`${path}.maxRetries must be a non-negative safe integer`)
  }
  const delayMs = retry?.delayMs ?? DEFAULT_RETRY_DELAY_MS
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.delayMs must be a non-negative finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  const statuses = retry?.statuses ?? [...DEFAULT_RETRY_STATUSES]
  for (const status of statuses) {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new Error(`${path}.statuses must hold HTTP statuses from 100 through 599`)
    }
  }
  if (maxRetries > 0 && statuses.length === 0) {
    throw new Error(
      `${path}: maxRetries is ${maxRetries} while no status is retryable, so the budget could never be spent;`
      + ' name a status or set maxRetries: 0',
    )
  }
  return { maxRetries, delayMs, statuses: [...statuses] }
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
