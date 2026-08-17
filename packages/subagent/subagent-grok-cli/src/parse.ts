/**
 * Extract the final Grok Build headless answer from one-shot JSON stdout.
 * @module @shres-code/shres-code-subagent-grok-cli/parse
 */

import { answerFromObject } from '@shres-code/shres-code-llm-cli-bridge'

export { answerFromObject }

/**
 * Parse Grok `--output-format json` stdout into the final assistant text.
 * @param stdout - collected child stdout.
 * @returns the non-empty answer.
 */
export function parseGrokJson(stdout: string): string {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    throw new Error('subagent-grok-cli: Grok Build produced no output')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error('subagent-grok-cli: Grok Build stdout was not JSON')
  }
  const answer = answerFromObject(parsed)
  if (answer === undefined) {
    throw new Error('subagent-grok-cli: Grok Build JSON contained no answer')
  }
  return answer
}
