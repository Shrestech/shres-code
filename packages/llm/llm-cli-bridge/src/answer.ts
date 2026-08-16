/**
 * Shared CLI JSON answer extraction for delegated completion and one-shot
 * product-subagent stdout.
 * @module @roos-code/roos-code-llm-cli-bridge/answer
 */

/**
 * Whether a parsed CLI object is an error payload, not an answer.
 * @param record - one JSON object.
 * @returns true when the object names an error.
 */
export function isCliErrorPayload(record: Record<string, unknown>): boolean {
  return record.is_error === true
    || record.error === true
    || record.type === 'error'
    || record.subtype === 'error'
}

/**
 * Pull a non-empty string from a JSON value's common answer fields.
 * Error payloads return undefined even when they carry a `message`.
 * @param value - one parsed object.
 * @returns the first non-empty answer, or undefined.
 */
export function answerFromObject(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (isCliErrorPayload(record)) return undefined
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
