/**
 * Configuration for the LLM judgment engine: which one `ctx.llm` route
 * answers, where that route sends data, and the bounds of one ask.
 *
 * @module @shres-code/shres-code-judgment-llm/config
 */

import { MAX_TIMER_DELAY_MS } from '@shres-code/shres-code-timeout'

/** Default bound on one ask's model request, shared with the other judgment providers. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Where the configured route sends the judged state. */
export type LlmJudgmentEgress = 'local' | 'remote'

/** Composition config for one LLM judgment engine. */
export interface LlmJudgmentConfig {
  /** Registered `ctx.llm` provider route that answers every ask. */
  provider: string
  /** Model id on that route. */
  model: string
  /**
   * Where that route sends the state: `local` only when it runs on this
   * machine, `remote` for every other route. Required, because the llm seam
   * records no route locality and a provider's name proves nothing.
   */
  egress: LlmJudgmentEgress
  /** Adapter-owned reasoning effort for the judge request; validated against the model. */
  reasoningEffort?: string
  /**
   * Largest state, after redaction, one ask may send. Enforced as a UTF-8 byte
   * count: every tokenizer emits at most one token per byte, so a state within
   * this many bytes stays within this many tokens.
   */
  maxStateTokens: number
  /** Bound on one ask's model request in milliseconds; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
  /**
   * Sampling temperature for the judge request. A route that declares the
   * model refuses a stated temperature leaves the engine `unconfigured`.
   */
  temperature?: number
}

/** Config after defaults and validation. */
export interface ResolvedLlmJudgmentConfig {
  readonly provider: string
  readonly model: string
  readonly egress: LlmJudgmentEgress
  readonly reasoningEffort?: string
  readonly maxStateTokens: number
  readonly timeoutMs: number
  readonly temperature?: number
}

const CONFIG_KEYS = new Set(['provider', 'model', 'egress', 'reasoningEffort', 'maxStateTokens', 'timeoutMs', 'temperature'])

/**
 * Validate one engine's config and apply its defaults. The Loader's schema
 * checks the same facts; this repeats them for a direct construction.
 * @param config - the composition config.
 * @returns the resolved config.
 * @throws Error naming the offending field for an unknown key, a missing route
 *   or egress, or an out-of-range number.
 */
export function resolveConfig(config: LlmJudgmentConfig): ResolvedLlmJudgmentConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`judgment-llm: unknown config key "${key}"`)
  }
  const provider = nonEmpty(config.provider, 'provider')
  const model = nonEmpty(config.model, 'model')
  // Read as unknown: a direct construction passes config the schema never checked.
  const egress: unknown = config.egress
  if (egress !== 'local' && egress !== 'remote') {
    throw new Error('judgment-llm: egress must be "local" for a route that runs on this machine or "remote" for any other route')
  }
  if (config.reasoningEffort !== undefined) nonEmpty(config.reasoningEffort, 'reasoningEffort')
  if (!Number.isSafeInteger(config.maxStateTokens) || config.maxStateTokens <= 0) {
    throw new Error('judgment-llm: maxStateTokens must be a positive integer')
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`judgment-llm: timeoutMs must be a positive number of milliseconds no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (config.temperature !== undefined && (!Number.isFinite(config.temperature) || config.temperature < 0)) {
    throw new Error('judgment-llm: temperature must be a finite non-negative number')
  }
  return {
    provider,
    model,
    egress,
    ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    maxStateTokens: config.maxStateTokens,
    timeoutMs,
    ...config.temperature === undefined ? {} : { temperature: config.temperature },
  }
}

/** Require a non-empty string field. */
function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`judgment-llm: ${field} must be a non-empty string`)
  return value
}
