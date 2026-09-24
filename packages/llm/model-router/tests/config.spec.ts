/**
 * \`resolveConfig\`: the one explicit, validated resolve step of the router's
 * configuration. Every deployment-varying choice is re-judged here (schemastery
 * normalizes a composition entry, but programmatic construction and settings
 * writes do not), so each rejection below names the offending key and each
 * default is pinned to its documented value. The result is frozen and detached:
 * a caller mutating the array it passed in cannot reach the resolved facts.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DIFFICULTY_LEVELS,
  DEFAULT_ENTRY_SCORE_CEILING,
  DEFAULT_ESCALATE_BACK_SCORE_THRESHOLD,
  DEFAULT_HOLD_MAX_STEPS,
  DEFAULT_HOLD_MIN_STEPS,
  DEFAULT_JUDGMENT_BREAKER_OPEN_TURNS,
  DEFAULT_JUDGMENT_BREAKER_THRESHOLD,
  DEFAULT_JUDGMENT_DEADLINE_MS,
  DEFAULT_JUDGMENT_HOLD_TOLERANCE,
  DEFAULT_MAX_ROUTE_ERRORS,
  DEFAULT_REENTRY_COOLDOWN_TURNS,
  DEFAULT_STATE_CONTEXT_TURNS,
  DEFAULT_STATE_MAX_CHARS,
  DEFAULT_STATE_MAX_FIT_CANDIDATES,
  resolveConfig,
} from '../src/index.ts'
import ModelRoutingController from '../src/index.ts'
import { KEEP_CURRENT_OPTION_ID } from '../src/config.ts'
import type { ModelRouterConfig } from '../src/config.ts'

const CANDIDATE = { id: 'cheap', provider: 'cheap-provider', model: 'cheap-model' }

/** The smallest config that resolves; each case perturbs one field. */
function valid(overrides: Partial<ModelRouterConfig> = {}): ModelRouterConfig {
  return {
    initialMode: 'on',
    candidates: [{ ...CANDIDATE }],
    downgradeThreshold: 0.8,
    downgradeMargin: 0.1,
    routeInstructions: 'Which route should handle this turn?',
    difficultyInstructions: 'How hard is this turn?',
    ...overrides,
  }
}

/**
 * The config as a deployment that never wrote the difficulty question. The key
 * is absent, not `undefined`: schemastery and `Session.append` both refuse an
 * explicit `undefined`, and `exactOptionalPropertyTypes` says the same.
 */
function withoutDifficultyQuestion(overrides: Partial<ModelRouterConfig> = {}): ModelRouterConfig {
  return {
    initialMode: 'on',
    candidates: [{ ...CANDIDATE }],
    downgradeThreshold: 0.8,
    downgradeMargin: 0.1,
    routeInstructions: 'Which route should handle this turn?',
    hold: { minSteps: 0 },
    ...overrides,
  }
}

/** The config as a caller could hand it in with one field absent or malformed. */
function raw(overrides: Record<string, unknown>): ModelRouterConfig {
  return { ...valid(), ...overrides }
}

describe('resolveConfig required fields', () => {
  it('requires the mode', () => {
    expect(() => resolveConfig(raw({ initialMode: undefined })))
      .toThrow('ModelRouterConfig.initialMode must be "off" or "on"')
    expect(() => resolveConfig(raw({ initialMode: 'sometimes' })))
      .toThrow('ModelRouterConfig.initialMode must be "off" or "on"')
    expect(() => resolveConfig(raw({ initialMode: '' })))
      .toThrow('ModelRouterConfig.initialMode must be "off" or "on"')
  })

  it('requires the route question text', () => {
    expect(() => resolveConfig(raw({ routeInstructions: undefined })))
      .toThrow('ModelRouterConfig.routeInstructions must be a non-empty string')
    expect(() => resolveConfig(raw({ routeInstructions: '   ' })))
      .toThrow('ModelRouterConfig.routeInstructions must be a non-empty string')
  })

  it('requires both gate axes', () => {
    expect(() => resolveConfig(raw({ downgradeThreshold: undefined })))
      .toThrow('ModelRouterConfig.downgradeThreshold must be a number from 0 through 1')
    expect(() => resolveConfig(raw({ downgradeMargin: undefined })))
      .toThrow('ModelRouterConfig.downgradeMargin must be a number from 0 through 1')
  })
})

describe('resolveConfig allowlist', () => {
  it('rejects an unknown key by name', () => {
    expect(() => resolveConfig(raw({ downgradeMarginByHint: 0.2 })))
      .toThrow('ModelRouterConfig: unknown key "downgradeMarginByHint"')
  })

  it('rejects a duplicate candidate id', () => {
    expect(() => resolveConfig(valid({ candidates: [{ ...CANDIDATE }, { ...CANDIDATE }] })))
      .toThrow('ModelRouterConfig.candidates lists "cheap" more than once')
  })

  it('rejects an empty id, provider, model, or description', () => {
    expect(() => resolveConfig(valid({ candidates: [{ ...CANDIDATE, id: '' }] })))
      .toThrow('ModelRouterConfig.candidates[].id must be a non-empty string')
    expect(() => resolveConfig(valid({ candidates: [{ ...CANDIDATE, provider: '  ' }] })))
      .toThrow('ModelRouterConfig.candidates["cheap"].provider must be a non-empty string')
    expect(() => resolveConfig(valid({ candidates: [{ ...CANDIDATE, model: '' }] })))
      .toThrow('ModelRouterConfig.candidates["cheap"].model must be a non-empty string')
    expect(() => resolveConfig(valid({ candidates: [{ ...CANDIDATE, description: ' ' }] })))
      .toThrow('ModelRouterConfig.candidates["cheap"].description must be a non-empty string')
  })

  it('rejects the route option id reserved for keeping the manual model', () => {
    expect(() => resolveConfig(valid({ candidates: [{ ...CANDIDATE, id: KEEP_CURRENT_OPTION_ID }] })))
      .toThrow('ModelRouterConfig.candidates["keep-current"].id is reserved for the keep-current route option')
  })

  it('keeps the allowlist in configuration order and defaults it to empty', () => {
    const resolved = resolveConfig(valid({
      candidates: [
        { id: 'cheap', provider: 'cheap-provider', model: 'cheap-model', reasoningEffort: 'low', description: 'small changes' },
        { id: 'mid', provider: 'mid-provider', model: 'mid-model' },
      ],
    }))
    expect(resolved.candidates).toEqual([
      { id: 'cheap', provider: 'cheap-provider', model: 'cheap-model', reasoningEffort: 'low', description: 'small changes' },
      { id: 'mid', provider: 'mid-provider', model: 'mid-model' },
    ])
    expect(resolved.candidates[0]?.description).toBe('small changes')
    // The allowlist is optional in the interface and defaults to empty: routing
    // may then select nothing, which the consult logs as no-candidates.
    const bare: ModelRouterConfig = {
      initialMode: 'off',
      downgradeThreshold: 0.8,
      downgradeMargin: 0.1,
      routeInstructions: 'Which route should handle this turn?',
      difficultyInstructions: 'How hard is this turn?',
    }
    expect(resolveConfig(bare).candidates).toEqual([])
  })
})

describe('resolveConfig the difficulty question', () => {
  it('is required while a downgrade is held, including when the key is simply absent', () => {
    expect(() => resolveConfig(raw({ difficultyInstructions: undefined })))
      .toThrow('ModelRouterConfig.difficultyInstructions is required while hold.minSteps > 0')
    // The interface makes the question texts independent, but the defaulted
    // horizon (20 steps) keeps this one required: the smallest shape a deployment might
    // write still fails load until it configures the question or sets the
    // horizon to 0.
    const questions: ModelRouterConfig = {
      initialMode: 'off',
      downgradeThreshold: 0.8,
      downgradeMargin: 0.1,
      routeInstructions: 'Which route should handle this turn?',
    }
    expect(() => resolveConfig(questions))
      .toThrow('ModelRouterConfig.difficultyInstructions is required while hold.minSteps > 0 or hardHint')
    expect(resolveConfig({ ...questions, hold: { minSteps: 0 } }).hold.minSteps).toBe(0)
    expect(resolveConfig({ ...questions, difficultyInstructions: 'How hard is this turn?' }).hold.minSteps).toBe(20)
  })

  it('is required while the advisory hint is configured', () => {
    const config = withoutDifficultyQuestion({ hardHint: { scoreThreshold: 4 } })
    expect(() => resolveConfig(config))
      .toThrow('ModelRouterConfig.difficultyInstructions is required while hold.minSteps > 0')
    // A blank question text is not a configured question either.
    expect(() => resolveConfig({ ...config, difficultyInstructions: '  ' }))
      .toThrow('ModelRouterConfig.difficultyInstructions is required while hold.minSteps > 0')
    expect(resolveConfig({ ...config, difficultyInstructions: 'How hard?' }).hardHintScoreThreshold).toBe(4)
  })

  it('is required for an effort lift even when stickiness is disabled', () => {
    const config = withoutDifficultyQuestion({
      difficultyToEffort: { scoreThreshold: 0, reasoningEffort: 'high' },
    })
    expect(() => resolveConfig(config))
      .toThrow('ModelRouterConfig.difficultyInstructions is required while hold.minSteps > 0 or hardHint or difficultyToEffort')
    expect(resolveConfig({ ...config, difficultyInstructions: 'How hard?' }).difficultyToEffort)
      .toEqual({ scoreThreshold: 0, reasoningEffort: 'high' })
  })

  it('is optional for a non-sticky router with no hint', () => {
    const resolved = resolveConfig(withoutDifficultyQuestion())
    expect(resolved.hold).toEqual({ minSteps: 0, maxSteps: 40 })
    expect('difficultyInstructions' in resolved).toBe(false)
  })

  it('reads a valueless optional sub-object as not configured', () => {
    // A composition file may write `difficultyToEffort:` with no value; the
    // schema resolves that to null, and null is not a configured lift or hint.
    const resolved = resolveConfig(raw({ difficultyToEffort: null, hardHint: null }))
    expect(resolved.difficultyToEffort).toBeUndefined()
    expect(resolved.hardHintScoreThreshold).toBeUndefined()
    expect('difficultyToEffort' in resolved).toBe(false)
    expect('hardHintScoreThreshold' in resolved).toBe(false)
  })

  it('needs at least two ordered levels, each named', () => {
    expect(() => resolveConfig(valid({ difficultyLevels: ['the only level'] })))
      .toThrow('ModelRouterConfig.difficultyLevels needs at least two ordered level descriptions')
    expect(() => resolveConfig(valid({ difficultyLevels: ['easy', '  '] })))
      .toThrow('ModelRouterConfig.difficultyLevels[1] must be a non-empty string')
  })
})

describe('resolveConfig bounds', () => {
  it('requires a probability inside 0..1 on both axes', () => {
    for (const value of [1.5, -0.1, Number.NaN, 'high']) {
      expect(() => resolveConfig(raw({ downgradeThreshold: value })))
        .toThrow('ModelRouterConfig.downgradeThreshold must be a number from 0 through 1')
      expect(() => resolveConfig(raw({ downgradeMargin: value })))
        .toThrow('ModelRouterConfig.downgradeMargin must be a number from 0 through 1')
    }
    expect(resolveConfig(valid({ downgradeThreshold: 0, downgradeMargin: 1 })).downgradeThreshold).toBe(0)
  })

  it('uses the zero-based difficulty level scale, including score zero', () => {
    expect(resolveConfig(valid({ escalateBack: { scoreThreshold: 0 }, difficulty: { entryScoreCeiling: 0 } })).escalateBackScoreThreshold)
      .toBe(0)
    expect(resolveConfig(valid({ hardHint: { scoreThreshold: 0 } })).hardHintScoreThreshold).toBe(0)
    expect(resolveConfig(valid({ difficultyToEffort: { scoreThreshold: 0, reasoningEffort: 'high' } })).difficultyToEffort)
      .toEqual({ scoreThreshold: 0, reasoningEffort: 'high' })
    expect(() => resolveConfig(valid({ escalateBack: { scoreThreshold: -0.1 } })))
      .toThrow('ModelRouterConfig.escalateBack.scoreThreshold must be a number from 0 through 4')
    expect(() => resolveConfig(valid({ escalateBack: { scoreThreshold: 4.5 } })))
      .toThrow('ModelRouterConfig.escalateBack.scoreThreshold must be a number from 0 through 4')
    expect(() => resolveConfig(valid({ hardHint: { scoreThreshold: 5 } })))
      .toThrow('ModelRouterConfig.hardHint.scoreThreshold must be a number from 0 through 4')
    expect(() => resolveConfig(valid({ difficultyToEffort: { scoreThreshold: 4.5, reasoningEffort: 'high' } })))
      .toThrow('ModelRouterConfig.difficultyToEffort.scoreThreshold must be a number from 0 through 4')
  })

  it('validates thresholds against a custom rubric and does not clamp its default', () => {
    expect(resolveConfig(valid({ difficultyLevels: ['easy', 'hard', 'very hard', 'extreme'] })).escalateBackScoreThreshold)
      .toBe(3)
    expect(() => resolveConfig(valid({ difficultyLevels: ['easy', 'hard'] })))
      .toThrow('ModelRouterConfig.escalateBack.scoreThreshold must be a number from 0 through 1')
    const short = valid({
      difficultyLevels: ['easy', 'hard'],
      escalateBack: { scoreThreshold: 1 },
      difficulty: { entryScoreCeiling: 1 },
      hardHint: { scoreThreshold: 0 },
      difficultyToEffort: { scoreThreshold: 1, reasoningEffort: 'high' },
    })
    expect(resolveConfig(short)).toMatchObject({
      escalateBackScoreThreshold: 1,
      entryScoreCeiling: 1,
      hardHintScoreThreshold: 0,
      difficultyToEffort: { scoreThreshold: 1, reasoningEffort: 'high' },
    })
    expect(() => resolveConfig(valid({ difficultyLevels: ['easy', 'hard'], escalateBack: { scoreThreshold: 2 } })))
      .toThrow('ModelRouterConfig.escalateBack.scoreThreshold must be a number from 0 through 1')
    // The entry ceiling's default is not clamped to a short rubric either.
    expect(() => resolveConfig(valid({ difficultyLevels: ['easy', 'hard'], escalateBack: { scoreThreshold: 1 } })))
      .toThrow('ModelRouterConfig.difficulty.entryScoreCeiling must be a number from 0 through 1')
  })

  it('rejects entryScoreCeiling above escalateBack.scoreThreshold', () => {
    expect(() => resolveConfig(valid({ difficulty: { entryScoreCeiling: 3.5 } })))
      .toThrow('ModelRouterConfig.difficulty.entryScoreCeiling must not exceed escalateBack.scoreThreshold')
    // The default ceiling is not lowered to fit a lower exit threshold.
    expect(() => resolveConfig(valid({ escalateBack: { scoreThreshold: 1 } })))
      .toThrow('ModelRouterConfig.difficulty.entryScoreCeiling must not exceed escalateBack.scoreThreshold')
    expect(() => resolveConfig(valid({ difficulty: { entryScoreCeiling: -1 } })))
      .toThrow('ModelRouterConfig.difficulty.entryScoreCeiling must be a number from 0 through 4')
    // An empty band is valid: entry and exit then share one threshold.
    expect(resolveConfig(valid({ difficulty: { entryScoreCeiling: 3 } })).entryScoreCeiling).toBe(3)
  })

  it('requires the effort lift to name an effort', () => {
    expect(() => resolveConfig(valid({ difficultyToEffort: { scoreThreshold: 4, reasoningEffort: ' ' } })))
      .toThrow('ModelRouterConfig.difficultyToEffort.reasoningEffort must be a non-empty string')
    // A threshold-only group names no effort, so it is refused too. The input
    // goes through the unknown-typed helper because the interface requires both
    // fields: a threshold-only literal would not compile, which is the point.
    expect(() => resolveConfig(raw({ difficultyToEffort: { scoreThreshold: 4 } })))
      .toThrow('ModelRouterConfig.difficultyToEffort.reasoningEffort must be a non-empty string')
    expect(resolveConfig(valid({ difficultyToEffort: { scoreThreshold: 4, reasoningEffort: 'high' } })).difficultyToEffort)
      .toEqual({ scoreThreshold: 4, reasoningEffort: 'high' })
  })

  it('requires a non-negative integer streak horizon below a positive integer cap', () => {
    expect(() => resolveConfig(valid({ hold: { minSteps: -1 } })))
      .toThrow('ModelRouterConfig.hold.minSteps must be a non-negative integer')
    expect(() => resolveConfig(valid({ hold: { minSteps: 1.5 } })))
      .toThrow('ModelRouterConfig.hold.minSteps must be a non-negative integer')
    expect(() => resolveConfig(valid({ hold: { maxSteps: 0 } })))
      .toThrow('ModelRouterConfig.hold.maxSteps must be a positive integer')
    expect(() => resolveConfig(valid({ hold: { maxSteps: 2.5 } })))
      .toThrow('ModelRouterConfig.hold.maxSteps must be a positive integer')
    expect(() => resolveConfig(valid({ hold: { minSteps: 5, maxSteps: 4 } })))
      .toThrow('ModelRouterConfig.hold.minSteps must not exceed hold.maxSteps')
    expect(resolveConfig(valid({ hold: { minSteps: 4, maxSteps: 4 } })).hold).toEqual({ minSteps: 4, maxSteps: 4 })
  })

  it('requires a non-negative integer re-entry cooldown', () => {
    expect(() => resolveConfig(valid({ reentryCooldownTurns: -1 })))
      .toThrow('ModelRouterConfig.reentryCooldownTurns must be a non-negative integer')
    expect(() => resolveConfig(valid({ reentryCooldownTurns: 0.5 })))
      .toThrow('ModelRouterConfig.reentryCooldownTurns must be a non-negative integer')
    expect(resolveConfig(valid({ reentryCooldownTurns: 0 })).reentryCooldownTurns).toBe(0)
  })

  it('requires a positive integer judgment deadline of at most 30 seconds', () => {
    for (const judgmentDeadlineMs of [0, -1, 1.5, 30_001]) {
      expect(() => resolveConfig(valid({ judgmentDeadlineMs })))
        .toThrow('ModelRouterConfig.judgmentDeadlineMs must be a positive integer no greater than 30000')
    }
    expect(resolveConfig(valid({ judgmentDeadlineMs: 30_000 })).judgmentDeadlineMs).toBe(30_000)
  })

  it('requires integer judgment-failure bounds', () => {
    expect(() => resolveConfig(valid({ judgmentFailures: { holdTolerance: -1 } })))
      .toThrow('ModelRouterConfig.judgmentFailures.holdTolerance must be a non-negative integer')
    expect(() => resolveConfig(valid({ judgmentFailures: { breakerThreshold: 0 } })))
      .toThrow('ModelRouterConfig.judgmentFailures.breakerThreshold must be a positive integer')
    expect(() => resolveConfig(valid({ judgmentFailures: { breakerOpenTurns: 0.5 } })))
      .toThrow('ModelRouterConfig.judgmentFailures.breakerOpenTurns must be a non-negative integer')
    expect(resolveConfig(valid({ judgmentFailures: { holdTolerance: 0, breakerOpenTurns: 0 } })).judgmentFailures)
      .toEqual({ holdTolerance: 0, breakerThreshold: 3, breakerOpenTurns: 0 })
  })

  it('rejects the removed turn-counted horizon key by name', () => {
    expect(() => resolveConfig(raw({ minTurnsDowngraded: 5 })))
      .toThrow('ModelRouterConfig: unknown key "minTurnsDowngraded"')
  })

  it('requires a positive integer route-failure streak', () => {
    expect(() => resolveConfig(valid({ maxRouteErrors: 0 })))
      .toThrow('ModelRouterConfig.maxRouteErrors must be a positive integer')
    expect(() => resolveConfig(valid({ maxRouteErrors: 1.5 })))
      .toThrow('ModelRouterConfig.maxRouteErrors must be a positive integer')
  })

  it.each([1, 0, -1, 2.5])('rejects an invalid fitting alternative count %s', (maxFitCandidates) => {
    expect(() => resolveConfig(valid({ state: { maxFitCandidates } })))
      .toThrow('ModelRouterConfig.state.maxFitCandidates must be an integer of at least two')
  })

  it('requires a non-negative context window and a positive state cap', () => {
    expect(() => resolveConfig(valid({ state: { contextTurns: -1 } })))
      .toThrow('ModelRouterConfig.state.contextTurns must be a non-negative integer')
    expect(() => resolveConfig(valid({ state: { contextTurns: 0.5 } })))
      .toThrow('ModelRouterConfig.state.contextTurns must be a non-negative integer')
    expect(() => resolveConfig(valid({ state: { maxChars: 0 } })))
      .toThrow('ModelRouterConfig.state.maxChars must be a positive integer')
  })

  it('requires a known unavailable policy and tier', () => {
    expect(() => resolveConfig(raw({ onUnavailable: 'skip' })))
      .toThrow('ModelRouterConfig.onUnavailable must be "fallback" or "error"')
    expect(() => resolveConfig(raw({ inTurnFallback: 'retry' })))
      .toThrow('ModelRouterConfig.inTurnFallback must be "manual" or "off"')
    expect(resolveConfig(valid({ inTurnFallback: 'off' })).inTurnFallback).toBe('off')
    expect(() => resolveConfig(raw({ tier: 'slow' })))
      .toThrow('ModelRouterConfig.tier must be "fast" or "accurate"')
    expect(resolveConfig(valid({ onUnavailable: 'error', tier: 'accurate' })).onUnavailable).toBe('error')
    expect(resolveConfig(valid({ onUnavailable: 'error', tier: 'accurate' })).tier).toBe('accurate')
  })
})

describe('the composition schema', () => {
  /** Resolve one raw row through the plugin's static Config, as Cordis does. */
  function throughSchema(row: Record<string, unknown>): Record<string, unknown> {
    return ModelRoutingController.Config(row as unknown as ModelRouterConfig) as unknown as Record<string, unknown>
  }

  /** The row a deployment writes when it wants a non-sticky router. */
  const bare = (): Record<string, unknown> => ({
    initialMode: 'off',
    hold: { minSteps: 0 },
    downgradeThreshold: 0.8,
    downgradeMargin: 0.1,
    routeInstructions: 'Which route should handle this turn?',
  })

  it('keeps an omitted optional group absent instead of materializing its inner default', () => {
    const normalized = throughSchema(bare())
    // schemastery gives every object schema the default {}, so a bare group
    // would arrive as {} (or fully defaulted) even though the row never wrote
    // it — which would make the hint configured by default.
    expect('difficultyInstructions' in normalized).toBe(false)
    expect('difficultyToEffort' in normalized).toBe(false)
    expect('hardHint' in normalized).toBe(false)

    const resolved = resolveConfig(normalized as unknown as ModelRouterConfig)
    expect(resolved.hold).toEqual({ minSteps: 0, maxSteps: 40 })
    expect(normalized.difficulty).toEqual({ entryScoreCeiling: 2 })
    expect(normalized.reentryCooldownTurns).toBe(2)
    expect(normalized.judgmentDeadlineMs).toBe(1500)
    expect(normalized.judgmentFailures).toEqual({ holdTolerance: 2, breakerThreshold: 3, breakerOpenTurns: 5 })
    expect('difficultyInstructions' in resolved).toBe(false)
    expect(resolved.difficultyToEffort).toBeUndefined()
    expect(resolved.hardHintScoreThreshold).toBeUndefined()
  })

  it('resolves a valueless group to null and a set group exactly', () => {
    // A composition file may write `difficultyToEffort:` with no value. The
    // schema resolves that to null (never to a materialized {} or to the group's
    // inner default), and resolveConfig reads null as not configured — this is
    // the row shape that used to fail load.
    const valueless = throughSchema({ ...bare(), difficultyToEffort: null, hardHint: null })
    expect(valueless.difficultyToEffort).toBeNull()
    expect(valueless.hardHint).toBeNull()

    const resolved = resolveConfig(valueless as unknown as ModelRouterConfig)
    expect('difficultyInstructions' in resolved).toBe(false)
    expect('difficultyToEffort' in resolved).toBe(false)
    expect('hardHintScoreThreshold' in resolved).toBe(false)

    // A set group resolves exactly as written, with no default substituted.
    const set = throughSchema({
      ...bare(),
      difficultyInstructions: 'How hard is this turn?',
      difficultyToEffort: { scoreThreshold: 3, reasoningEffort: 'medium' },
    })
    expect(set.difficultyToEffort).toEqual({ scoreThreshold: 3, reasoningEffort: 'medium' })
    expect(resolveConfig(set as unknown as ModelRouterConfig).difficultyToEffort)
      .toEqual({ scoreThreshold: 3, reasoningEffort: 'medium' })
  })

  it('requires the difficulty question once the hint group is written', () => {
    // No hint and no held downgrade: the question is optional and stays absent.
    expect(resolveConfig(throughSchema(bare()) as unknown as ModelRouterConfig).difficultyInstructions).toBeUndefined()

    // Writing the group (even valueless) takes the schema's inner default, and the
    // hint then reads the difficulty answer, so the question becomes required.
    const hinted = throughSchema({ ...bare(), hardHint: {} })
    expect(hinted.hardHint).toEqual({ scoreThreshold: 3 })
    expect(() => resolveConfig(hinted as unknown as ModelRouterConfig))
      .toThrow('ModelRouterConfig.difficultyInstructions is required while hold.minSteps > 0 or hardHint')
    expect(resolveConfig({ ...hinted, difficultyInstructions: 'How hard is this turn?' } as unknown as ModelRouterConfig).hardHintScoreThreshold).toBe(3)

    // A held downgrade requires it on its own, with no hint in the row at all.
    expect(() => resolveConfig(throughSchema({ ...bare(), hold: { minSteps: 5 } }) as unknown as ModelRouterConfig))
      .toThrow('ModelRouterConfig.difficultyInstructions is required while hold.minSteps > 0 or hardHint')
  })
})

describe('resolveConfig defaults and detachment', () => {
  it('resolves every documented default', () => {
    const resolved = resolveConfig(valid())
    expect(resolved.hold).toEqual({ minSteps: DEFAULT_HOLD_MIN_STEPS, maxSteps: DEFAULT_HOLD_MAX_STEPS })
    expect(resolved.hold).toEqual({ minSteps: 20, maxSteps: 40 })
    expect(resolved.entryScoreCeiling).toBe(DEFAULT_ENTRY_SCORE_CEILING)
    expect(resolved.entryScoreCeiling).toBe(2)
    expect(resolved.reentryCooldownTurns).toBe(DEFAULT_REENTRY_COOLDOWN_TURNS)
    expect(resolved.reentryCooldownTurns).toBe(2)
    expect(resolved.judgmentDeadlineMs).toBe(DEFAULT_JUDGMENT_DEADLINE_MS)
    expect(resolved.judgmentDeadlineMs).toBe(1500)
    expect(resolved.judgmentFailures).toEqual({
      holdTolerance: DEFAULT_JUDGMENT_HOLD_TOLERANCE,
      breakerThreshold: DEFAULT_JUDGMENT_BREAKER_THRESHOLD,
      breakerOpenTurns: DEFAULT_JUDGMENT_BREAKER_OPEN_TURNS,
    })
    expect(resolved.judgmentFailures).toEqual({ holdTolerance: 2, breakerThreshold: 3, breakerOpenTurns: 5 })
    expect(resolved.escalateBackScoreThreshold).toBe(DEFAULT_ESCALATE_BACK_SCORE_THRESHOLD)
    expect(resolved.escalateBackScoreThreshold).toBe(3)
    expect(resolved.maxRouteErrors).toBe(DEFAULT_MAX_ROUTE_ERRORS)
    expect(resolved.maxRouteErrors).toBe(2)
    expect(resolved.onUnavailable).toBe('fallback')
    expect(resolved.inTurnFallback).toBe('manual')
    expect(resolved.tier).toBe('fast')
    expect(resolved.state).toEqual({
      contextTurns: DEFAULT_STATE_CONTEXT_TURNS, maxChars: DEFAULT_STATE_MAX_CHARS, maxFitCandidates: DEFAULT_STATE_MAX_FIT_CANDIDATES,
    })
    expect(resolved.state).toEqual({ contextTurns: 2, maxChars: 12_000, maxFitCandidates: 8 })
    expect(resolved.difficultyLevels).toEqual(DEFAULT_DIFFICULTY_LEVELS)
    expect(resolved.difficultyLevels).toHaveLength(5)
    expect(resolved.hardHintScoreThreshold).toBeUndefined()
    expect(resolved.difficultyToEffort).toBeUndefined()
    expect(resolveConfig(valid({ state: { contextTurns: 0, maxChars: 1 } })).state)
      .toEqual({ contextTurns: 0, maxChars: 1, maxFitCandidates: 8 })
    expect(resolveConfig(valid({ difficultyLevels: ['a', 'b'], escalateBack: { scoreThreshold: 1 }, difficulty: { entryScoreCeiling: 1 } })).difficultyLevels)
      .toEqual(['a', 'b'])
  })

  it('returns frozen facts', () => {
    const resolved = resolveConfig(valid({
      candidates: [{ ...CANDIDATE, reasoningEffort: 'low' }],
      difficultyInstructions: 'How hard?',
      difficultyToEffort: { scoreThreshold: 4, reasoningEffort: 'high' },
      hardHint: {},
      state: { contextTurns: 1, maxChars: 100 },
    }))
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.candidates)).toBe(true)
    expect(Object.isFrozen(resolved.candidates[0])).toBe(true)
    expect(Object.isFrozen(resolved.difficultyLevels)).toBe(true)
    expect(Object.isFrozen(resolved.state)).toBe(true)
    expect(Object.isFrozen(resolved.hold)).toBe(true)
    expect(Object.isFrozen(resolved.judgmentFailures)).toBe(true)
    expect(Object.isFrozen(resolved.difficultyToEffort)).toBe(true)
    // resolveConfig's own default levels are detached from the shared constant.
    expect(resolveConfig(valid()).difficultyLevels).not.toBe(DEFAULT_DIFFICULTY_LEVELS)
    // resolveConfig defaults no hardHint threshold: an absent one leaves the hint off.
    expect(resolveConfig(valid({ hardHint: {} })).hardHintScoreThreshold).toBeUndefined()
    expect(resolved.candidates[0]?.reasoningEffort).toBe('low')
  })

  it('detaches the result from the caller\u2019s arrays', () => {
    const candidates = [{ ...CANDIDATE }]
    const levels = ['one', 'two']
    const resolved = resolveConfig(valid({
      candidates, difficultyLevels: levels, escalateBack: { scoreThreshold: 1 }, difficulty: { entryScoreCeiling: 1 },
    }))

    candidates.push({ id: 'mid', provider: 'mid-provider', model: 'mid-model' })
    candidates[0]!.model = 'mutated-model'
    levels.push('three')

    expect(resolved.candidates).toHaveLength(1)
    expect(resolved.candidates[0]?.model).toBe('cheap-model')
    expect(resolved.difficultyLevels).toEqual(['one', 'two'])
  })
})
