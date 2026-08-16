/**
 * Extract the final Kimi Code CLI answer from stream-json stdout.
 * @module @roos-code/roos-code-subagent-kimi-cli/parse
 */

import { answerFromObject } from '@roos-code/roos-code-llm-cli-bridge'

export { answerFromObject }

/**
 * Parse Kimi `--output-format stream-json` stdout into the last assistant text.
 * @param stdout - collected child stdout.
 * @returns the non-empty answer.
 */
export function parseKimiStreamJson(stdout: string): string {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    throw new Error('subagent-kimi-cli: Kimi CLI produced no output')
  }
  let last: string | undefined
  const tryParse = (chunk: string): void => {
    if (chunk.length === 0) return
    try {
      const answer = answerFromObject(JSON.parse(chunk))
      if (answer !== undefined) last = answer
    } catch {
      // A non-JSON line is commentary; only a successful object can win.
    }
  }
  try {
    const parsed = JSON.parse(trimmed)
    const answer = answerFromObject(parsed)
    if (answer !== undefined) return answer
  } catch {
    // NDJSON / mixed stream: scan lines below.
  }
  for (const line of trimmed.split('\n')) tryParse(line.trim())
  if (last === undefined) {
    throw new Error('subagent-kimi-cli: Kimi CLI stream contained no answer')
  }
  return last
}
