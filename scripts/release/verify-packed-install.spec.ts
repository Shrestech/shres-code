/** Headless packed-install closure edges. */

import { describe, expect, it } from 'vitest'
import { assertHeadlessClosure, HEADLESS_CLOSURE } from './verify-packed-install.ts'

describe('assertHeadlessClosure', () => {
  it('accepts a manifest that declares every headless closure edge', () => {
    const dependencies = Object.fromEntries(HEADLESS_CLOSURE.map(name => [name, 'workspace:^']))
    expect(() => assertHeadlessClosure(dependencies)).not.toThrow()
  })

  it('rejects a manifest missing one closure edge', () => {
    const [dropped, ...rest] = HEADLESS_CLOSURE
    const dependencies = Object.fromEntries(rest.map(name => [name, 'workspace:^']))
    expect(() => assertHeadlessClosure(dependencies)).toThrow(dropped)
  })

  it('rejects a manifest with no dependency object', () => {
    expect(() => assertHeadlessClosure(undefined)).toThrow(HEADLESS_CLOSURE[0])
  })
})
