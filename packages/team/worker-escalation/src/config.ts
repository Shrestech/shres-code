/**
 * Configuration schema, defaults, and the one explicit resolve step for the
 * worker difficulty ladder.
 *
 * Every deployment-varying choice is a validated field, and the ladder's five
 * triggers each carry their own enable bit and firing count: they measure
 * different things and a deployment tunes them separately. Unknown keys and
 * cross-field mistakes fail plugin load by name.
 *
 * @module @shres-code/shres-code-worker-escalation/config
 */

import { settingsNamespace } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import type { JudgmentTier } from '@shres-code/shres-code-judgment'
import type { EscalationTrigger } from './types.ts'

/**
 * Settings namespace carrying the deployment's ladder configuration. Home is
 * here rather than the plugin entry so the `./invariant` companion reads the
 * same namespace value without importing the service.
 */
export const WORKER_ESCALATION_SETTINGS_NAMESPACE: SettingsNamespace = settingsNamespace('worker-escalation')

/**
 * The trigger table's rows, in the order the fold reports them and the order
 * the service resolves a firing set in.
 */
export const ESCALATION_TRIGGERS: readonly EscalationTrigger[] = [
  'errorBurst',
  'attemptCount',
  'repeatRunLength',
  'stepBudgetExhausted',
  'turnFailureStreak',
]

/** Each trigger's firing count, defaulted. */
export const DEFAULT_TRIGGER_THRESHOLDS: Readonly<Record<EscalationTrigger, number>> = {
  errorBurst: 2,
  attemptCount: 3,
  repeatRunLength: 3,
  stepBudgetExhausted: 1,
  turnFailureStreak: 2,
}

/** Default continue resolutions per goal epoch before the terminal. */
export const DEFAULT_MAX_CONTINUES = 3

/** Default delegation-depth cap the ladder engages within. */
export const DEFAULT_MAX_ARBITER_DEPTH = 1

/** Default completed steps between two decisions on one session. */
export const DEFAULT_MIN_STEPS_BETWEEN = 2

/** Default `tool/call` signals the worker digest retains. */
export const DEFAULT_MAX_DIGEST_TOOLS = 12

/** Default character cap on the rendered worker digest. */
export const DEFAULT_MAX_DIGEST_CHARS = 4000

/** Default character cap on each bounded excerpt of the worker digest. */
export const DEFAULT_MAX_EXCERPT_CHARS = 200

/** Default character cap on each tool-argument excerpt. */
export const DEFAULT_MAX_ARG_CHARS = 80

/** Default confidence the Stage 1 ask's answer must reach to pass its gate. */
export const DEFAULT_JUDGMENT_CONFIDENCE = 0.8

/** Default top-two probability margin the ask's answer must reach to pass its gate. */
export const DEFAULT_JUDGMENT_MARGIN = 0.1

/**
 * Default tier the Stage 1 ask runs at. The cheap tier is an explicit
 * optimization, so a deployment that says nothing gets the accurate one.
 */
export const DEFAULT_JUDGMENT_TIER: JudgmentTier = 'accurate'

/** The `errorBurst` row: consecutive errored tool results. */
export interface EscalationErrorBurstConfig {
  /** Whether this trigger may fire. Default true. */
  enabled?: boolean
  /**
   * Consecutive errored tool results that count as a burst. Sandbox denials and
   * charter-discrimination probe runs are transparent — they neither count nor
   * reset the run. {@link DEFAULT_TRIGGER_THRESHOLDS.errorBurst} when omitted.
   */
  burst?: number
}

/** The `attemptCount` row: distinct failed approaches on one goal epoch. */
export interface EscalationAttemptCountConfig {
  /** Whether this trigger may fire. Default true. */
  enabled?: boolean
  /**
   * Distinct failed approaches since the goal epoch's anchor that count as
   * stuck. A passing checkpoint restarts the count, so verified progress
   * clears the failures before it. {@link DEFAULT_TRIGGER_THRESHOLDS.attemptCount}
   * when omitted.
   */
  attempts?: number
}

/** The `repeatRunLength` row: identical-call chains. */
export interface EscalationRepeatRunLengthConfig {
  /** Whether this trigger may fire. Default true. */
  enabled?: boolean
  /**
   * Identical-call chain length that counts as stuck, using the
   * repeat-tool-reminder guard's own chain identity and reset rules.
   * {@link DEFAULT_TRIGGER_THRESHOLDS.repeatRunLength} when omitted.
   */
  runLength?: number
}

/** The `stepBudgetExhausted` row: the per-turn step budget stopped a turn. */
export interface EscalationStepBudgetExhaustedConfig {
  /** Whether this trigger may fire. Default true. */
  enabled?: boolean
  /**
   * Step-budget stops on the current goal epoch that count as stuck.
   * {@link DEFAULT_TRIGGER_THRESHOLDS.stepBudgetExhausted} when omitted.
   */
  exhaustions?: number
}

/** The `turnFailureStreak` row: durable turn failures. */
export interface EscalationTurnFailureStreakConfig {
  /** Whether this trigger may fire. Default true. */
  enabled?: boolean
  /**
   * Consecutive durable turn failures that count as stuck.
   * {@link DEFAULT_TRIGGER_THRESHOLDS.turnFailureStreak} when omitted.
   */
  streak?: number
}

/** The per-trigger table: one row per trigger, each independently enabled and counted. */
export interface WorkerEscalationTriggerTable {
  /** Error-burst row. */
  errorBurst?: EscalationErrorBurstConfig
  /** Attempt-count row. */
  attemptCount?: EscalationAttemptCountConfig
  /** Repeat-run-length row. */
  repeatRunLength?: EscalationRepeatRunLengthConfig
  /** Step-budget row. */
  stepBudgetExhausted?: EscalationStepBudgetExhaustedConfig
  /** Turn-failure-streak row. */
  turnFailureStreak?: EscalationTurnFailureStreakConfig
}

/**
 * Composition config of the worker escalation ladder; also the
 * `worker-escalation` settings section.
 *
 * The ladder ships off. `enabled: false` writes no session event and sends no
 * mail, so a composed-but-off deployment's log is byte-identical to one
 * without this package.
 */
export interface WorkerEscalationConfig {
  /** Master allow. Default false. */
  enabled?: boolean
  /** Per-trigger rows; an omitted row takes its own defaults. */
  triggers?: WorkerEscalationTriggerTable
  /**
   * Continue resolutions one goal epoch may take before the ladder reports the
   * worker blocked instead. `0` reports at the first firing trigger, which
   * keeps the terminal reachable without any continue. Default 3.
   */
  maxContinues?: number
  /**
   * Delegation depth the ladder engages within. Root sessions (depth 0) are
   * never engaged; the cap must be at least 1. Default 1.
   */
  maxArbiterDepth?: number
  /**
   * Completed steps between two decisions on one session, so a standing
   * trigger cannot write a decision per event. Default 2.
   */
  minStepsBetween?: number
  /** `tool/call` signals the worker digest retains. Default 12. */
  maxDigestTools?: number
  /** Character cap on the rendered worker digest. Default 4000. */
  maxDigestChars?: number
  /**
   * Character cap on each bounded excerpt: an error excerpt, a tool-argument
   * excerpt, the assignment, and each later team message. Default 200.
   */
  maxExcerptChars?: number
  /** Character cap on each tool-argument excerpt inside the tool window. Default 80. */
  maxArgChars?: number
  /**
   * Instructions of the Stage 1 ask's two-option choice question. Required: the
   * judgment engine owns no prose, so the package that composes the ask owns
   * the text, and a deployment that omits it fails at load rather than asking
   * an unstated question.
   */
  progressInstructions: string
  /**
   * Confidence the ask's answer must reach for its gate to pass, from 0
   * through 1. An answer below it resolves `continue` with
   * `low-confidence`. Default 0.8, the routing operating point.
   */
  confidence?: number
  /**
   * Top-two probability margin (`top1 - top2`) the ask's answer must reach for
   * its gate to pass, from 0 through 1. An answer below it resolves
   * `continue` with `thin-margin`. Default 0.1, the routing operating point
   * and above the measured wobble of a rented classifier's borderline answers.
   */
  margin?: number
  /** Judgment tier the ask runs at: `fast` or `accurate`. Default `accurate`. */
  judgmentTier?: JudgmentTier
}

/** One resolved trigger row. */
export interface ResolvedEscalationTrigger {
  /** Whether this trigger may fire. */
  readonly enabled: boolean
  /** The trigger's own firing count, in the trigger's own unit. */
  readonly threshold: number
}

/** Every resolved trigger row, keyed by trigger. */
export type ResolvedEscalationTriggers = Readonly<Record<EscalationTrigger, ResolvedEscalationTrigger>>

/** Resolved and validated ladder configuration. */
export interface ResolvedWorkerEscalationConfig {
  /** Whether the ladder may write anything at all. */
  readonly enabled: boolean
  /** Resolved trigger table. */
  readonly triggers: ResolvedEscalationTriggers
  /** Continue resolutions per goal epoch before the terminal. */
  readonly maxContinues: number
  /** Delegation-depth cap the ladder engages within. */
  readonly maxArbiterDepth: number
  /** Completed steps required between two decisions on one session. */
  readonly minStepsBetween: number
  /** `tool/call` signals the worker digest retains. */
  readonly maxDigestTools: number
  /** Character cap on the rendered worker digest. */
  readonly maxDigestChars: number
  /** Character cap on each bounded excerpt. */
  readonly maxExcerptChars: number
  /** Character cap on each tool-argument excerpt. */
  readonly maxArgChars: number
  /** Instructions of the Stage 1 ask's two-option choice question. */
  readonly progressInstructions: string
  /** Confidence floor the ask's answer must reach to pass its gate. */
  readonly confidence: number
  /** Top-two probability margin floor the ask's answer must reach to pass its gate. */
  readonly margin: number
  /** Judgment tier the ask runs at. */
  readonly judgmentTier: JudgmentTier
}

/**
 * The threshold key each trigger row reads, so a row that misspells its own
 * count fails by name instead of silently taking the default.
 */
const TRIGGER_THRESHOLD_KEYS: Readonly<Record<EscalationTrigger, string>> = {
  errorBurst: 'burst',
  attemptCount: 'attempts',
  repeatRunLength: 'runLength',
  stepBudgetExhausted: 'exhaustions',
  turnFailureStreak: 'streak',
}

/** Keys one composition entry may set; every other key fails load by name. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'enabled',
  'triggers',
  'maxContinues',
  'maxArbiterDepth',
  'minStepsBetween',
  'maxDigestTools',
  'maxDigestChars',
  'maxExcerptChars',
  'maxArgChars',
  'progressInstructions',
  'confidence',
  'margin',
  'judgmentTier',
])

/** Reject a key this ladder could not act on, naming it. */
function validateKeys(config: object): void {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`WorkerEscalationConfig: unknown key "${key}"`)
  }
}

/** Require one field to be a non-negative integer. */
function assertCount(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
}

/** Require one field to be a positive integer. */
function assertPositive(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be an integer >= 1`)
  }
}

/** Require one field to be a boolean. */
function assertBoolean(name: string, value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
}

/** Require one field to be a non-empty string. */
function assertNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
}

/** Require one probability-shaped threshold inside [0, 1]. */
function assertRatio(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number from 0 through 1`)
  }
}

/**
 * Resolve one trigger row: its enable bit, its own count, and its key set.
 * @param trigger - the trigger the row belongs to.
 * @param row - the raw row, or undefined when the deployment omitted it.
 * @returns the resolved row.
 * @throws Error naming the offending key when the row carries an unknown key, a
 *   non-boolean `enabled`, or a non-positive count.
 */
function resolveTriggerRow(
  trigger: EscalationTrigger,
  row: Record<string, unknown> | undefined,
): ResolvedEscalationTrigger {
  const thresholdKey = TRIGGER_THRESHOLD_KEYS[trigger]
  const raw = row ?? {}
  for (const key of Object.keys(raw)) {
    if (key !== 'enabled' && key !== thresholdKey) {
      throw new Error(`WorkerEscalationConfig.triggers.${trigger}: unknown key "${key}"`)
    }
  }
  const rawEnabled = raw['enabled']
  if (rawEnabled !== undefined) assertBoolean(`WorkerEscalationConfig.triggers.${trigger}.enabled`, rawEnabled)
  const rawThreshold = raw[thresholdKey]
  if (rawThreshold !== undefined) {
    assertPositive(`WorkerEscalationConfig.triggers.${trigger}.${thresholdKey}`, rawThreshold)
  }
  return Object.freeze({
    enabled: rawEnabled ?? true,
    threshold: rawThreshold ?? DEFAULT_TRIGGER_THRESHOLDS[trigger],
  })
}

/**
 * Resolve, validate, and detach the ladder configuration.
 *
 * Schemastery normalizes a composition entry before the plugin starts, but
 * programmatic construction and a settings snapshot both reach this resolver
 * as raw values, so every default, bound, and key is re-judged here and a
 * rejected config fails at the earliest resolvable point naming the offender.
 * @param config - raw config from a composition entry, a settings snapshot, or a caller.
 * @returns the resolved facts, frozen.
 * @throws Error naming the offending key when the config carries an unknown
 *   key, a missing question text, a non-boolean `enabled`, a non-integer
 *   count, a threshold outside its range, a trigger table that enables nothing
 *   while the ladder is on, or a delegation-depth cap that engages no session.
 */
export function resolveConfig(config: WorkerEscalationConfig): ResolvedWorkerEscalationConfig {
  validateKeys(config)
  const raw = config as { enabled?: unknown; maxArbiterDepth?: unknown; triggers?: unknown; judgmentTier?: unknown }
  if (raw.enabled !== undefined) assertBoolean('WorkerEscalationConfig.enabled', raw.enabled)
  // The two tier literals are the schema's to enforce for a composition entry,
  // but programmatic construction and a settings snapshot bypass it, so the raw
  // value is re-judged here the way every other field is.
  if (raw.judgmentTier !== undefined && raw.judgmentTier !== 'fast' && raw.judgmentTier !== 'accurate') {
    throw new Error('WorkerEscalationConfig.judgmentTier must be "fast" or "accurate"')
  }
  const rows = (raw.triggers ?? {}) as Record<string, Record<string, unknown> | undefined>
  for (const key of Object.keys(rows)) {
    if (!ESCALATION_TRIGGERS.includes(key as EscalationTrigger)) {
      throw new Error(`WorkerEscalationConfig.triggers: unknown trigger "${key}"`)
    }
  }
  const resolvedRows = {} as Record<EscalationTrigger, ResolvedEscalationTrigger>
  for (const trigger of ESCALATION_TRIGGERS) {
    resolvedRows[trigger] = resolveTriggerRow(trigger, rows[trigger])
  }
  const enabled = raw.enabled ?? false
  if (enabled && ESCALATION_TRIGGERS.every(trigger => !resolvedRows[trigger].enabled)) {
    throw new Error(
      'WorkerEscalationConfig: enabled is true while every trigger row is disabled,'
      + ' so the ladder could never fire; enable a trigger or set enabled: false',
    )
  }
  const maxContinues = config.maxContinues ?? DEFAULT_MAX_CONTINUES
  assertCount('WorkerEscalationConfig.maxContinues', maxContinues)
  const maxArbiterDepth = config.maxArbiterDepth ?? DEFAULT_MAX_ARBITER_DEPTH
  if (!Number.isInteger(maxArbiterDepth) || maxArbiterDepth < 1) {
    throw new Error(
      'WorkerEscalationConfig.maxArbiterDepth must be an integer >= 1: root sessions (delegation'
      + ' depth 0) are never engaged, so a lower cap would engage no session at all',
    )
  }
  const minStepsBetween = config.minStepsBetween ?? DEFAULT_MIN_STEPS_BETWEEN
  assertCount('WorkerEscalationConfig.minStepsBetween', minStepsBetween)
  const maxDigestTools = config.maxDigestTools ?? DEFAULT_MAX_DIGEST_TOOLS
  assertPositive('WorkerEscalationConfig.maxDigestTools', maxDigestTools)
  const maxDigestChars = config.maxDigestChars ?? DEFAULT_MAX_DIGEST_CHARS
  assertPositive('WorkerEscalationConfig.maxDigestChars', maxDigestChars)
  const maxExcerptChars = config.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS
  assertPositive('WorkerEscalationConfig.maxExcerptChars', maxExcerptChars)
  const maxArgChars = config.maxArgChars ?? DEFAULT_MAX_ARG_CHARS
  assertPositive('WorkerEscalationConfig.maxArgChars', maxArgChars)
  // The engine owns no prose, so the ask's question text is the consuming
  // package's to own and a deployment that omits it fails here rather than
  // asking an unstated question.
  assertNonEmptyString('WorkerEscalationConfig.progressInstructions', config.progressInstructions)
  const confidence = config.confidence ?? DEFAULT_JUDGMENT_CONFIDENCE
  assertRatio('WorkerEscalationConfig.confidence', confidence)
  const margin = config.margin ?? DEFAULT_JUDGMENT_MARGIN
  assertRatio('WorkerEscalationConfig.margin', margin)
  const judgmentTier = config.judgmentTier ?? DEFAULT_JUDGMENT_TIER
  return Object.freeze({
    enabled,
    triggers: Object.freeze(resolvedRows),
    maxContinues,
    maxArbiterDepth,
    minStepsBetween,
    maxDigestTools,
    maxDigestChars,
    maxExcerptChars,
    maxArgChars,
    progressInstructions: config.progressInstructions,
    confidence,
    margin,
    judgmentTier,
  })
}
