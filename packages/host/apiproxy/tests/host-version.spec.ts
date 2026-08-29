import { describe, expect, it } from 'vitest'
import { hostVersion } from '../src/host-version.ts'

describe('hostVersion', () => {
  it('reports the package manifest version', () => {
    expect(hostVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('is stable across calls', () => {
    expect(hostVersion()).toBe(hostVersion())
  })
})
