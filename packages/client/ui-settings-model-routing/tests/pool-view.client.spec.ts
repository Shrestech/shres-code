import { describe, expect, it } from 'vitest'
import type { ModelRoutingPoolCandidate } from '@shres-code/shres-code-model-router/client'
import { catalogModels, modelLabel, poolIdFor, poolNotes, poolSection, tokensText } from '../src/client/view.ts'
import { en } from '../src/client/locales.ts'
import { MODELS, POOL, POOL_ROUTER, namespace } from './fixtures.client.ts'

/** Resolve a key the way the locale runtime does, filling {name} placeholders. */
function t(key: keyof typeof en, params?: Record<string, unknown>): string {
  return en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name]))
}

const OPUS = { provider: 'claude-session', model: 'claude-opus-5-5' }
const catalog = catalogModels(MODELS)

/** One pool model's status with overrides; an undefined override clears the key, matching its absence on the wire. */
function candidate(
  overrides: Partial<{ [K in keyof ModelRoutingPoolCandidate]: ModelRoutingPoolCandidate[K] | undefined }>,
): ModelRoutingPoolCandidate {
  return { ...POOL.candidates[0]!, ...overrides } as ModelRoutingPoolCandidate
}

describe('pool view helpers', () => {
  it('reads the stored pool and routeFrom, keeping only object entries and string fields', () => {
    expect(poolSection(POOL_ROUTER)).toEqual({
      candidates: [
        { id: 'flash', provider: 'ollama-cloud', model: 'deepseek-v4.1-flash:cloud', description: 'small, well-scoped edits in familiar code' },
        { id: 'glm', provider: 'zai', model: 'glm-5.3', description: 'routine code edits' },
      ],
      routeFrom: [{ ...OPUS, objective: 'quota', allowEveryTurn: true }],
    })
    expect(poolSection(namespace('model-router', {
      candidates: [null, 'x', { id: 7, reasoningEffort: 'low' }],
      routeFrom: [{ provider: 'p' }, { model: 'm', allowEveryTurn: 'yes' }],
    }))).toEqual({
      candidates: [{ id: '', provider: '', model: '', reasoningEffort: 'low', description: '' }],
      routeFrom: [{ provider: 'p', model: '' }, { provider: '', model: 'm' }],
    })
    expect(poolSection(namespace('model-router', null))).toEqual({ candidates: [], routeFrom: [] })
    expect(poolSection(namespace('model-router', { candidates: 'none' }))).toEqual({ candidates: [], routeFrom: [] })
  })

  it('flattens the catalog with each model\'s efforts, and names a model by its catalog name or its route', () => {
    expect(catalog.map(entry => [entry.provider, entry.model, entry.efforts])).toEqual([
      ['claude-session', 'claude-opus-5-5', undefined],
      ['ollama-cloud', 'deepseek-v4.1-flash:cloud', ['low', 'high']],
      ['ollama-cloud', 'kimi-k3:cloud', undefined],
      ['zai', 'glm-5.3', undefined],
    ])
    expect(modelLabel(catalog, 'zai', 'glm-5.3')).toBe('GLM-5.3')
    expect(modelLabel(catalog, 'zai', 'glm-9')).toBe('zai/glm-9')
  })

  it('derives a unique pool id from a model id, never the reserved keep-current', () => {
    expect(poolIdFor('deepseek-v4.1-flash:cloud', new Set())).toBe('deepseek-v4-1-flash-cloud')
    expect(poolIdFor('moonshotai/Kimi K3', new Set(['kimi-k3']))).toBe('kimi-k3-2')
    expect(poolIdFor('keep-current', new Set())).toBe('keep-current-model')
    expect(poolIdFor('///', new Set(['model']))).toBe('model-2')
  })

  it('writes token counts compactly', () => {
    expect([tokensText(1_000_000), tokensText(1_050_000), tokensText(200_000), tokensText(131_072), tokensText(512)])
      .toEqual(['1M', '1050k', '200k', '131k', '512'])
  })

  it('notes where a pool model is eligible from, and never price', () => {
    expect(poolNotes(POOL.candidates[0]!, POOL, catalog, t)).toEqual([{ text: 'Eligible from Claude Opus 5.5', tone: 'ok' }])
    expect(poolNotes(POOL.candidates[1]!, POOL, catalog, t)).toEqual([
      { text: 'Never eligible from Claude Opus 5.5 (context 200k < 1M)', tone: 'warn' },
      { text: en.noteCacheUnreported, title: en.noteCacheUnreportedTitle, tone: 'neutral' },
    ])
  })

  it('notes an unregistered route, cross-membership, an unknown window, and every other reason by its cause', () => {
    const notes = poolNotes(candidate({
      registered: false,
      alsoRouteFrom: true,
      contextWindow: undefined,
      eligibility: [{ ...OPUS, reason: 'equals-base' }, { ...OPUS, reason: 'context-too-small' }, { provider: 'x', model: 'y', reason: 'hosted-tools-incompatible' }],
    }), POOL, catalog, t)
    expect(notes).toEqual([
      { text: en.noteUnregistered, title: en.noteUnregisteredTitle, tone: 'warn' },
      { text: 'Never eligible from Claude Opus 5.5 (context window unknown)', tone: 'warn' },
      { text: 'Never eligible from x/y (lacks a hosted tool the strong model serves)', tone: 'warn' },
      { text: en.noteAlsoRouteFrom, title: en.noteAlsoRouteFromTitle, tone: 'warn' },
    ])
    const reasons = ['base-unavailable', 'base-context-unknown', 'candidate-unavailable', 'candidate-invalid', 'difficulty-effort-invalid',
      'image-capability-unknown', 'image-incompatible', 'context-unknown', 'max-tokens-exceeds-context', 'thinking-mode-incompatible'] as const
    const texts = reasons.map(reason => poolNotes(candidate({ eligibility: [{ ...OPUS, reason }] }), POOL, catalog, t)[0]?.text)
    expect(new Set(texts).size).toBe(reasons.length)
    for (const text of texts) expect(text).toMatch(/^Never eligible from Claude Opus 5\.5 \(.+\)$/)
    // A base the pool status does not list has no window to compare with.
    expect(poolNotes(candidate({ eligibility: [{ provider: 'gone', model: 'm', reason: 'context-too-small' }] }), POOL, catalog, t)[0]?.text)
      .toBe('Never eligible from gone/m (context window unknown)')
  })
})
