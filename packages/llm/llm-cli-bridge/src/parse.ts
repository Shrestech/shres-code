/**
 * Extract final assistant text and optional usage from CLI stdout.
 * @module @shres-code/shres-code-llm-cli-bridge/parse
 */

import type { TokenUsage } from '@shres-code/shres-code-llm'
import { answerFromObject } from './answer.ts'
import type { CliBridgeRoute } from './config.ts'

export { answerFromObject, isCliErrorPayload } from './answer.ts'

/** Parsed CLI completion. */
export interface ParsedCliOutput {
  /** Final assistant text. */
  text: string
  /** Token usage when the CLI reported counts. */
  usage?: TokenUsage
}

/**
 * Read token counts from a JSON object's `usage` field when present.
 * @param value - one parsed object.
 * @returns usage, or undefined when the CLI omitted counts.
 */
export function usageFromObject(value: unknown): TokenUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const usage = (value as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) return undefined
  const record = usage as Record<string, unknown>
  const input = numberOf(record, ['input_tokens', 'inputTokens', 'prompt_tokens'])
  const output = numberOf(record, ['output_tokens', 'outputTokens', 'completion_tokens'])
  if (input === undefined || output === undefined) return undefined
  const reasoning = numberOf(record, ['reasoning_tokens', 'reasoningTokens'])
  return {
    inputTokens: input,
    outputTokens: output,
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
  }
}

function numberOf(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return undefined
}

/**
 * Parse collected CLI stdout according to the route's parse mode.
 * @param route - resolved route.
 * @param stdout - collected child stdout.
 * @returns the final text and optional usage.
 */
export function parseCliOutput(route: CliBridgeRoute, stdout: string): ParsedCliOutput {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    throw new Error('llm-cli-bridge: CLI produced no output')
  }
  if (route.parseMode === 'json') {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new Error('llm-cli-bridge: CLI stdout was not JSON')
    }
    const text = answerFromObject(parsed)
    if (text === undefined) throw new Error('llm-cli-bridge: CLI JSON contained no answer')
    const usage = usageFromObject(parsed)
    return usage === undefined ? { text } : { text, usage }
  }

  let lastText: string | undefined
  let lastUsage: TokenUsage | undefined
  const consider = (value: unknown): void => {
    const text = answerFromObject(value)
    if (text !== undefined) lastText = text
    const usage = usageFromObject(value)
    if (usage !== undefined) lastUsage = usage
  }
  try {
    consider(JSON.parse(trimmed))
  } catch {
    // NDJSON / mixed stream: scan lines below.
  }
  if (lastText === undefined) {
    for (const line of trimmed.split('\n')) {
      const chunk = line.trim()
      if (chunk.length === 0) continue
      try {
        consider(JSON.parse(chunk))
      } catch {
        // A non-JSON line is commentary; only a successful object can win.
      }
    }
  }
  if (lastText === undefined) {
    throw new Error('llm-cli-bridge: CLI stream contained no answer')
  }
  return lastUsage === undefined ? { text: lastText } : { text: lastText, usage: lastUsage }
}
