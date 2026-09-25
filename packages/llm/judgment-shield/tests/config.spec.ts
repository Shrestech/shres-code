import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_READINESS_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  resolveConfig,
  resolveTierModel,
} from '../src/index.ts'

const BASE = {
  endpoint: 'http://127.0.0.1:8765/gateway/',
  models: { fast: 'shield-fast@1', accurate: 'shield-accurate@1' },
}

describe('judgment-shield config', () => {
  it('resolves explicit endpoint/model pins and defaults', () => {
    expect(resolveConfig(BASE)).toEqual({
      endpoint: 'http://127.0.0.1:8765/gateway',
      models: BASE.models,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
      maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
      readinessIntervalMs: DEFAULT_READINESS_INTERVAL_MS,
    })
    expect(resolveTierModel(BASE.models, 'fast')).toBe('shield-fast@1')
    expect(resolveTierModel(BASE.models, 'accurate')).toBe('shield-accurate@1')
    expect(resolveTierModel(BASE.models, undefined)).toBe('shield-accurate@1')
  })

  it('keeps an explicit readiness interval and rejects one that is not a positive integer timer delay', () => {
    expect(resolveConfig({ ...BASE, readinessIntervalMs: 250 })).toMatchObject({ readinessIntervalMs: 250 })
    expect(() => resolveConfig({ ...BASE, readinessIntervalMs: 0 })).toThrow(/readinessIntervalMs must be a positive safe integer/)
    expect(() => resolveConfig({ ...BASE, readinessIntervalMs: 1.5 })).toThrow(/readinessIntervalMs/)
    expect(() => resolveConfig({ ...BASE, readinessIntervalMs: 2 ** 31 })).toThrow(/readinessIntervalMs/)
  })

  it('keeps explicit timeout and response limit', () => {
    expect(resolveConfig({ ...BASE, timeoutMs: 123, maxResponseBytes: 4096 })).toMatchObject({
      timeoutMs: 123,
      maxResponseBytes: 4096,
    })
  })

  it('rejects unknown keys and missing explicit pins', () => {
    expect(() => resolveConfig({ ...BASE, extra: true } as never)).toThrow(/unknown key "extra"/)
    expect(() => resolveConfig({ ...BASE, models: { fast: 'x', accurate: 'y', stale: 'z' } } as never))
      .toThrow(/models: unknown key "stale"/)
    expect(() => resolveConfig({ endpoint: BASE.endpoint } as never)).toThrow(/models must be an object/)
    expect(() => resolveConfig({ models: BASE.models } as never)).toThrow(/endpoint must be a non-empty loopback URL/)
    expect(() => resolveConfig({ ...BASE, models: { fast: '', accurate: 'x' } })).toThrow(/models.fast/)
  })

  it('accepts only loopback HTTP(S) endpoints without credentials or query escape', () => {
    expect(resolveConfig({ ...BASE, endpoint: 'https://localhost:9443/' }).endpoint)
      .toBe('https://localhost:9443')
    expect(resolveConfig({ ...BASE, endpoint: 'http://[::1]:8765/' }).endpoint)
      .toBe('http://[::1]:8765')
    for (const endpoint of [
      'http://example.test',
      'file:///tmp/judgment',
      'http://user:pass@127.0.0.1:8765',
      'http://127.0.0.1:8765/?escape=1',
      'http://127.0.0.1:8765/#escape',
      'not a url',
    ]) {
      expect(() => resolveConfig({ ...BASE, endpoint })).toThrow(/endpoint/)
    }
  })

  it('resolves and validates the complete request byte limit', () => {
    expect(resolveConfig({ ...BASE, maxRequestBytes: 100 }).maxRequestBytes).toBe(100)
    for (const maxRequestBytes of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => resolveConfig({ ...BASE, maxRequestBytes })).toThrow(/maxRequestBytes/)
    }
  })

  it('rejects invalid timeout and response limits', () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveConfig({ ...BASE, timeoutMs })).toThrow(/timeoutMs/)
    }
    expect(() => resolveConfig({ ...BASE, timeoutMs: 2_147_483_648 })).toThrow(/timeoutMs/)
    for (const maxResponseBytes of [0, -1, 1.5, Number.NaN]) {
      expect(() => resolveConfig({ ...BASE, maxResponseBytes })).toThrow(/maxResponseBytes/)
    }
    expect(() => resolveConfig({ ...BASE, maxResponseBytes: MAX_RESPONSE_BYTES + 1 })).toThrow(/maxResponseBytes/)
  })
})
