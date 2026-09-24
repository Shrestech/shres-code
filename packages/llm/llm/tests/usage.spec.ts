import { describe, expect, it } from 'vitest'
import { addTokenUsage, cacheCount, promptTokens } from '@shres-code/shres-code-llm'
import type { CacheCountKind, TokenUsage } from '@shres-code/shres-code-llm'

describe('cacheCount', () => {
  it('returns a reported zero as zero, not as absence', () => {
    const usage: TokenUsage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
    expect(cacheCount(usage, 'read')).toBe(0)
    expect(cacheCount(usage, 'write')).toBe(0)
  })

  it('returns undefined for a count the provider did not report', () => {
    const usage: TokenUsage = { inputTokens: 10, outputTokens: 2 }
    expect(cacheCount(usage, 'read')).toBeUndefined()
    expect(cacheCount(usage, 'write')).toBeUndefined()
  })

  it('reads the two counts independently', () => {
    const usage: TokenUsage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 7 }
    expect(cacheCount(usage, 'read')).toBe(7)
    expect(cacheCount(usage, 'write')).toBeUndefined()
  })

  it('rejects an unknown kind', () => {
    expect(() => cacheCount({ inputTokens: 1, outputTokens: 1 }, 'hit' as CacheCountKind)).toThrow()
  })
})

describe('promptTokens', () => {
  it('adds every reported cache count to the input', () => {
    expect(promptTokens({ inputTokens: 10, outputTokens: 99, cacheReadTokens: 30, cacheWriteTokens: 5 })).toBe(45)
  })

  it('counts only the input when the provider reported no cache counts', () => {
    expect(promptTokens({ inputTokens: 40, outputTokens: 99 })).toBe(40)
  })

  it('adds a reported read without a write concept', () => {
    expect(promptTokens({ inputTokens: 10, outputTokens: 99, cacheReadTokens: 30 })).toBe(40)
  })
})

describe('addTokenUsage', () => {
  it('sums every count both operands reported', () => {
    expect(addTokenUsage(
      { inputTokens: 10, outputTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 0, reasoningTokens: 2 },
      { inputTokens: 20, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 4 },
    )).toEqual({ inputTokens: 30, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 4, reasoningTokens: 2 })
  })

  it('carries reasoning from whichever operand has it', () => {
    expect(addTokenUsage({ inputTokens: 1, outputTokens: 1 }, { inputTokens: 1, outputTokens: 3, reasoningTokens: 2 }))
      .toEqual({ inputTokens: 2, outputTokens: 4, reasoningTokens: 2 })
  })

  it('drops a count one operand did not report and folds the other operand value into input', () => {
    const total = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 5 }
    const next = { inputTokens: 40, outputTokens: 1 }
    const sum = addTokenUsage(total, next)
    expect(sum).toEqual({ inputTokens: 55, outputTokens: 2 })
    expect(promptTokens(sum)).toBe(promptTokens(total) + promptTokens(next))
  })

  it('keeps the prompt total across any mix of reported and unreported counts', () => {
    const samples = [
      { inputTokens: 3, outputTokens: 1, cacheReadTokens: 7, cacheWriteTokens: 2 },
      { inputTokens: 11, outputTokens: 1 },
      { inputTokens: 5, outputTokens: 1, cacheWriteTokens: 9 },
      { inputTokens: 4, outputTokens: 1, cacheReadTokens: 0 },
    ]
    const sum = samples.reduce(addTokenUsage)
    expect(promptTokens(sum)).toBe(samples.reduce((acc, usage) => acc + promptTokens(usage), 0))
    expect(cacheCount(sum, 'read')).toBeUndefined()
    expect(cacheCount(sum, 'write')).toBeUndefined()
  })
})
