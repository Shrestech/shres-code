// @vitest-environment jsdom
// remainingFightUnits maps incomplete todos and stands a placeholder army otherwise.

import { describe, expect, it } from 'vitest'
import { formatElapsed, MAX_FIGHT_UNITS, remainingFightUnits, STANDING_ARMY } from '../src/client/units.ts'

const STANDING_IDS = ['standing#0', 'standing#1', 'standing#2', 'standing#3']

describe('remainingFightUnits', () => {
  it('draws a standing army when the list is absent, empty, or all completed', () => {
    for (const todos of [undefined, null, [], [{ content: 'done', status: 'completed' }], {} as never]) {
      const units = remainingFightUnits(todos)
      expect(units).toHaveLength(STANDING_ARMY)
      expect(units.map(u => u.id)).toEqual(STANDING_IDS)
    }
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
