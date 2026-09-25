/**
 * Number formatting for the Routing view: token counts, shares, scores, and
 * latencies, each in one fixed English form so tables and charts agree.
 */

/**
 * Format a token count with a k or M suffix and three significant digits.
 * @param tokens - a non-negative token count.
 * @returns `999`, `91.8k`, `235k`, `3.53M`, or `10.7M`.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${threeDigits(tokens / 1_000)}k`
  return `${threeDigits(tokens / 1_000_000)}M`
}

/** Round to three significant digits for values from 1 to 999. */
function threeDigits(value: number): string {
  if (value >= 100) return String(Math.round(value))
  if (value >= 10) return String(Math.round(value * 10) / 10)
  return String(Math.round(value * 100) / 100)
}

/**
 * Format a share as a percentage with one decimal.
 * @param share - a value from 0 to 1.
 * @returns e.g. `38.0%`.
 */
export function formatPercent(share: number): string {
  return `${(share * 100).toFixed(1)}%`
}

/**
 * Format a confidence, probability, margin, or difficulty with two decimals.
 * @param value - the score.
 * @returns e.g. `0.39`.
 */
export function formatScore(value: number): string {
  return value.toFixed(2)
}

/**
 * Format a latency in milliseconds, switching to seconds from 1 s.
 * @param ms - milliseconds.
 * @returns e.g. `709 ms` or `1.5 s`.
 */
export function formatMs(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 100) / 10} s`
}
