import { describe, expect, it } from 'vitest'
import { OPEN_REQUIRES_CORE, openRefusal } from '../src/open.ts'

describe('openRefusal', () => {
  it('passes every call while requireCore is off', () => {
    expect(openRefusal(false, undefined, false)).toBeUndefined()
    expect(openRefusal(false, [], false)).toBeUndefined()
    expect(openRefusal(true, undefined, false)).toBeUndefined()
  })

  it('refuses a first open with no Core line', () => {
    expect(openRefusal(false, undefined, true)).toBe(OPEN_REQUIRES_CORE)
    expect(openRefusal(false, [], true)).toBe(OPEN_REQUIRES_CORE)
  })

  it('accepts a first open that carries Core', () => {
    expect(openRefusal(false, ['quantities are integers'], true)).toBeUndefined()
  })

  it('passes a call that only replaces Goal and Next, which never applies Core', () => {
    expect(openRefusal(true, undefined, true)).toBeUndefined()
    expect(openRefusal(true, [], true)).toBeUndefined()
  })

  it('names Core as the carrier of once-stated constraints and states the cap', () => {
    expect(OPEN_REQUIRES_CORE).toContain('once-stated constraints')
    expect(OPEN_REQUIRES_CORE).toContain('compaction')
    expect(OPEN_REQUIRES_CORE).toContain('at most two')
  })
})
