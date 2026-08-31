/**
 * Configuration resolution for the image_gen tool: default-off enablement, the
 * documented model/endpoint/output defaults, and loud validation of a bad
 * deployment choice.
 */
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/index.ts'

describe('resolveConfig', () => {
  it('defaults to disabled with the CLI mirroring defaults', () => {
    const resolved = resolveConfig({})
    expect(resolved.enabled).toBe(false)
    expect(resolved.model).toBe('grok-imagine-image-quality')
    expect(resolved.baseURL).toBe('https://api.x.ai/v1')
    expect(resolved.outputDirectory).toBe('images')
    expect(resolved.refreshLeewayMs).toBe(300_000)
  })

  it('honors explicit deployment fields when enabled', () => {
    const resolved = resolveConfig({ enabled: true, model: 'grok-imagine-image-pro', baseURL: 'https://api.x.ai/v1', authPath: '/tmp/a.json', outputDirectory: '/tmp/out', refreshLeewayMs: 5000, timeoutMs: 1000 })
    expect(resolved.enabled).toBe(true)
    expect(resolved.model).toBe('grok-imagine-image-pro')
    expect(resolved.authPath).toBe('/tmp/a.json')
    expect(resolved.outputDirectory).toBe('/tmp/out')
    expect(resolved.refreshLeewayMs).toBe(5000)
    expect(resolved.timeoutMs).toBe(1000)
  })

  it('fails loud on a blank model or output directory', () => {
    expect(() => resolveConfig({ model: '  ' })).toThrow(/model must be a non-empty string/u)
    expect(() => resolveConfig({ outputDirectory: '' })).toThrow(/outputDirectory must be a non-empty string/u)
  })

  it('fails loud on a non-positive timeout', () => {
    expect(() => resolveConfig({ timeoutMs: 0 })).toThrow(/timeoutMs must be a positive integer/u)
  })

  it('fails loud on a non-positive refresh leeway', () => {
    expect(() => resolveConfig({ refreshLeewayMs: 0 })).toThrow(/refreshLeewayMs must be a positive integer/u)
  })
})
