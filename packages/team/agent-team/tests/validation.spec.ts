import { describe, expect, it } from 'vitest'
import { requiredText } from '../src/validation.ts'

describe('requiredText', () => {
  it('rejects empty and overlong values', () => {
    expect(() => requiredText('  ', 'description', 8)).toThrow(/non-empty/)
    expect(() => requiredText('abcdefghijk', 'description', 8)).toThrow(/exceeds 8/)
    expect(requiredText('  ok  ', 'description', 8)).toBe('ok')
  })
})
