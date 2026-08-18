// @vitest-environment jsdom
// remainingFightUnits keeps only incomplete todos and never invents an army.

import { describe, expect, it } from 'vitest'
import { formatElapsed, MAX_FIGHT_UNITS, remainingFightUnits } from '../src/client/units.ts'

describe('remainingFightUnits', () => {
  it('returns nothing for an absent, null, or non-list value', () => {
    expect(remainingFightUnits(undefined)).toEqual([])
    expect(remainingFightUnits(null)).toEqual([])
    expect(remainingFightUnits({} as never)).toEqual([])
  })

  it('drops completed items, caps the army, and disambiguates duplicate content', () => {
    const units = remainingFightUnits([
      { content: 'one', status: 'completed' },
      { content: 'two', status: 'pending' },
      { content: 'two', status: 'in_progress' },
      { content: 'three', status: 'pending' },
      { content: 'four', status: 'pending' },
      { content: 'five', status: 'pending' },
      { content: 'six', status: 'pending' },
      { content: 'seven', status: 'pending' },
    ])
    expect(units).toHaveLength(MAX_FIGHT_UNITS)
    expect(units.map(u => u.id)).toEqual([
      'two#0', 'two#1', 'three#0', 'four#0', 'five#0', 'six#0',
    ])
    expect(new Set(units.map(u => u.kind)).size).toBeGreaterThan(1)
  })
})

describe('formatElapsed', () => {
  it('clamps negative time and pads seconds', () => {
    expect(formatElapsed(-50)).toBe('0:00')
    expect(formatElapsed(1000)).toBe('0:01')
    expect(formatElapsed(65_000)).toBe('1:05')
  })
})
