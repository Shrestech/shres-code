import { describe, expect, it } from 'vitest'
import { renderDigest } from '../src/digest.ts'

const full = {
  card: { goal: 'Prove the micro cycle', next: 'Ship the digest', checkedCount: 3 },
  ledger: [
    { hypothesis: 'Stub debate satisfies the gate', decision: 'accepted', entryId: 'led-1' },
    { hypothesis: 'Rejected earlier probe', decision: 'rejected', entryId: 'led-0' },
  ],
  budget: { spent: 1.5, remaining: 8.5 },
}

describe('renderDigest', () => {
  it('is deterministic for equal inputs', () => {
    expect(renderDigest(full)).toBe(renderDigest({ ...full, ledger: [...full.ledger] }))
  })

  it('renders every field in stable order', () => {
    expect(renderDigest(full)).toBe([
      'research digest',
      'Goal: Prove the micro cycle',
      'Next: Ship the digest',
      'Checked: 3',
      'Ledger: 2',
      '  - led-1 accepted Stub debate satisfies the gate',
      '  - led-0 rejected Rejected earlier probe',
      'Budget: spent 1.5, remaining 8.5',
    ].join('\n'))
  })

  it('renders placeholders for absent card, ledger, and budget', () => {
    expect(renderDigest({})).toBe([
      'research digest',
      'Card: (none)',
      'Ledger: (empty)',
      'Budget: (unmetered)',
    ].join('\n'))
  })

  it('renders the card-only and ledger-only shapes', () => {
    expect(renderDigest({ card: full.card })).toBe([
      'research digest',
      'Goal: Prove the micro cycle',
      'Next: Ship the digest',
      'Checked: 3',
      'Ledger: (empty)',
      'Budget: (unmetered)',
    ].join('\n'))
    expect(renderDigest({ ledger: [] })).toContain('Ledger: (empty)')
  })
})
