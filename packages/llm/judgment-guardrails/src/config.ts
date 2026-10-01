/**
 * Configuration schema, defaults, and the one explicit resolve step of the
 * guardrails observer.
 *
 * Every deployment-varying choice is a validated field, and the two question
 * texts are required rather than defaulted: the judgment engine owns no prose of
 * its own, so the package that composes the check owns the text the engine
 * reads. Unknown keys and cross-field mistakes fail plugin load by name.
 *
 * @module @shres-code/shres-code-judgment-guardrails/config
 */

import { settingsNamespace } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import type { JudgmentTier } from '@shres-code/shres-code-judgment'

/**
 * Settings namespace carrying the deployment's guardrails configuration. Home
 * is here rather than the plugin entry so a reader resolves the same namespace
 * value without importing the service.
 */
export const GUARDRAILS_SETTINGS_NAMESPACE: SettingsNamespace = settingsNamespace('judgment-guardrails')

/** State character cap used when config omits `state.maxChars`. */
export const DEFAULT_STATE_MAX_CHARS = 8000

/** Argument excerpt cap used when config omits `state.maxArgChars`. */
export const DEFAULT_STATE_MAX_ARG_CHARS = 200

/** Judgment tier used when config omits `tier`: the observer's per-call cost is real, so it ships on the cheap one. */
export const DEFAULT_TIER: JudgmentTier = 'fast'

/** Keys one composition entry may set; every other key fails load by name. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'enabled',
  'injectionInstructions',
  'injectionCriteria',
  'severityInstructions',
  'severityLevels',
  'state',
  'tier',
])

/** Keys the `injectionCriteria` entry may set. */
const INJECTION_CRITERIA_KEYS: ReadonlySet<string> = new Set(['yes', 'no'])

/** Keys the `state` entry may set. */
const STATE_KEYS: ReadonlySet<string> = new Set(['maxChars', 'maxArgChars'])

/** The two sides of the injection question, as the engine reads them. */
export interface GuardInjectionCriteria {
  /** What a positive noul answer means for this deployment. */
  readonly yes: string
  /** What a negative noul answer means for this deployment. */
  readonly no: string
}

/** The caps one state is assembled under. */
export interface GuardStateCaps {
  /**
   * Hard cap on the state text in characters, defaulting to
   * {@link DEFAULT_STATE_MAX_CHARS}. The state never exceeds it; when content is
   * dropped the state ends with a note naming how many characters it lost.
   */
  readonly maxChars: number
  /**
   * Hard cap on the argument excerpt in characters, defaulting to
   * {@link DEFAULT_STATE_MAX_ARG_CHARS}. The excerpt is context for the
   * classifier; the call it was cut from stays in the log.
   */
  readonly maxArgChars: number
}

/**
 * Composition config of the guardrails observer; also the
 * `judgment-guardrails` settings section.
 *
 * The observer ships off. `enabled: false` makes no ask and writes no session
 * event, so a composed-but-off deployment's log is byte-identical to one without
 * this package.
 */
export interface GuardrailsConfig {
  /** Master allow. Default false. */
  enabled?: boolean
  /**
   * Text of the binary question asked about one tool call's input: whether it
   * attempts to override instructions or act against the user's interest.
   * Required: the judgment engine owns no prose.
   */
  injectionInstructions: string
  /**
   * What each side of the binary question means. Required: a bare yes/no
   * question leaves the engine to guess what "yes" is being asked.
   */
  injectionCriteria: GuardInjectionCriteria
  /**
   * Text of the score question asked about the same state: how severe the input
   * would be if it is hostile. Required, like every other question text.
   */
  severityInstructions: string
  /**
   * Ordered severity levels for the score question, lowest first. Required: the
   * level count fixes the score scale, so a package default would mislabel every
   * deployment that reads severity at another resolution.
   */
  severityLevels: string[]
  /** Caps the judged state is assembled under; an omitted field takes its own default. */
  state?: GuardStateCaps
  /** Judgment tier each check runs at. Default `fast`. */
  tier?: JudgmentTier
}

/** Resolved and validated guardrails configuration. */
export interface ResolvedGuardrailsConfig {
  /** Whether the observer may ask and write anything at all. */
  readonly enabled: boolean
  /** Text of the injection question. */
  readonly injectionInstructions: string
  /** Resolved sides of the injection question. */
  readonly injectionCriteria: GuardInjectionCriteria
  /** Text of the severity question. */
  readonly severityInstructions: string
  /** Resolved severity levels, lowest first. */
  readonly severityLevels: readonly string[]
  /** Resolved state caps. */
  readonly state: GuardStateCaps
  /** Judgment tier each check runs at. */
  readonly tier: JudgmentTier
}

/**
 * Resolve, validate, and detach the observer configuration.
 *
 * Schemastery normalizes a composition entry before the plugin starts, but a
 * settings snapshot and programmatic construction both reach this resolver as
 * raw values, so every default, bound, and key is re-judged here and a rejected
 * config fails at the earliest resolvable point naming the offender.
 *
 * @param config - raw config from a composition entry, a settings snapshot, or a caller.
 * @returns the resolved facts, frozen.
 * @throws Error naming the offending key when the config carries an unknown key,
 *   a missing or blank question text, an unknown injection side, a non-boolean
 *   `enabled`, an empty severity level or level list, a non-positive state cap,
 *   or a tier the seam does not carry.
 */
export function resolveConfig(config: GuardrailsConfig): ResolvedGuardrailsConfig {
  validateKeys(config, CONFIG_KEYS, 'GuardrailsConfig')
  const raw = config as {
    enabled?: unknown
    injectionCriteria?: unknown
    severityLevels?: unknown
    state?: unknown
    tier?: unknown
  }
  if (raw.enabled !== undefined) assertBoolean('GuardrailsConfig.enabled', raw.enabled)
  const injectionInstructions = config.injectionInstructions
  assertNonEmptyString('GuardrailsConfig.injectionInstructions', injectionInstructions)
  const severityInstructions = config.severityInstructions
  assertNonEmptyString('GuardrailsConfig.severityInstructions', severityInstructions)
  // The tier literals are the schema's to enforce for a composition entry, but a
  // settings snapshot and programmatic construction bypass it, so the raw value
  // is re-judged here the way every other field is.
  if (raw.tier !== undefined && raw.tier !== 'fast' && raw.tier !== 'accurate') {
    throw new Error('GuardrailsConfig.tier must be "fast" or "accurate"')
  }
  const injectionCriteria = resolveInjectionCriteria(raw.injectionCriteria)
  const severityLevels = resolveSeverityLevels(raw.severityLevels)
  const state = resolveState(raw.state)
  return Object.freeze({
    enabled: raw.enabled ?? false,
    injectionInstructions,
    injectionCriteria: Object.freeze(injectionCriteria),
    severityInstructions,
    severityLevels: Object.freeze(severityLevels),
    state: Object.freeze(state),
    tier: raw.tier ?? DEFAULT_TIER,
  })
}

/**
 * Resolve the two sides of the injection question.
 * @param criteria - the raw criteria entry, or undefined when omitted.
 * @returns the two sides, detached.
 * @throws Error naming the offending key when the entry carries an unknown key
 *   or a missing or blank side.
 */
function resolveInjectionCriteria(criteria: unknown): GuardInjectionCriteria {
  if (criteria === undefined) {
    throw new Error('GuardrailsConfig.injectionCriteria must be an object with "yes" and "no" texts')
  }
  if (typeof criteria !== 'object' || criteria === null || Array.isArray(criteria)) {
    throw new Error('GuardrailsConfig.injectionCriteria must be an object with "yes" and "no" texts')
  }
  const raw = criteria as Record<string, unknown>
  validateKeys(raw, INJECTION_CRITERIA_KEYS, 'GuardrailsConfig.injectionCriteria')
  assertNonEmptyString('GuardrailsConfig.injectionCriteria.yes', raw['yes'])
  assertNonEmptyString('GuardrailsConfig.injectionCriteria.no', raw['no'])
  return { yes: raw['yes'], no: raw['no'] }
}

/**
 * Resolve the ordered severity levels.
 * @param levels - the raw level list, or undefined when omitted.
 * @returns the levels, detached and lowest-first.
 * @throws Error naming the offending index when the list is missing, empty, or
 *   holds a blank level.
 */
function resolveSeverityLevels(levels: unknown): string[] {
  if (!Array.isArray(levels) || levels.length === 0) {
    throw new Error('GuardrailsConfig.severityLevels must be a non-empty list of level descriptions, lowest first')
  }
  return levels.map((level: unknown, index: number) => {
    assertNonEmptyString(`GuardrailsConfig.severityLevels[${String(index)}]`, level)
    return level
  })
}

/**
 * Resolve the caps one state is assembled under.
 * @param state - the raw state entry, or undefined when omitted.
 * @returns both caps, defaulted.
 * @throws Error naming the offending key when the entry carries an unknown key or
 *   a cap that is not a positive integer.
 */
function resolveState(state: unknown): GuardStateCaps {
  const raw = state === undefined ? {} : state
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('GuardrailsConfig.state must be an object with "maxChars" and "maxArgChars"')
  }
  const entry = raw as Record<string, unknown>
  validateKeys(entry, STATE_KEYS, 'GuardrailsConfig.state')
  const maxChars = entry['maxChars'] ?? DEFAULT_STATE_MAX_CHARS
  assertPositiveInteger('GuardrailsConfig.state.maxChars', maxChars)
  const maxArgChars = entry['maxArgChars'] ?? DEFAULT_STATE_MAX_ARG_CHARS
  assertPositiveInteger('GuardrailsConfig.state.maxArgChars', maxArgChars)
  return { maxChars, maxArgChars }
}

/** Reject stale or misspelled keys before defaults can hide them. */
function validateKeys(value: object, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}: unknown key "${key}"`)
  }
}

/** Require one field to be a string with content. */
function assertNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
}

/** Require one field to be a boolean. */
function assertBoolean(name: string, value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
}

/** Require one field to be a positive integer. */
function assertPositiveInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be an integer >= 1`)
  }
}
