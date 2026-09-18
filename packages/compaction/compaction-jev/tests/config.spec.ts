/**
 * \`resolveJevConfig\`: the judgment layer's required texts, level lists, score
 * floors, ratio bounds, cross-field refusals, integer bounds, discriminated
 * literals re-judged as raw values, the documented defaults, and the freeze.
 *
 * TEST DOUBLES: none. Every case calls the real resolver.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { JevCompactionEngine, inheritedBasicConfig } from '../src/index.ts'
import {
  DEFAULT_BOUNDARY_MARGIN,
  DEFAULT_BOUNDARY_THRESHOLD,
  DEFAULT_MAX_BOUNDARY_ADJUSTMENT,
  DEFAULT_MAX_ESCALATIONS,
  DEFAULT_MAX_RESCUES,
  DEFAULT_MAX_SEGMENTS_PER_CALL,
  DEFAULT_ON_VERIFY_FAILURE,
  DEFAULT_SEGMENT_CONFIDENCE,
  DEFAULT_SEGMENT_MAX_CHARS,
  DEFAULT_SEGMENT_SCORE_LEVELS,
  DEFAULT_VERIFY_MAX_CHARS,
  DEFAULT_VERIFY_MARGIN,
  DEFAULT_VERIFY_SCORE,
  DEFAULT_VERIFY_SCORE_LEVELS,
  DEFAULT_VERIFY_THRESHOLD,
  JEV_CONFIG_KEYS,
  resolveJevConfig,
} from '../src/config.ts'
import type { JevCompactionConfig, JevVerifyCheckConfig } from '../src/config.ts'

/** The three texts every case must supply, plus one battery check. */
const REQUIRED = {
  segmentScoreInstructions: 'How much does a later turn depend on this segment?',
  boundaryInstructions: 'Does this edge cut through work that belongs together?',
  verifyInstructions: 'How well does this summary preserve what a later turn needs?',
  verifyChecks: [{ name: 'constraints', instructions: 'Does the summary drop a stated constraint?' }],
} satisfies JevCompactionConfig

/** One case's config: the required texts plus the caller's overrides. */
function config(overrides: Record<string, unknown> = {}): JevCompactionConfig {
  return { ...REQUIRED, ...overrides }
}

/** The same config with one required text removed, which a spread cannot express. */
function configWithout(key: keyof typeof REQUIRED): JevCompactionConfig {
  return Object.fromEntries(
    Object.entries(REQUIRED).filter(([name]) => name !== key),
  ) as unknown as JevCompactionConfig
}

/** One battery check with the given name and instructions. */
function check(name: string, instructions = 'Does the draft break this rule?'): JevVerifyCheckConfig {
  return { name, instructions }
}

describe('resolveJevConfig required texts', () => {
  it.each([
    ['segmentScoreInstructions', /segmentScoreInstructions must be a non-empty string/],
    ['boundaryInstructions', /boundaryInstructions must be a non-empty string/],
    ['verifyInstructions', /verifyInstructions must be a non-empty string/],
  ] as Array<[keyof typeof REQUIRED, RegExp]>)('refuses a missing %s', (key, pattern) => {
    expect(() => resolveJevConfig(configWithout(key))).toThrow(pattern)
  })

  it.each([
    ['segmentScoreInstructions', '   ', /segmentScoreInstructions must be a non-empty string/],
    ['boundaryInstructions', '', /boundaryInstructions must be a non-empty string/],
    ['verifyInstructions', '\n\t', /verifyInstructions must be a non-empty string/],
  ] as Array<[keyof typeof REQUIRED, string, RegExp]>)('refuses a blank %s', (key, value, pattern) => {
    expect(() => resolveJevConfig(config({ [key]: value }))).toThrow(pattern)
  })
})

describe('resolveJevConfig verify battery', () => {
  it.each([
    [undefined, /verifyChecks must list at least one named binary check/],
    [[], /verifyChecks must list at least one named binary check/],
    ['constraints', /verifyChecks must list at least one named binary check/],
  ])('refuses %# as a battery', (value, pattern) => {
    expect(() => resolveJevConfig(config({ verifyChecks: value }))).toThrow(pattern)
  })

  it('refuses a check with a missing or blank name', () => {
    expect(() => resolveJevConfig(config({ verifyChecks: [{ instructions: 'i' }] })))
      .toThrow(/verifyChecks\[\]\.name must be a non-empty string/)
    expect(() => resolveJevConfig(config({ verifyChecks: [check('  ')] })))
      .toThrow(/verifyChecks\[\]\.name must be a non-empty string/)
  })

  it('refuses a check with a missing or blank instruction', () => {
    expect(() => resolveJevConfig(config({ verifyChecks: [{ name: 'constraints' }] })))
      .toThrow(/verifyChecks\["constraints"\]\.instructions must be a non-empty string/)
    expect(() => resolveJevConfig(config({ verifyChecks: [check('constraints', '')] })))
      .toThrow(/verifyChecks\["constraints"\]\.instructions must be a non-empty string/)
  })

  it('refuses a battery that names one check twice', () => {
    expect(() => resolveJevConfig(config({ verifyChecks: [check('errors'), check('errors')] })))
      .toThrow(/verifyChecks lists "errors" more than once/)
  })

  it('keeps battery checks in configuration order and detaches each one', () => {
    const source = { name: 'errors', instructions: 'Does the summary invent an error?' }
    const resolved = resolveJevConfig(config({ verifyChecks: [check('constraints'), source] }))

    expect(resolved.jev.verifyChecks.map(entry => entry.name)).toEqual(['constraints', 'errors'])
    expect(Object.isFrozen(resolved.jev.verifyChecks)).toBe(true)
    expect(resolved.jev.verifyChecks[1]).not.toBe(source)
    expect(Object.isFrozen(resolved.jev.verifyChecks[1])).toBe(true)
  })
})

describe('resolveJevConfig ordered level lists', () => {
  it.each(['segmentScoreLevels', 'verifyScoreLevels'])('refuses a single-level %s', (key) => {
    expect(() => resolveJevConfig(config({ [key]: ['only'] })))
      .toThrow(new RegExp(`${key} needs at least two ordered level descriptions`))
  })

  it.each(['segmentScoreLevels', 'verifyScoreLevels'])('refuses an empty %s', (key) => {
    expect(() => resolveJevConfig(config({ [key]: [] })))
      .toThrow(new RegExp(`${key} needs at least two ordered level descriptions`))
  })

  it.each([
    ['segmentScoreLevels', 0, /segmentScoreLevels\[0\] must be a non-empty string/],
    ['segmentScoreLevels', 1, /segmentScoreLevels\[1\] must be a non-empty string/],
    ['verifyScoreLevels', 1, /verifyScoreLevels\[1\] must be a non-empty string/],
  ] as Array<[string, number, RegExp]>)('refuses a blank %s entry at %#', (key, index, pattern) => {
    const levels = ['low', 'blanked'].map((level, position) => position === index ? '   ' : level)
    expect(() => resolveJevConfig(config({ [key]: levels }))).toThrow(pattern)
  })

  it('keeps configured levels in order and freezes a detached copy', () => {
    const levels = ['cheap', 'costly']
    const resolved = resolveJevConfig(config({ segmentScoreLevels: levels, rescueScore: 1 }))
    levels.push('mutated')

    expect(resolved.jev.segmentScoreLevels).toEqual(['cheap', 'costly'])
    expect(Object.isFrozen(resolved.jev.segmentScoreLevels)).toBe(true)
  })
})

describe('resolveJevConfig score floors against their own scale', () => {
  it.each([
    ['rescueScore', 5],
    ['rescueScore', -1],
    ['rescueScore', Number.NaN],
    ['rescueScore', '3'],
  ])('refuses %s = %s on the default five-level scale', (key, value) => {
    expect(() => resolveJevConfig(config({ [key]: value })))
      .toThrow(/rescueScore must be a number from 0 through 4/)
  })

  it.each([
    ['verifyScore', 5],
    ['verifyScore', -1],
    ['verifyScore', Number.POSITIVE_INFINITY],
  ])('refuses %s = %s on the default five-level scale', (key, value) => {
    expect(() => resolveJevConfig(config({ [key]: value })))
      .toThrow(/verifyScore must be a number from 0 through 4/)
  })

  it('scales the floors to a configured level list', () => {
    const resolved = resolveJevConfig(config({
      segmentScoreLevels: ['keep', 'drop'],
      verifyScoreLevels: ['bad', 'good', 'great'],
      rescueScore: 1,
      verifyScore: 2,
    }))

    expect(resolved.jev.rescueScore).toBe(1)
    expect(resolved.jev.verifyScore).toBe(2)
    expect(() => resolveJevConfig(config({ segmentScoreLevels: ['keep', 'drop'], rescueScore: 2 })))
      .toThrow(/rescueScore must be a number from 0 through 1/)
  })
})

describe('resolveJevConfig ratio bounds and cross-field margins', () => {
  it.each([
    'segmentConfidence',
    'boundaryThreshold',
    'boundaryMargin',
    'verifyThreshold',
    'verifyMargin',
  ])('refuses %s outside [0, 1]', (key) => {
    const pattern = new RegExp(`${key} must be a number from 0 through 1`)
    expect(() => resolveJevConfig(config({ [key]: -0.01 }))).toThrow(pattern)
    expect(() => resolveJevConfig(config({ [key]: 1.01 }))).toThrow(pattern)
    expect(() => resolveJevConfig(config({ [key]: Number.NaN }))).toThrow(pattern)
    expect(() => resolveJevConfig(config({ [key]: 'half' }))).toThrow(pattern)
  })

  it('refuses a boundary margin above the boundary threshold', () => {
    expect(() => resolveJevConfig(config({ boundaryThreshold: 0.2, boundaryMargin: 0.21 })))
      .toThrow(/boundaryMargin must not exceed boundaryThreshold/)
  })

  it('refuses a verify margin above the verify threshold', () => {
    expect(() => resolveJevConfig(config({ verifyThreshold: 0.2, verifyMargin: 0.21 })))
      .toThrow(/verifyMargin must not exceed verifyThreshold/)
  })

  it('accepts a margin exactly equal to its threshold', () => {
    const resolved = resolveJevConfig(config({ boundaryThreshold: 0.3, boundaryMargin: 0.3, verifyThreshold: 0.4, verifyMargin: 0.4 }))
    expect(resolved.jev.boundaryMargin).toBe(0.3)
    expect(resolved.jev.verifyMargin).toBe(0.4)
  })
})

describe('resolveJevConfig escalation pair', () => {
  it.each([
    [{ escalationProvider: 'strong-provider' }, /escalationProvider and escalationModel must be set together/],
    [{ escalationModel: 'strong-model' }, /escalationProvider and escalationModel must be set together/],
  ])('refuses one half of the pair %#', (overrides, pattern) => {
    expect(() => resolveJevConfig(config(overrides))).toThrow(pattern)
  })

  it('refuses a blank provider or model when both are set', () => {
    expect(() => resolveJevConfig(config({ escalationProvider: '  ', escalationModel: 'strong-model' })))
      .toThrow(/escalationProvider must be a non-empty string/)
    expect(() => resolveJevConfig(config({ escalationProvider: 'strong-provider', escalationModel: '' })))
      .toThrow(/escalationModel must be a non-empty string/)
  })

  it('records the pair as a frozen target when both are set', () => {
    const resolved = resolveJevConfig(config({ escalationProvider: 'strong-provider', escalationModel: 'strong-model' }))
    expect(resolved.jev.escalation).toEqual({ provider: 'strong-provider', model: 'strong-model' })
    expect(Object.isFrozen(resolved.jev.escalation)).toBe(true)
  })
})

describe('resolveJevConfig integer bounds', () => {
  it.each([
    ['maxSegmentsPerCall', 0],
    ['maxSegmentsPerCall', -1],
    ['maxSegmentsPerCall', 1.5],
    ['maxSegmentsPerCall', '4'],
    ['segmentMaxChars', 0],
    ['segmentMaxChars', -1],
    ['segmentMaxChars', 1.5],
    ['segmentMaxChars', '2000'],
    ['verifyMaxChars', 0],
    ['verifyMaxChars', -1],
    ['verifyMaxChars', 1.5],
    ['verifyMaxChars', '6000'],
  ] as Array<[string, unknown]>)('refuses a non-positive %s = %s', (key, value) => {
    expect(() => resolveJevConfig(config({ [key]: value })))
      .toThrow(new RegExp(`${key} must be a positive integer`))
  })

  it.each([
    ['maxRescues', -1],
    ['maxRescues', 1.5],
    ['maxRescues', '2'],
    ['maxBoundaryAdjustment', -1],
    ['maxBoundaryAdjustment', 0.5],
    ['maxBoundaryAdjustment', '2'],
    ['maxEscalations', -1],
    ['maxEscalations', 1.5],
    ['maxEscalations', '1'],
  ] as Array<[string, unknown]>)('refuses a non-integer %s = %s', (key, value) => {
    expect(() => resolveJevConfig(config({ [key]: value })))
      .toThrow(new RegExp(`${key} must be a non-negative integer`))
  })

  it.each(['maxRescues', 'maxBoundaryAdjustment', 'maxEscalations'])('accepts zero for %s', (key) => {
    const resolved = resolveJevConfig(config({ [key]: 0 }))
    expect(resolved.jev[key as 'maxRescues' | 'maxBoundaryAdjustment' | 'maxEscalations']).toBe(0)
  })
})

describe('resolveJevConfig discriminated literals', () => {
  it('refuses an unknown tier read as a raw value', () => {
    expect(() => resolveJevConfig(config({ tier: 'thorough' })))
      .toThrow(/tier must be "fast" or "accurate"/)
  })

  it('refuses an unknown onVerifyFailure read as a raw value', () => {
    expect(() => resolveJevConfig(config({ onVerifyFailure: 'log-only' })))
      .toThrow(/onVerifyFailure must be "accept-logged" or "fail-attempt"/)
  })

  it('keeps an explicit fast tier and an explicit fail-attempt policy', () => {
    const resolved = resolveJevConfig(config({ tier: 'fast', onVerifyFailure: 'fail-attempt' }))
    expect(resolved.jev.tier).toBe('fast')
    expect(resolved.jev.onVerifyFailure).toBe('fail-attempt')
  })
})

describe('resolveJevConfig documented defaults', () => {
  it('resolves every documented default and freezes the result', () => {
    const resolved = resolveJevConfig(config())

    expect(resolved.jev).toEqual({
      tier: 'accurate',
      segmentScoreInstructions: REQUIRED.segmentScoreInstructions,
      segmentScoreLevels: [...DEFAULT_SEGMENT_SCORE_LEVELS],
      boundaryInstructions: REQUIRED.boundaryInstructions,
      verifyInstructions: REQUIRED.verifyInstructions,
      verifyChecks: [{ name: 'constraints', instructions: 'Does the summary drop a stated constraint?' }],
      verifyScoreLevels: [...DEFAULT_VERIFY_SCORE_LEVELS],
      maxSegmentsPerCall: 4,
      segmentMaxChars: 2_000,
      verifyMaxChars: 6_000,
      rescueScore: 3,
      segmentConfidence: 0.6,
      maxRescues: 2,
      boundaryThreshold: 0.4,
      boundaryMargin: 0.15,
      maxBoundaryAdjustment: 2,
      verifyThreshold: 0.7,
      verifyMargin: 0.1,
      verifyScore: 4,
      maxEscalations: 1,
      onVerifyFailure: 'accept-logged',
    })
    expect(resolved.jev).not.toHaveProperty('escalation')
    expect(resolved.jev.segmentScoreLevels).toHaveLength(5)
    expect(resolved.jev.verifyScoreLevels).toHaveLength(5)
    expect(Object.isFrozen(resolved.jev)).toBe(true)
  })

  it('pins the exported default constants to the resolved defaults', () => {
    expect([
      DEFAULT_MAX_SEGMENTS_PER_CALL,
      DEFAULT_SEGMENT_MAX_CHARS,
      DEFAULT_VERIFY_MAX_CHARS,
      DEFAULT_SEGMENT_CONFIDENCE,
      DEFAULT_MAX_RESCUES,
      DEFAULT_BOUNDARY_THRESHOLD,
      DEFAULT_BOUNDARY_MARGIN,
      DEFAULT_MAX_BOUNDARY_ADJUSTMENT,
      DEFAULT_VERIFY_THRESHOLD,
      DEFAULT_VERIFY_MARGIN,
      DEFAULT_VERIFY_SCORE,
      DEFAULT_MAX_ESCALATIONS,
    ]).toEqual([4, 2_000, 6_000, 0.6, 2, 0.4, 0.15, 2, 0.7, 0.1, 4, 1])
    expect(DEFAULT_ON_VERIFY_FAILURE).toBe('accept-logged')
    expect(Object.isFrozen(DEFAULT_SEGMENT_SCORE_LEVELS)).toBe(true)
    expect(Object.isFrozen(DEFAULT_VERIFY_SCORE_LEVELS)).toBe(true)
  })

  it('names every judgment key this backend adds on top of the inherited policy', () => {
    expect([...JEV_CONFIG_KEYS]).toEqual([
      'tier',
      'segmentScoreInstructions',
      'segmentScoreLevels',
      'boundaryInstructions',
      'verifyInstructions',
      'verifyChecks',
      'verifyScoreLevels',
      'maxSegmentsPerCall',
      'segmentMaxChars',
      'verifyMaxChars',
      'rescueScore',
      'segmentConfidence',
      'maxRescues',
      'boundaryThreshold',
      'boundaryMargin',
      'maxBoundaryAdjustment',
      'verifyThreshold',
      'verifyMargin',
      'verifyScore',
      'escalationProvider',
      'escalationModel',
      'maxEscalations',
      'onVerifyFailure',
    ])
  })

  it('resolves the judgment layer independently of the inherited policy fields', () => {
    const resolved = resolveJevConfig(config({ thresholdRatio: 0.5, auto: false, tier: 'fast' }))
    expect(Object.keys(resolved)).toEqual(['jev'])
    expect(resolved.jev.tier).toBe('fast')
  })
})

describe('the inherited config partition', () => {
  it('removes exactly the judgment keys the inherited resolver would reject', () => {
    const raw = config({ auto: false, thresholdRatio: 0.6, retainTokens: 50, maxPointers: 0 })
    const inherited = inheritedBasicConfig(raw)

    expect(Object.keys(inherited).sort())
      .toEqual(['auto', 'maxPointers', 'retainTokens', 'thresholdRatio'])
    for (const key of JEV_CONFIG_KEYS) expect(inherited).not.toHaveProperty(key)
    // The configuration the engine keeps still carries everything the judgment
    // layer resolves.
    expect(resolveJevConfig(raw).jev).toMatchObject({
      tier: 'accurate',
      rescueScore: 3,
      verifyChecks: [{ name: 'constraints' }],
    })
  })

  it('constructs the real engine with a judgment-only config and resolves the inherited policy', () => {
    // Regression proof for the config partition: before it existed, this
    // construction threw 'BasicCompactionConfig: unknown key
    // "segmentScoreInstructions"', because the base resolver rejects every
    // judgment key by name.
    const engine = new JevCompactionEngine(new Context(), config({
      auto: false,
      thresholdRatio: 0.6,
      retainTokens: 50,
      maxPointers: 0,
      tier: 'fast',
      rescueScore: 2,
      onVerifyFailure: 'fail-attempt',
    }))

    expect(engine).toBeInstanceOf(JevCompactionEngine)
    expect(engine.config).toMatchObject({
      auto: false,
      thresholdRatio: 0.6,
      retainTokens: 50,
      maxPointers: 0,
      pinSeqs: [],
      summarizationProvider: '',
      compactionRetries: 1,
    })
    // Nothing judgment-shaped reached the inherited policy.
    for (const key of JEV_CONFIG_KEYS) expect(engine.config).not.toHaveProperty(key)

    // An inherited policy the same config never mentions still resolves to its
    // documented defaults.
    const defaults = new JevCompactionEngine(new Context(), config({ auto: false }))
    expect(defaults.config).toMatchObject({
      auto: false,
      thresholdRatio: 0.8,
      retainRatio: 0.16,
      maxTokens: 8192,
    })
  })
})
