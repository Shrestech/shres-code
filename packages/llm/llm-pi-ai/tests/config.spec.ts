import { describe, expect, it } from 'vitest'
import { assertServiceable, Config, resolveProfiles } from '../src/config.ts'

/** Validate one hand-declared route, with the caller's fields layered onto it. */
const routeWith = (profile: Record<string, unknown>): (() => unknown) =>
  () => Config({
    providers: {
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'm' }],
        ...profile,
      },
    },
  })

/** Validate that route with the caller's fields on its single model entry. */
const configWith = (model: Record<string, unknown>): (() => unknown) =>
  routeWith({ models: [{ id: 'm', ...model }] })

describe('reasoning schema boundary', () => {
  it('rejects a level pi-ai does not know at the write that produced it', () => {
    expect(configWith({ reasoningEfforts: { ultra: 'x' } })).toThrow(/"off"/)
    expect(configWith({ reasoningEfforts: { high: 42 } })).toThrow()
  })

  it('keeps false distinguishable from an absent declaration', () => {
    type Materialized = { providers: Record<string, { models?: { reasoningEfforts?: unknown }[] }> }
    const withFalse = configWith({ reasoningEfforts: false })() as Materialized
    expect(withFalse.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBe(false)
    const absent = configWith({})() as Materialized
    expect(absent.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBeUndefined()
  })

  it('rejects a thinking format outside the offered set', () => {
    expect(configWith({ compat: { thinkingFormat: 'quantum' } })).toThrow(/expected/)
  })
})

describe('modality schema boundary', () => {
  it('rejects a modality pi-ai does not know, at either level', () => {
    expect(configWith({ input: ['audio'] })).toThrow(/expected/)
    expect(routeWith({ defaultInput: ['text', 'audio'] })).toThrow(/expected/)
  })

  it('refuses a route whose models could accept nothing', () => {
    // The pair the settings seam runs: the schema accepts the empty list as
    // well-typed, and the namespace validator is what refuses it. Asserting
    // only the schema would report this route as writable.
    expect(routeWith({ defaultInput: [] })).not.toThrow()
    expect(() => { assertServiceable(routeWith({ defaultInput: [] })() as Config) })
      .toThrow(/defaultInput must name at least one modality/)
  })

  type Materialized = {
    providers: Record<string, { defaultInput?: unknown; models?: { input?: unknown }[] }>
  }

  it('materializes an absent entry list as empty and an absent route list as text', () => {
    // The empty-list inheritance rule exists because of exactly this: an entry
    // that declares nothing reaches resolution as `[]`, not as `undefined`.
    const absent = configWith({})() as Materialized
    expect(absent.providers['acme-gateway']?.models?.[0]?.input).toEqual([])
    expect(absent.providers['acme-gateway']?.defaultInput).toEqual(['text'])
  })
})

describe('hosted-tools declaration boundary', () => {
  /** Validate one hand-declared responses route, the dialect that serves both hosted tools. */
  const responsesRoute = (profile: Record<string, unknown>): (() => unknown) =>
    () => Config({
      providers: {
        'acme-gateway': {
          api: 'openai-responses',
          baseURL: 'https://acme.test',
          models: [{ id: 'm' }],
          ...profile,
        },
      },
    })

  it('rejects a non-boolean switch at the write and at resolution', () => {
    // The settings-path schema refuses the value where it is written...
    expect(() => { assertServiceable(responsesRoute({ hostedTools: { webSearch: 'yes' } })() as Config) })
      .toThrow(/expected boolean/)
    // ...and resolution refuses the same shape arriving without the schema.
    expect(() => {
      resolveProfiles({
        'acme-gateway': {
          api: 'openai-responses',
          baseURL: 'https://acme.test',
          models: [{ id: 'm', hostedTools: { webSearch: 'yes' as unknown as boolean } }],
        },
      })
    }).toThrow(/hostedTools\.webSearch must be a boolean/)
  })

  it('rejects a hosted tool the route dialect does not serve', () => {
    // openai-completions serves z.ai's web_search only; x_search exists on
    // the responses dialect alone.
    expect(() => { assertServiceable(routeWith({ hostedTools: { xSearch: true } })() as Config) })
      .toThrow(/does not serve it/)
    expect(() => {
      assertServiceable(Config({
        providers: {
          'acme-gateway': {
            api: 'openai-completions',
            baseURL: 'https://acme.test',
            models: [{ id: 'm', hostedTools: { xSearch: true } }],
          },
        },
      }))
    }).toThrow(/does not serve it/)
  })

  it('accepts both hosted tools on a responses route and materializes per-model overrides', () => {
    expect(() => { assertServiceable(responsesRoute({ hostedTools: { webSearch: true, xSearch: true } })() as Config) })
      .not.toThrow()
    const resolved = resolveProfiles({
      'acme-gateway': {
        api: 'openai-responses',
        baseURL: 'https://acme.test',
        hostedTools: { webSearch: true, xSearch: true },
        models: [{ id: 'a' }, { id: 'b', hostedTools: { xSearch: false } }, { id: 'c', hostedTools: { webSearch: false, xSearch: false } }],
      },
    })
    expect(resolved.get('acme-gateway')?.hostedTools.get('a')).toEqual(['web_search', 'x_search'])
    expect(resolved.get('acme-gateway')?.hostedTools.get('b')).toEqual(['web_search'])
    expect(resolved.get('acme-gateway')?.hostedTools.get('c')).toBeUndefined()
  })
})
