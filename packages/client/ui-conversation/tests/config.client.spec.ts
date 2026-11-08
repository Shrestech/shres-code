import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/client/config.ts'

describe('conversation client config', () => {
  it('resolves the bounded Chat virtualization defaults', () => {
    expect(resolveConfig()).toEqual({
      overscanRows: 12,
      estimatedRowHeight: 96,
      initialViewportHeight: 600,
    })
  })

  it('preserves valid deployment tunables', () => {
    expect(resolveConfig({
      overscanRows: 4,
      estimatedRowHeight: 72,
      initialViewportHeight: 480,
    })).toEqual({
      overscanRows: 4,
      estimatedRowHeight: 72,
      initialViewportHeight: 480,
    })
  })

  it('rejects negative overscan and non-positive or fractional dimensions', () => {
    expect(() => Config({ overscanRows: -1 })).toThrow()
    expect(() => Config({ overscanRows: 1.5 })).toThrow()
    expect(() => Config({ estimatedRowHeight: 0 })).toThrow()
    expect(() => Config({ initialViewportHeight: 0 })).toThrow()
    expect(() => Config({ estimatedRowHeight: 12.5 })).toThrow()
    expect(() => Config({ initialViewportHeight: 12.5 })).toThrow()
  })
})
