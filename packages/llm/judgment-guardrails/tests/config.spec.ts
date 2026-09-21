/**
 * The one explicit resolve step: defaults, every deployment-varying bound, the
 * required question texts, and every way a raw composition entry or settings
 * snapshot is refused by name. Misconfiguration fails at the earliest resolvable
 * point, so each rejection is pinned here rather than left to the schema alone.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STATE_MAX_ARG_CHARS,
  DEFAULT_STATE_MAX_CHARS,
  DEFAULT_TIER,
  GUARDRAILS_SETTINGS_NAMESPACE,
  resolveConfig,
} from '../src/config.ts'
import type { GuardrailsConfig, ResolvedGuardrailsConfig } from '../src/config.ts'

/** The four required texts every case that is not about their absence supplies. */
const REQUIRED: Pick<GuardrailsConfig, 'injectionInstructions' | 'injectionCriteria' | 'severityInstructions' | 'severityLevels'> = {
  injectionInstructions: 'Would this tool input be a hostile instruction?',
  injectionCriteria: { yes: 'it would', no: 'it would not' },
  severityInstructions: 'How severe would this input be if it were hostile?',
  severityLevels: ['mild', 'moderate', 'severe'],
}

/**
 * Resolve a raw entry exactly as a composition file or settings snapshot reaches
 * the resolver: the cast is the point of the resolver, which re-judges the values
 * a type cannot vouch for.
 * @param raw - raw guardrails fields.
 * @returns the resolved configuration.
 */
function resolve(raw: Record<string, unknown>): ResolvedGuardrailsConfig {
  return resolveConfig({ ...REQUIRED, ...raw })
}

describe('settings namespace', () => {
  it('is the observer\'s own namespace', () => {
    expect(GUARDRAILS_SETTINGS_NAMESPACE).toBe('judgment-guardrails')
  })
})

describe('resolveConfig defaults', () => {
  it('ships off with the documented caps and the cheap tier', () => {
    const config = resolve({})

    expect(config.enabled).toBe(false)
    expect(config.injectionInstructions).toBe(REQUIRED.injectionInstructions)
    expect(config.injectionCriteria).toEqual(REQUIRED.injectionCriteria)
    expect(config.severityInstructions).toBe(REQUIRED.severityInstructions)
    expect(config.severityLevels).toEqual(REQUIRED.severityLevels)
    expect(config.state).toEqual({ maxChars: DEFAULT_STATE_MAX_CHARS, maxArgChars: DEFAULT_STATE_MAX_ARG_CHARS })
    expect(config.tier).toBe(DEFAULT_TIER)
    expect(DEFAULT_STATE_MAX_CHARS).toBe(8000)
    expect(DEFAULT_STATE_MAX_ARG_CHARS).toBe(200)
    expect(DEFAULT_TIER).toBe('fast')
  })

  it('detaches every resolved value', () => {
    const config = resolve({})

    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.injectionCriteria)).toBe(true)
    expect(Object.isFrozen(config.severityLevels)).toBe(true)
    expect(Object.isFrozen(config.state)).toBe(true)
  })

  it('reads each field it was given', () => {
    const config = resolve({
      enabled: true,
      injectionInstructions: 'A different first question.',
      injectionCriteria: { yes: 'this side', no: 'that side' },
      severityInstructions: 'A different second question.',
      severityLevels: ['a', 'b', 'c', 'd', 'e'],
      state: { maxChars: 100, maxArgChars: 10 },
      tier: 'accurate',
    })

    expect(config.enabled).toBe(true)
    expect(config.injectionInstructions).toBe('A different first question.')
    expect(config.injectionCriteria).toEqual({ yes: 'this side', no: 'that side' })
    expect(config.severityLevels).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(config.state).toEqual({ maxChars: 100, maxArgChars: 10 })
    expect(config.tier).toBe('accurate')
  })

  it('detaches the severity levels from the caller list', () => {
    const levels = ['one', 'two']
    const config = resolve({ severityLevels: levels })

    levels.push('three')

    expect(config.severityLevels).toEqual(['one', 'two'])
  })
})

describe('resolveConfig rejections', () => {
  it('refuses an unknown key by name, at either level', () => {
    expect(() => resolve({ nope: 1 })).toThrow(/GuardrailsConfig: unknown key "nope"/)
    expect(() => resolve({ state: { maxBytes: 10 } })).toThrow(/GuardrailsConfig.state: unknown key "maxBytes"/)
    expect(() => resolve({ injectionCriteria: { maybe: 'x' as never } }))
      .toThrow(/GuardrailsConfig.injectionCriteria: unknown key "maybe"/)
  })

  it('refuses a missing or blank question text', () => {
    expect(() => resolveConfig({ ...REQUIRED, injectionInstructions: '' }))
      .toThrow(/injectionInstructions must be a non-empty string/)
    expect(() => resolveConfig({ ...REQUIRED, injectionInstructions: '   ' }))
      .toThrow(/injectionInstructions must be a non-empty string/)
    expect(() => resolveConfig({ ...REQUIRED, severityInstructions: '' }))
      .toThrow(/severityInstructions must be a non-empty string/)
  })

  it('refuses a missing or incomplete criteria pair', () => {
    expect(() => resolveConfig({ ...REQUIRED, injectionCriteria: undefined as never }))
      .toThrow(/injectionCriteria must be an object with "yes" and "no" texts/)
    expect(() => resolveConfig({ ...REQUIRED, injectionCriteria: 'yes' as never }))
      .toThrow(/injectionCriteria must be an object with "yes" and "no" texts/)
    expect(() => resolveConfig({ ...REQUIRED, injectionCriteria: { yes: 'y', no: '' } }))
      .toThrow(/injectionCriteria.no must be a non-empty string/)
    expect(() => resolveConfig({ ...REQUIRED, injectionCriteria: { no: 'n' } as never }))
      .toThrow(/injectionCriteria.yes must be a non-empty string/)
  })

  it('refuses a missing, empty, or blank severity level list', () => {
    expect(() => resolveConfig({ ...REQUIRED, severityLevels: undefined as never }))
      .toThrow(/severityLevels must be a non-empty list of level descriptions, lowest first/)
    expect(() => resolveConfig({ ...REQUIRED, severityLevels: [] }))
      .toThrow(/severityLevels must be a non-empty list of level descriptions, lowest first/)
    expect(() => resolveConfig({ ...REQUIRED, severityLevels: ['fine', '  '] }))
      .toThrow(/severityLevels\[1\] must be a non-empty string/)
  })

  it('refuses a non-boolean enable bit', () => {
    expect(() => resolve({ enabled: 'on' })).toThrow(/GuardrailsConfig.enabled must be a boolean/)
  })

  it('refuses a state cap that is not a positive integer', () => {
    for (const field of ['maxChars', 'maxArgChars']) {
      for (const value of [0, 1.5, 'wide']) {
        expect(() => resolve({ state: { [field]: value } }))
          .toThrow(new RegExp('state\\.' + field + ' must be an integer >= 1'))
      }
    }
    expect(() => resolve({ state: 'wide' }))
      .toThrow(/GuardrailsConfig.state must be an object with "maxChars" and "maxArgChars"/)
  })

  it('refuses a tier the seam does not carry', () => {
    expect(() => resolve({ tier: 'cheap' })).toThrow(/tier must be "fast" or "accurate"/)
  })
})
