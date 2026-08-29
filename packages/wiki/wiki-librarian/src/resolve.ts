/**
 * Plugin config resolution for the wiki librarian seat.
 * @module @shres-code/shres-code-wiki-librarian/resolve
 */

import z from '@shres-code/schemastery'
import { MAX_TIMER_DELAY_MS } from '@shres-code/shres-code-timeout'
import { assertRolePair } from '@shres-code/shres-code-wiki'

/** Plugin config. `provider` and `model` must be supplied together. */
export interface Config {
  /** Explicit provider route; must be paired with `model`. */
  provider?: string
  /** Explicit model id; must be paired with `provider`. */
  model?: string
  /** End-to-end auxiliary request deadline in milliseconds. */
  timeoutMs?: number
  /** Auxiliary generation output-token cap. */
  maxOutputTokens?: number
  /** Maximum UTF-8 bytes in the framed user prompt. */
  maxInputBytes?: number
  /** Maximum trailing session events included in the prompt. */
  maxLogEvents?: number
}

/** Validated librarian policy with defaults filled. */
export interface ResolvedWikiLibrarianConfig {
  readonly provider?: string
  readonly model?: string
  readonly timeoutMs: number
  readonly maxOutputTokens: number
  readonly maxInputBytes: number
  readonly maxLogEvents: number
}

/** Loader-validated plugin config. Roles start unbound. */
export const Config: z<Config> = z.object({
  provider: z.string(),
  model: z.string(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  maxOutputTokens: z.number().step(1).min(1).default(2048),
  maxInputBytes: z.number().step(1).min(1).default(32_000),
  maxLogEvents: z.number().step(1).min(1).default(40),
})

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`wiki-librarian: ${field} must be a positive integer`)
  }
}

/**
 * Validate librarian tunables. `provider` and `model` must be supplied together.
 * @param config - plugin config.
 * @returns frozen policy with defaults filled.
 */
export function resolveLibrarianConfig(config: Config = {}): ResolvedWikiLibrarianConfig {
  assertRolePair({
    ...config.provider === undefined ? {} : { provider: config.provider },
    ...config.model === undefined ? {} : { model: config.model },
  })
  const timeoutMs = config.timeoutMs ?? 30_000
  const maxOutputTokens = config.maxOutputTokens ?? 2048
  const maxInputBytes = config.maxInputBytes ?? 32_000
  const maxLogEvents = config.maxLogEvents ?? 40
  assertPositiveInteger('timeoutMs', timeoutMs)
  assertPositiveInteger('maxOutputTokens', maxOutputTokens)
  assertPositiveInteger('maxInputBytes', maxInputBytes)
  assertPositiveInteger('maxLogEvents', maxLogEvents)
  if (timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`wiki-librarian: timeoutMs must not exceed ${String(MAX_TIMER_DELAY_MS)}`)
  }
  return {
    timeoutMs,
    maxOutputTokens,
    maxInputBytes,
    maxLogEvents,
    ...config.provider === undefined ? {} : { provider: config.provider },
    ...config.model === undefined ? {} : { model: config.model },
  }
}
