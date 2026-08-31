/**
 * Config resolution and service-tier splice behavior, no network.
 */

import { describe, expect, it } from 'vitest'
import { Config as Section } from '../src/index.ts'
import {
  DEFAULT_BASE_URL,
  DEFAULT_DISPLAY_NAME,
  SERVICE_TIERS,
  SHIPPED_MODELS,
  applyServiceTier,
  resolveRoute,
  serviceTierForModel,
} from '../src/config.ts'

describe('resolveRoute defaults', () => {
  it('resolves the pay-per-token xAI endpoint and shipped catalog', () => {
    const route = resolveRoute({})
    expect(route.api).toBe('openai-responses')
    expect(route.baseURL).toBe(DEFAULT_BASE_URL)
    expect(route.displayName).toBe(DEFAULT_DISPLAY_NAME)
    expect(route.models?.map(model => model.id)).toEqual(SHIPPED_MODELS.map(model => model.id))
  })

  it('honors a configured baseURL, displayName, and model catalog', () => {
    const route = resolveRoute({
      baseURL: 'https://gateway.example/v1',
      displayName: 'My xAI',
      models: [{ id: 'grok-4.5', serviceTier: 'priority' }],
    })
    expect(route.baseURL).toBe('https://gateway.example/v1')
    expect(route.displayName).toBe('My xAI')
    expect(route.models?.map(model => model.id)).toEqual(['grok-4.5'])
  })
})

describe('serviceTier validation', () => {
  it('rejects an unknown tier value at resolution', () => {
    expect(() => resolveRoute({ models: [{ id: 'grok-4.5', serviceTier: 'turbo' }] } as unknown as Section))
      .toThrow(/serviceTier must be one of default, priority/)
  })

  it('accepts every declared tier', () => {
    for (const tier of SERVICE_TIERS) {
      expect(() => resolveRoute({ models: [{ id: 'grok-4.5', serviceTier: tier }] }))
        .not.toThrow()
    }
  })
})

describe('serviceTierForModel', () => {
  it('defaults an undeclared model to default', () => {
    expect(serviceTierForModel({}, 'grok-4.5')).toBe('default')
  })

  it('returns the configured tier for a model', () => {
    const config = { models: [{ id: 'grok-4.5', serviceTier: 'priority' }] } as Section
    expect(serviceTierForModel(config, 'grok-4.5')).toBe('priority')
    // a sibling model keeps the default
    expect(serviceTierForModel(config, 'grok-4.6')).toBe('default')
  })
})

describe('applyServiceTier', () => {
  it('splices service_tier when the tier is priority', () => {
    const body: Record<string, unknown> = { model: 'grok-4.5' }
    applyServiceTier(body, 'priority')
    expect(body.service_tier).toBe('priority')
  })

  it('omits the field entirely on the default tier', () => {
    const body: Record<string, unknown> = { model: 'grok-4.5' }
    applyServiceTier(body, 'default')
    expect('service_tier' in body).toBe(false)
  })

  it('leaves a non-object payload untouched', () => {
    expect(() => { applyServiceTier(null, 'priority') }).not.toThrow()
    expect(() => { applyServiceTier('nope', 'priority') }).not.toThrow()
  })
})
