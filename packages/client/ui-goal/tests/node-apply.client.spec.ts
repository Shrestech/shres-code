// Node half is an inert loader seat.

import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('ui-goal node apply', () => {
  it('is a no-op', () => {
    expect(() => { apply() }).not.toThrow()
  })
})
