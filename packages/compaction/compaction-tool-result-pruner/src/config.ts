/** Configuration resolution for deterministic tool-result pruning. */

import { deepFreeze } from '@shres-code/shres-code-llm'
import type { ResolvedConfig, ToolResultPruneConfig } from './types.ts'

/**
 * Cue matching compaction-basic's `POINTER_READ_CUE` (`session_event_read this session, seq`).
 * Kept local so this package does not depend on the summarizer.
 */
export const PRUNE_READ_CUE = 'session_event_read this session, seq'

/**
 * Build the model-readable omission marker for one original `tool/result` seq.
 * The omitted middle stays in the append-only log; the marker names that seq
 * and the exact re-fetch command.
 * @param originalSeq - log seq of the full original `tool/result`.
 * @returns the head/tail separator substituted for the removed span.
 */
export function pruneMarker(originalSeq: number): string {
  assertSeq('originalSeq', originalSeq)
  return (
    `\n\n[... middle pruned; remains in the session log; ${PRUNE_READ_CUE} ${String(originalSeq)} ...]\n\n`
  )
}

/** Session seqs are non-negative safe integers; a hostile or fractional id must not enter the marker. */
function assertSeq(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`tool-result prune: ${name} (${String(value)}) must be a non-negative safe integer`)
  }
}

/** Low-friction defaults for coding-agent tool output. */
export const DEFAULTS: ResolvedConfig = deepFreeze({
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
})

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'thresholdChars',
  'headChars',
  'tailChars',
])

/**
 * Count Unicode code points without splitting surrogate pairs.
 * @param text - text to measure.
 * @returns the Unicode code-point count.
 */
export function codePointLength(text: string): number {
  return Array.from(text).length
}

/**
 * Longest marker this process can emit (`originalSeq === Number.MAX_SAFE_INTEGER`).
 * Config validation uses this so a later large seq cannot grow the replacement
 * past `thresholdChars`.
 */
export const MAX_PRUNE_MARKER_CHARS = codePointLength(pruneMarker(Number.MAX_SAFE_INTEGER))

/**
 * Resolve and validate pruning budgets.
 * @param config - raw plugin configuration.
 * @returns a detached deeply immutable configuration.
 */
export function resolveConfig(config: ToolResultPruneConfig = {}): ResolvedConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(
        `ToolResultPruneConfig: unknown key "${key}" `
        + '(allowed: thresholdChars, headChars, tailChars)',
      )
    }
  }

  const resolved: ResolvedConfig = {
    thresholdChars: config.thresholdChars ?? DEFAULTS.thresholdChars,
    headChars: config.headChars ?? DEFAULTS.headChars,
    tailChars: config.tailChars ?? DEFAULTS.tailChars,
  }
  assertPositiveInteger('thresholdChars', resolved.thresholdChars)
  assertNonNegativeInteger('headChars', resolved.headChars)
  assertNonNegativeInteger('tailChars', resolved.tailChars)

  const emittedChars = resolved.headChars
    + MAX_PRUNE_MARKER_CHARS
    + resolved.tailChars
  if (emittedChars > resolved.thresholdChars) {
    throw new Error(
      `ToolResultPruneConfig: headChars + marker + tailChars (${emittedChars}) `
      + `must be at most thresholdChars (${resolved.thresholdChars})`,
    )
  }
  return deepFreeze(structuredClone(resolved))
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a positive integer`)
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a non-negative integer`)
  }
}
