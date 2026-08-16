/**
 * Extract the final Grok Build headless answer from one-shot JSON stdout.
 * @module @roos-code/roos-code-subagent-grok-cli/parse
 */

/**
 * Pull a non-empty string from a JSON value's common answer fields.
 * @param value - one parsed object.
 * @returns the first non-empty answer, or undefined.
 */
export function answerFromObject(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.is_error === true || record.error === true) return undefined
  for (const key of ['result', 'text', 'message', 'content', 'output'] as const) {
    const field = record[key]
    if (typeof field === 'string' && field.trim().length > 0) return field
    if (Array.isArray(field)) {
      const joined = field
        .map(entry => typeof entry === 'string'
          ? entry
          : typeof entry === 'object' && entry !== null && typeof (entry as { text?: unknown }).text === 'string'
            ? (entry as { text: string }).text
            : '')
        .join('')
      if (joined.trim().length > 0) return joined
    }
  }
  return undefined
}

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
