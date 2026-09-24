/**
 * Route and credential-spec resolution for the one `anthropic-messages` route:
 * the deployment defaults, the shipped catalog and its compat switches, the
 * refusals, the no-headers clobber regression, and the platform credential
 * default.
 */

import { userInfo } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SECURITY_PATH } from '@shres-code/shres-code-claude-credential'
import {
  DEFAULT_BASE_URL,
  DEFAULT_DISPLAY_NAME,
  DEFAULT_REFRESH_LEEWAY_MS,
  defaultAuthPath,
  resolveCredentialSpec,
  resolveRoute,
  SHIPPED_MODELS,
} from '../src/index.ts'

const SHIPPED_EFFORTS = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }

describe('resolveRoute', () => {
  it('resolves the one anthropic-messages route with its deployment defaults', () => {
    expect(DEFAULT_BASE_URL).toBe('https://api.anthropic.com')
    expect(DEFAULT_DISPLAY_NAME).toBe('Claude (subscription)')
    const route = resolveRoute({})
    expect(route.api).toBe('anthropic-messages')
    expect(route.baseURL).toBe(DEFAULT_BASE_URL)
    expect(route.displayName).toBe(DEFAULT_DISPLAY_NAME)
  })

  it('admits a configured displayName and endpoint', () => {
    const route = resolveRoute({ displayName: 'Anthropic Gateway', baseURL: 'https://proxy.test' })
    expect(route.displayName).toBe('Anthropic Gateway')
    expect(route.baseURL).toBe('https://proxy.test')
  })

  it('ships the subscription catalog with its per-model compat and efforts', () => {
    expect(SHIPPED_MODELS.map(model => model.id)).toEqual(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5'])
    const models = resolveRoute({}).models ?? []
    expect(models.map(model => model.id)).toEqual(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5'])
    expect(models[0]).toMatchObject({
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      input: ['text', 'image'],
      compat: { forceAdaptiveThinking: true, supportsTemperature: false },
    })
    expect(models[1]).toMatchObject({
      id: 'claude-opus-5',
      compat: { forceAdaptiveThinking: true, supportsTemperature: false },
    })
    // Sonnet accepts a temperature, so its entry must not declare one absent.
    expect(models[2]).toMatchObject({ id: 'claude-sonnet-5', compat: { forceAdaptiveThinking: true } })
    expect(models[2]?.compat).not.toHaveProperty('supportsTemperature')
    for (const model of models) expect(model.reasoningEfforts).toEqual(SHIPPED_EFFORTS)
  })

  it('emits no headers key, so pi-ai owns the OAuth beta set', () => {
    // pi-ai merges its OAuth default headers with route headers later-wins, so
    // any route header would destroy the beta set the subscription needs.
    const route = resolveRoute({})
    expect(Object.hasOwn(route, 'headers')).toBe(false)
    expect(route.headers).toBeUndefined()
    const overridden = resolveRoute({
      baseURL: 'https://proxy.test',
      displayName: 'Proxy',
      models: [{ id: 'm' }],
    })
    expect(Object.hasOwn(overridden, 'headers')).toBe(false)
  })

  it('replaces the catalog with configured models and maps only stated fields', () => {
    const profile = resolveRoute({
      models: [
        { id: 'bare' },
        {
          id: 'full',
          name: 'Full',
          contextWindow: 1000,
          maxTokens: 128,
          input: ['text', 'image'],
          compat: { forceAdaptiveThinking: true, supportsTemperature: false },
        },
      ],
    })
    const models = profile.models ?? []
    expect(models.map(model => model.id)).toEqual(['bare', 'full'])
    expect(models[0]).not.toHaveProperty('name')
    expect(models[0]).not.toHaveProperty('contextWindow')
    expect(models[0]).not.toHaveProperty('maxTokens')
    expect(models[0]).not.toHaveProperty('input')
    expect(models[0]).not.toHaveProperty('compat')
    expect(models[0]?.reasoningEfforts).toEqual(SHIPPED_EFFORTS)
    expect(models[1]).toMatchObject({
      id: 'full',
      name: 'Full',
      contextWindow: 1000,
      maxTokens: 128,
      input: ['text', 'image'],
      compat: { forceAdaptiveThinking: true, supportsTemperature: false },
    })
  })

  it('lands each compat switch independently', () => {
    const models = resolveRoute({
      models: [
        { id: 'adaptive', compat: { forceAdaptiveThinking: true } },
        { id: 'cold', compat: { supportsTemperature: false } },
      ],
    }).models ?? []
    expect(models[0]?.compat).toEqual({ forceAdaptiveThinking: true })
    expect(models[1]?.compat).toEqual({ supportsTemperature: false })
  })

  it('refuses an empty endpoint and an empty catalog', () => {
    expect(() => resolveRoute({ baseURL: '' })).toThrow(/baseURL must be non-empty/)
    expect(() => resolveRoute({ models: [] })).toThrow(/models must list at least one model/)
  })
})

describe('resolveCredentialSpec', () => {
  it('defaults the credential spec to the platform store and the shipped leeway', () => {
    expect(defaultAuthPath()).toMatch(/\.claude[/\\]\.credentials\.json$/)
    expect(resolveCredentialSpec({})).toEqual({
      useKeychain: process.platform === 'darwin',
      securityPath: DEFAULT_SECURITY_PATH,
      keychainAccount: userInfo().username,
      authPath: defaultAuthPath(),
      refreshLeewayMs: DEFAULT_REFRESH_LEEWAY_MS,
    })
    expect(DEFAULT_REFRESH_LEEWAY_MS).toBe(300_000)
  })

  it('resolves the platform default: the login keychain on darwin, the document elsewhere', () => {
    const platform = vi.spyOn(process, 'platform', 'get')
    platform.mockReturnValue('darwin')
    expect(resolveCredentialSpec({}).useKeychain).toBe(true)
    platform.mockReturnValue('linux')
    expect(resolveCredentialSpec({}).useKeychain).toBe(false)
    platform.mockRestore()
  })

  it('lets an explicit useKeychain win over the platform default', () => {
    expect(resolveCredentialSpec({ useKeychain: true }).useKeychain).toBe(true)
    expect(resolveCredentialSpec({ useKeychain: false }).useKeychain).toBe(false)
  })

  it('honors explicit credential-source fields', () => {
    expect(resolveCredentialSpec({
      securityPath: '/usr/local/bin/security',
      authPath: '/tmp/.credentials.json',
      keychainAccount: 'other-account',
      refreshLeewayMs: 5,
    })).toEqual({
      useKeychain: process.platform === 'darwin',
      securityPath: '/usr/local/bin/security',
      keychainAccount: 'other-account',
      authPath: '/tmp/.credentials.json',
      refreshLeewayMs: 5,
    })
  })

  it('refuses a negative and a non-finite refresh leeway', () => {
    expect(() => resolveCredentialSpec({ refreshLeewayMs: -1 }))
      .toThrow(/refreshLeewayMs must be a non-negative finite number/)
    expect(() => resolveCredentialSpec({ refreshLeewayMs: Number.POSITIVE_INFINITY }))
      .toThrow(/refreshLeewayMs must be a non-negative finite number/)
    expect(() => resolveCredentialSpec({ refreshLeewayMs: Number.NaN }))
      .toThrow(/refreshLeewayMs must be a non-negative finite number/)
  })
})
