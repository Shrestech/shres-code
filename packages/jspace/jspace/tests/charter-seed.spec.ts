import { describe, expect, it } from 'vitest'
import { CharterEntryId, extractCharterProposal } from '../src/index.ts'

describe('extractCharterProposal', () => {
  it('upgrades a House rules section via the constraint-survival-build catalog', () => {
    const text = [
      'Build the modules.',
      '',
      '## House rules',
      '',
      '1. **Export prefix.** Every exported function name except `selfCheck` starts with `inv`.',
      '2. **Audit tag.** The first line is exactly `/* AUDIT-TAG: INV-W0-A7F3 */`.',
      '3. **Quantities.** Write `qty(3)`, not a bare numeric literal.',
      '4. **Line budget.** No module may exceed 80 physical lines.',
      '5. **Errors.** Every thrown error is `new InventoryError(…)`.',
      '6. **Self-check.** The last export is `export function selfCheck()`.',
      '',
      '## Modules',
      '',
      'src/m01-sku.js — ignore this heading.',
    ].join('\n')
    const extracted = extractCharterProposal(text)
    expect(extracted.truncated).toBe(false)
    expect(extracted.entries).toHaveLength(6)
    expect(extracted.entries.map(entry => entry.kind)).toEqual([
      'check', 'check', 'check', 'check', 'check', 'check',
    ])
    expect(extracted.entries.map(entry => entry.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6'])
    expect(extracted.entries[0]).toMatchObject({
      kind: 'check',
      command: 'node tools/check-house-rules.mjs export-prefix src/m*.js',
      reads: ['src/m*.js'],
    })
    expect(extracted.entries[2]).toMatchObject({
      command: 'node tools/check-house-rules.mjs qty src/m*.js',
    })
  })

  it('takes consecutive numbered items when no house-rules heading exists', () => {
    const extracted = extractCharterProposal('1. Be kind to reviewers.\n2. Keep diffs small.\n')
    expect(extracted.entries).toHaveLength(2)
    expect(extracted.entries[0]).toEqual({
      kind: 'prose',
      id: CharterEntryId('e1'),
      constraint: 'Be kind to reviewers.',
    })
    expect(extracted.entries[1]?.kind).toBe('prose')
  })

  it('returns empty when there is no section and no numbered list', () => {
    expect(extractCharterProposal('Just write the function.')).toEqual({
      entries: [],
      truncated: false,
    })
  })

  it('caps at maxCharterEntries and sets truncated', () => {
    const text = '1. one\n2. two\n3. three\n'
    const extracted = extractCharterProposal(text, 2)
    expect(extracted.entries).toHaveLength(2)
    expect(extracted.truncated).toBe(true)
  })
})
