/**
 * Deployment configuration of the Grok X search tools and its validation.
 * @module @shres-code/shres-code-tool-grok-x-search/config
 */

import z from '@shres-code/schemastery'
import { MAX_TIMER_DELAY_MS } from '@shres-code/shres-code-timeout'

/** Plugin config: the Grok model the tools ask and the per-call limits. */
export interface Config {
  /** Grok model id on the grok-session route. Defaults to `grok-4.6`. */
  model?: string
  /** End-to-end deadline of one tool call in milliseconds. Defaults to 180000. */
  timeoutMs?: number
  /** Output-token cap of the Grok request. Defaults to 2048. */
  maxOutputTokens?: number
  /** Cap on the complete rendered tool result in characters. Defaults to 20000. */
  maxResultChars?: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  model: z.string().default('grok-4.6'),
  timeoutMs: z.number().default(180_000),
  maxOutputTokens: z.number().default(2048),
  maxResultChars: z.number().default(20_000),
})

/** Complete config after schemastery applies every default. */
export type ResolvedConfig = Readonly<Required<Config>>

/** Smallest result cap that still fits the fixed result framing. */
export const MIN_RESULT_CHARS = 1000

/**
 * Validate the defaulted configuration, failing loud at plugin load.
 * @param config - schemastery-defaulted plugin config.
 * @returns the frozen validated config.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved = config as Required<Config>
  if (typeof resolved.model !== 'string' || resolved.model.trim().length === 0) {
    throw new Error('tool-grok-x-search: model must be a non-empty string')
  }
  for (const key of ['timeoutMs', 'maxOutputTokens', 'maxResultChars'] as const) {
    if (!Number.isInteger(resolved[key]) || resolved[key] < 1) {
      throw new Error(`tool-grok-x-search: ${key} must be a positive integer`)
    }
  }
  if (resolved.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-grok-x-search: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  if (resolved.maxResultChars < MIN_RESULT_CHARS) {
    throw new Error(`tool-grok-x-search: maxResultChars must be at least ${MIN_RESULT_CHARS}`)
  }
  return Object.freeze({ ...resolved })
}
