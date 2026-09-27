import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('accepts a valid config', () => {
    expect(resolveConfig({ entryRate: 0.3, seed: 42 })).toEqual({ entryRate: 0.3, seed: 42 })
  })

  it('rejects unknown keys by name', () => {
    expect(() => resolveConfig({ entryRate: 0.3, seed: 1, tier: 'fast' })).toThrow(/unknown key tier/)
  })

  it('rejects entry rates outside 0..1', () => {
    expect(() => resolveConfig({ entryRate: -0.1, seed: 1 })).toThrow(/entryRate/)
    expect(() => resolveConfig({ entryRate: 1.1, seed: 1 })).toThrow(/entryRate/)
    expect(() => resolveConfig({ entryRate: Number.NaN, seed: 1 })).toThrow(/entryRate/)
  })

  it('rejects non-integer and out-of-range seeds', () => {
    expect(() => resolveConfig({ entryRate: 0.3, seed: 1.5 })).toThrow(/seed/)
    expect(() => resolveConfig({ entryRate: 0.3, seed: -1 })).toThrow(/seed/)
    expect(() => resolveConfig({ entryRate: 0.3, seed: 0x1_0000_0000 })).toThrow(/seed/)
  })

  it('rejects a non-object config', () => {
    expect(() => resolveConfig(null)).toThrow(/must be an object/)
    expect(() => resolveConfig([1])).toThrow(/must be an object/)
  })
})
