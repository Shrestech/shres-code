/**
 * Explicit configuration resolution for the judgment dispatcher.
 *
 * @module @shres-code/shres-code-judgment-dispatch/config
 */

import { judgmentEngineId } from '@shres-code/shres-code-judgment'
import type { JudgmentEngineId } from '@shres-code/shres-code-judgment'

/** Composition configuration of the dispatcher. */
export interface JudgmentDispatchConfig {
  /**
   * Registry id of the engine that answers every ask the `judgment` settings
   * do not route elsewhere. Required: the dispatcher never picks an engine by
   * registration order.
   */
  defaultEngine: string
}

/** Facts the dispatcher resolves once at mount. */
export interface ResolvedJudgmentDispatchConfig {
  /** Branded registry id of the composition-default engine. */
  readonly defaultEngine: JudgmentEngineId
}

/** Keys accepted in the dispatcher's config. */
const CONFIG_KEYS = new Set(['defaultEngine'])

/**
 * Resolve and validate the dispatcher configuration.
 * @param config - raw composition configuration.
 * @returns the resolved facts.
 * @throws Error naming an unknown key or a missing or empty `defaultEngine`.
 */
export function resolveConfig(config: JudgmentDispatchConfig): ResolvedJudgmentDispatchConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`JudgmentDispatchConfig: unknown key "${key}"`)
  }
  const value: unknown = config.defaultEngine
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('JudgmentDispatchConfig.defaultEngine must name the registry id of a composed judgment engine')
  }
  return { defaultEngine: judgmentEngineId(value) }
}
