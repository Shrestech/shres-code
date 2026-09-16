/** Input normalization shared by Team roster operations. */

import { TeamError } from './error.ts'

/**
 * Normalize one required human-authored string.
 * @param value - raw input value.
 * @param field - diagnostic field name.
 * @param maxLength - maximum normalized character count.
 * @returns trimmed non-empty text.
 */
export function requiredText(value: string, field: string, maxLength: number): string {
  const text = value.trim()
  if (text.length === 0) throw new TeamError(`${field} must be non-empty`, 'TEAM_INVALID_ARGUMENT')
  if (text.length > maxLength) {
    throw new TeamError(`${field} exceeds ${maxLength} characters`, 'TEAM_INVALID_ARGUMENT')
  }
  return text
}
