/**
 * The one explicit resolve step: defaults, every deployment-varying bound, and
 * every way a raw composition entry or settings snapshot is refused by name.
 * Misconfiguration fails at the earliest resolvable point, so each rejection is
 * pinned here rather than left to the schema alone.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_JUDGMENT_CONFIDENCE,
  DEFAULT_JUDGMENT_MARGIN,
  DEFAULT_JUDGMENT_TIER,
  DEFAULT_MAX_ARG_CHARS,
  DEFAULT_MAX_ARBITER_DEPTH,
  DEFAULT_MAX_CONTINUES,
  DEFAULT_MAX_DIGEST_CHARS,
  DEFAULT_MAX_DIGEST_TOOLS,
  DEFAULT_MAX_EXCERPT_CHARS,
  DEFAULT_MIN_STEPS_BETWEEN,
  DEFAULT_TRIGGER_THRESHOLDS,
  ESCALATION_TRIGGERS,
  WORKER_ESCALATION_SETTINGS_NAMESPACE,
  resolveConfig,
} from '../src/config.ts'
import type { ResolvedWorkerEscalationConfig, WorkerEscalationConfig } from '../src/config.ts'

/** Every trigger row off, which the cross-field rule refuses while the ladder is on. */
const ALL_ROWS_OFF = {
  errorBurst: { enabled: false },
  attemptCount: { enabled: false },
  repeatRunLength: { enabled: false },
  stepBudgetExhausted: { enabled: false },
  turnFailureStreak: { enabled: false },
} as const

/** The required question text, supplied by every case that is not about its absence. */
const PROGRESS = 'Is this worker going to finish without help?'

/**
 * Resolve a raw entry exactly as a composition file or settings snapshot
 * reaches the resolver: the cast is the point of the resolver, which re-judges
 * the values a type cannot vouch for.
 * @param raw - raw ladder fields.
 * @returns the resolved configuration.
 */
function resolve(raw: Record<string, unknown>): ResolvedWorkerEscalationConfig {
  return resolveConfig({ progressInstructions: PROGRESS, ...raw })
}

describe('settings namespace', () => {
  it('is the ladder\'s own namespace', () => {
    expect(WORKER_ESCALATION_SETTINGS_NAMESPACE).toBe('worker-escalation')
  })
})

describe('resolveConfig defaults', () => {
  it('ships off with every trigger row on at its own default count', () => {
    const config = resolve({})
    expect(config.enabled).toBe(false)
    expect(config.triggers).toEqual({
      errorBurst: { enabled: true, threshold: DEFAULT_TRIGGER_THRESHOLDS.errorBurst },
      attemptCount: { enabled: true, threshold: DEFAULT_TRIGGER_THRESHOLDS.attemptCount },
      repeatRunLength: { enabled: true, threshold: DEFAULT_TRIGGER_THRESHOLDS.repeatRunLength },
      stepBudgetExhausted: { enabled: true, threshold: DEFAULT_TRIGGER_THRESHOLDS.stepBudgetExhausted },
      turnFailureStreak: { enabled: true, threshold: DEFAULT_TRIGGER_THRESHOLDS.turnFailureStreak },
    })
    expect(config.maxContinues).toBe(DEFAULT_MAX_CONTINUES)
    expect(config.maxArbiterDepth).toBe(DEFAULT_MAX_ARBITER_DEPTH)
    expect(config.minStepsBetween).toBe(DEFAULT_MIN_STEPS_BETWEEN)
    expect(config.maxDigestTools).toBe(DEFAULT_MAX_DIGEST_TOOLS)
    expect(config.maxDigestChars).toBe(DEFAULT_MAX_DIGEST_CHARS)
    expect(config.maxExcerptChars).toBe(DEFAULT_MAX_EXCERPT_CHARS)
    expect(config.maxArgChars).toBe(DEFAULT_MAX_ARG_CHARS)
    expect(config.progressInstructions).toBe(PROGRESS)
    expect(config.confidence).toBe(DEFAULT_JUDGMENT_CONFIDENCE)
    expect(config.margin).toBe(DEFAULT_JUDGMENT_MARGIN)
    expect(config.judgmentTier).toBe(DEFAULT_JUDGMENT_TIER)
  })

  it('detaches the resolved facts', () => {
    const config = resolve({})
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.triggers)).toBe(true)
    expect(Object.isFrozen(config.triggers.errorBurst)).toBe(true)
  })

  it('keeps an omitted row and an explicit row on the same defaults', () => {
    expect(resolve({ triggers: { errorBurst: {} } }).triggers.errorBurst).toEqual(resolve({}).triggers.errorBurst)
    expect(resolve({ triggers: { errorBurst: { enabled: true } } }).triggers.errorBurst.enabled).toBe(true)
  })

  it('reads each trigger row\'s own threshold key', () => {
    const rows = [
      ['errorBurst', 'burst'],
      ['attemptCount', 'attempts'],
      ['repeatRunLength', 'runLength'],
      ['stepBudgetExhausted', 'exhaustions'],
      ['turnFailureStreak', 'streak'],
    ] as const
    for (const [trigger, key] of rows) {
      const config = resolve({ triggers: { [trigger]: { enabled: true, [key]: 7 } } })
      expect(config.triggers[trigger]).toEqual({ enabled: true, threshold: 7 })
    }
    expect(ESCALATION_TRIGGERS).toEqual(rows.map(row => row[0]))
  })

  it('accepts the documented zero-valued bounds', () => {
    const config = resolve({ enabled: true, maxContinues: 0, minStepsBetween: 0 })
    expect(config.maxContinues).toBe(0)
    expect(config.minStepsBetween).toBe(0)
  })

  it('reads each Stage 1 field it was given, and its own defaults otherwise', () => {
    const config = resolve({
      progressInstructions: 'Should the worker keep going?',
      confidence: 0.5,
      margin: 0,
      judgmentTier: 'fast',
    })
    expect(config.progressInstructions).toBe('Should the worker keep going?')
    expect(config.confidence).toBe(0.5)
    expect(config.margin).toBe(0)
    expect(config.judgmentTier).toBe('fast')
    // The documented operating points ship as the defaults.
    expect(DEFAULT_JUDGMENT_CONFIDENCE).toBe(0.8)
    expect(DEFAULT_JUDGMENT_MARGIN).toBe(0.1)
    expect(DEFAULT_JUDGMENT_TIER).toBe('accurate')
  })

  it('accepts a row-enabled ladder with every other row disabled', () => {
    const config = resolve({
      enabled: true,
      triggers: { ...ALL_ROWS_OFF, errorBurst: { enabled: true, burst: 5 } },
    })
    expect(config.enabled).toBe(true)
    expect(config.triggers.errorBurst).toEqual({ enabled: true, threshold: 5 })
    expect(config.triggers.attemptCount.enabled).toBe(false)
  })
})

describe('resolveConfig rejections', () => {
  it('refuses an unknown key by name', () => {
    expect(() => resolve({ nope: 1 })).toThrow(/unknown key "nope"/)
  })

  it('refuses an unknown trigger row by name', () => {
    expect(() => resolve({ triggers: { bogus: {} } })).toThrow(/unknown trigger "bogus"/)
  })

  it('refuses an unknown key inside a trigger row by name', () => {
    expect(() => resolve({ triggers: { errorBurst: { attempts: 3 } } }))
      .toThrow(/triggers.errorBurst: unknown key "attempts"/)
    expect(() => resolve({ triggers: { turnFailureStreak: { errorBurst: 3 } } }))
      .toThrow(/triggers.turnFailureStreak: unknown key "errorBurst"/)
  })

  it('refuses a non-boolean enabled bit', () => {
    expect(() => resolve({ enabled: 'yes' })).toThrow(/WorkerEscalationConfig.enabled must be a boolean/)
    expect(() => resolve({ triggers: { errorBurst: { enabled: 1 } } }))
      .toThrow(/triggers.errorBurst.enabled must be a boolean/)
  })

  it('refuses a count that is not a positive integer', () => {
    for (const key of ['burst', 'attempts', 'runLength', 'exhaustions', 'streak']) {
      const trigger = { burst: 'errorBurst', attempts: 'attemptCount', runLength: 'repeatRunLength', exhaustions: 'stepBudgetExhausted', streak: 'turnFailureStreak' }[key]
      expect(() => resolve({ triggers: { [trigger as string]: { [key]: 1.5 } } }))
        .toThrow(new RegExp('triggers\\.' + String(trigger) + '\\.' + key + ' must be an integer >= 1'))
      expect(() => resolve({ triggers: { [trigger as string]: { [key]: 0 } } }))
        .toThrow(new RegExp('triggers\\.' + String(trigger) + '\\.' + key + ' must be an integer >= 1'))
      expect(() => resolve({ triggers: { [trigger as string]: { [key]: 'many' } } }))
        .toThrow(new RegExp('triggers\\.' + String(trigger) + '\\.' + key + ' must be an integer >= 1'))
    }
  })

  it('refuses an enabled ladder whose every trigger row is disabled', () => {
    expect(() => resolve({ enabled: true, triggers: ALL_ROWS_OFF }))
      .toThrow(/enabled is true while every trigger row is disabled/)
  })

  it('refuses a non-integer count outside the trigger table', () => {
    for (const field of ['maxContinues', 'minStepsBetween']) {
      expect(() => resolve({ [field]: -1 })).toThrow(new RegExp(field + ' must be a non-negative integer'))
      expect(() => resolve({ [field]: 1.5 })).toThrow(new RegExp(field + ' must be a non-negative integer'))
      expect(() => resolve({ [field]: 'two' })).toThrow(new RegExp(field + ' must be a non-negative integer'))
    }
  })

  it('refuses a non-positive count outside the trigger table', () => {
    for (const field of ['maxDigestTools', 'maxDigestChars', 'maxExcerptChars', 'maxArgChars']) {
      expect(() => resolve({ [field]: 0 })).toThrow(new RegExp(field + ' must be an integer >= 1'))
      expect(() => resolve({ [field]: 2.5 })).toThrow(new RegExp(field + ' must be an integer >= 1'))
      expect(() => resolve({ [field]: 'wide' })).toThrow(new RegExp(field + ' must be an integer >= 1'))
    }
  })

  it('refuses a missing or blank question text by name', () => {
    expect(() => resolveConfig({} as unknown as WorkerEscalationConfig))
      .toThrow(/progressInstructions must be a non-empty string/)
    expect(() => resolveConfig({ progressInstructions: '' }))
      .toThrow(/progressInstructions must be a non-empty string/)
    expect(() => resolveConfig({ progressInstructions: '   ' }))
      .toThrow(/progressInstructions must be a non-empty string/)
  })

  it('refuses a gate outside the probability range', () => {
    for (const field of ['confidence', 'margin']) {
      for (const value of [-0.1, 1.5, 'high']) {
        expect(() => resolve({ [field]: value })).toThrow(new RegExp(field + ' must be a number from 0 through 1'))
      }
    }
  })

  it('refuses a judgment tier the seam does not carry', () => {
    expect(() => resolve({ judgmentTier: 'cheap' }))
      .toThrow(/judgmentTier must be "fast" or "accurate"/)
  })

  it('refuses a delegation-depth cap that would engage no session', () => {
    for (const value of [0, 1.5, 'one']) {
      expect(() => resolve({ maxArbiterDepth: value }))
        .toThrow(/maxArbiterDepth must be an integer >= 1/)
    }
  })
})
