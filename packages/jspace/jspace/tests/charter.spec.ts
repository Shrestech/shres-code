import { describe, expect, it } from 'vitest'
import {
  CharterEntryId,
  decodeJspaceCharter,
  formatCharterEntrySummary,
  nextCharterEntryId,
} from '../src/index.ts'

describe('CharterEntryId', () => {
  it('brands a kebab-case token and rejects empty, padded, or illegal ids', () => {
    expect(CharterEntryId('e1')).toBe('e1')
    expect(CharterEntryId('audit-tag')).toBe('audit-tag')
    expect(() => CharterEntryId('')).toThrow(/kebab-case/)
    expect(() => CharterEntryId(' e1')).toThrow(/kebab-case/)
    expect(() => CharterEntryId('E1')).toThrow(/kebab-case/)
    expect(() => CharterEntryId('1e')).toThrow(/kebab-case/)
  })

  it('assigns e1, e2, … skipping taken ids', () => {
    expect(nextCharterEntryId(new Set())).toBe('e1')
    expect(nextCharterEntryId(new Set(['e1', 'e3']))).toBe('e2')
  })
})

describe('decodeJspaceCharter', () => {
  it('defaults a missing field to an empty list', () => {
    expect(decodeJspaceCharter(undefined)).toEqual([])
  })

  it('decodes failProbe insert content that ends in a newline', () => {
    expect(decodeJspaceCharter([{
      kind: 'check',
      id: 'e1',
      constraint: 'audit tag',
      command: 'grep AUDIT-TAG src/m01-sku.js',
      reads: ['src/m01-sku.js'],
      discrimination: 'demonstrated',
      failProbe: { path: 'src/m01-sku.js', mutation: { kind: 'insert', content: '// no tag\n' } },
    }])).toEqual([{
      kind: 'check',
      id: 'e1',
      constraint: 'audit tag',
      command: 'grep AUDIT-TAG src/m01-sku.js',
      reads: ['src/m01-sku.js'],
      discrimination: 'demonstrated',
      failProbe: { path: 'src/m01-sku.js', mutation: { kind: 'insert', content: '// no tag\n' } },
    }])
  })

  it('rejects a reused id', () => {
    expect(() => decodeJspaceCharter([
      { kind: 'prose', id: 'e1', constraint: 'a' },
      { kind: 'prose', id: 'e1', constraint: 'b' },
    ])).toThrow(/reused/)
  })
})

describe('formatCharterEntrySummary', () => {
  it('omits commands and truncates constraint text to 40 characters', () => {
    expect(formatCharterEntrySummary({
      kind: 'check',
      id: CharterEntryId('e1'),
      constraint: 'qty via qty()',
      command: 'node tools/check-house-rules.mjs qty src/m*.js',
      reads: ['src/m*.js'],
      discrimination: 'demonstrated',
    })).toBe('e1 ✓ qty via qty()')
    expect(formatCharterEntrySummary({
      kind: 'check',
      id: CharterEntryId('e2'),
      constraint: 'audit tag that is quite a long constraint text here',
      command: 'grep AUDIT-TAG src/m01-sku.js',
      reads: ['src/m01-sku.js'],
      discrimination: 'unverified',
      unverifiedReason: 'discrimination-off',
    })).toBe('e2 ? audit tag that is quite a long constrain [unverified]')
    expect(formatCharterEntrySummary({
      kind: 'prose',
      id: CharterEntryId('e3'),
      constraint: 'export prefix',
    })).toBe('e3 prose export prefix')
  })
})
