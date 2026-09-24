/**
 * Readers for the cache-count presence contract of {@link TokenUsage}. Browser
 * code imports them from this dependency-minimal `@shres-code/shres-code-llm/usage`
 * entry instead of the service-bearing package root.
 *
 * @module @shres-code/shres-code-llm/usage
 */

import { assertNever } from './never.ts'
import type { TokenUsage } from './types.ts'

/** Which prompt-cache count to read: cache hits (`read`) or cache creation (`write`). */
export type CacheCountKind = 'read' | 'write'

/**
 * One prompt-cache count exactly as the provider reported it for a call.
 * @param usage - the call's usage.
 * @param kind - `read` for cache hits, `write` for cache creation.
 * @returns the reported count, zero included; `undefined` when the provider did not report that count.
 */
export function cacheCount(usage: TokenUsage, kind: CacheCountKind): number | undefined {
  switch (kind) {
    case 'read': return usage.cacheReadTokens
    case 'write': return usage.cacheWriteTokens
    default: return assertNever(kind)
  }
}

/**
 * Sum two usages under the presence contract, so an aggregate obeys the same
 * rules as one call. A cache count stays present only when both operands
 * reported it; otherwise the sum omits it and folds every reported value of
 * that count into `inputTokens`, which keeps the aggregate's
 * {@link promptTokens} equal to the operands' combined prompt tokens.
 * Reasoning, an output subdivision outside the contract, sums whenever either
 * operand carries it.
 * @param total - the running aggregate.
 * @param next - the usage to add.
 * @returns the aggregate usage.
 */
export function addTokenUsage(total: TokenUsage, next: TokenUsage): TokenUsage {
  let inputTokens = total.inputTokens + next.inputTokens
  const counts: { cacheReadTokens?: number; cacheWriteTokens?: number } = {}
  for (const [kind, field] of [['read', 'cacheReadTokens'], ['write', 'cacheWriteTokens']] as const) {
    const left = cacheCount(total, kind)
    const right = cacheCount(next, kind)
    if (left !== undefined && right !== undefined) counts[field] = left + right
    else inputTokens += (left === undefined ? 0 : left) + (right === undefined ? 0 : right)
  }
  return {
    inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    ...counts,
    ...total.reasoningTokens === undefined && next.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: (total.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0) },
  }
}

/**
 * The call's full prompt size: `inputTokens` plus every reported cache count.
 * An unreported count adds nothing because the provider's `inputTokens` then
 * already carries that input, so the sum neither double-counts nor reads a
 * missing report as a measured zero.
 * @param usage - the call's usage.
 * @returns prompt-side tokens; output is excluded.
 */
export function promptTokens(usage: TokenUsage): number {
  const read = cacheCount(usage, 'read')
  const write = cacheCount(usage, 'write')
  return usage.inputTokens + (read === undefined ? 0 : read) + (write === undefined ? 0 : write)
}
