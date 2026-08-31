/**
 * Grok-session configuration resolution: the CLI-home auth-document default
 * and the credential spec it yields, the route's catalog/URL refusals, and
 * the optional-model-field mapping. The credential engine itself (session
 * reading, refresh grant, rotation persistence) is tested in
 * `@shres-code/shres-code-grok-credential`.
 */

import { describe, expect, it } from 'vitest'
import { defaultAuthPath, resolveCredentialSpec, resolveRoute } from '../src/config.ts'

describe('route configuration', () => {
  it('defaults the auth document to the Grok CLI home', () => {
    expect(defaultAuthPath()).toMatch(/\.grok[/\\]auth\.json$/)
  })

  it('defaults the credential spec to the CLI home and the shipped leeway', () => {
    expect(resolveCredentialSpec({})).toEqual({ authPath: defaultAuthPath(), refreshLeewayMs: 300_000 })
    expect(resolveCredentialSpec({ authPath: '/x/auth.json', refreshLeewayMs: 5 }))
      .toEqual({ authPath: '/x/auth.json', refreshLeewayMs: 5 })
  })

  it('refuses an empty catalog, an empty baseURL, and a negative leeway', () => {
    expect(() => resolveRoute({ models: [] })).toThrow(/must list at least one model/)
    expect(() => resolveRoute({ baseURL: '' })).toThrow(/baseURL must be non-empty/)
    expect(() => resolveCredentialSpec({ refreshLeewayMs: -1 })).toThrow(/non-negative/)
  })

  it('maps optional model fields onto the profile only when stated', () => {
    const profile = resolveRoute({
      models: [{ id: 'bare' }, { id: 'full', name: 'Full', contextWindow: 1000, maxTokens: 128 }],
    })
    const models = profile.models ?? []
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({ id: 'bare' })
    expect(models[0]).not.toHaveProperty('name')
    expect(models[0]).not.toHaveProperty('maxTokens')
    expect(models[1]).toMatchObject({ id: 'full', name: 'Full', contextWindow: 1000, maxTokens: 128 })
  })
})
