/**
 * Jev compaction configuration: the inherited compaction-basic policy plus the
 * semantic-selection, boundary-judgment, and verification fields this backend
 * adds. The class's schemastery `static Config` restates every field of both
 * layers, which is the whole-config shape a forced-compaction overlay needs.
 *
 * @module @shres-code/shres-code-compaction-jev/config
 */

import type { BasicCompactionConfig } from '@shres-code/shres-code-compaction-basic'

/** What a draft that fails its verification battery does. */
export type JevOnVerifyFailure = 'accept-logged' | 'fail-attempt'

/** One named binary check of the verification battery. */
export interface JevVerifyCheckConfig {
  /** Stable name recorded on the verification event. */
  name: string
  /**
   * The binary question text, phrased as the hazard (a high probability means
   * the draft breaks this rule). The consumer owns the text; the seam adds none.
   */
  instructions: string
}

/** Jev compaction configuration: the inherited policy plus the judgment fields. */
export interface JevCompactionConfig extends BasicCompactionConfig {
  /** Judgment tier the scoring and verification calls run at. Defaults to `accurate`. */
  tier?: 'fast' | 'accurate'
  /** The segment load-bearingness question text. Required. */
  segmentScoreInstructions: string
  /**
   * Ordered score levels for the segment question, lowest first. Defaults to a
   * five-level rubric. A score question needs ordered levels, which the seam
   * requires; the rubric is Config on the consumer, like the model-router's
   * difficulty levels.
   */
  segmentScoreLevels?: string[]
  /**
   * The per-sub-span-edge boundary question text. Required. Phrased as the
   * hazard: a high probability means this edge cuts through work that belongs
   * together, which is what `boundaryThreshold` marks unsafe.
   */
  boundaryInstructions: string
  /** The overall draft-quality score question text. Required. */
  verifyInstructions: string
  /** The named binary checks the battery runs beside the overall score. Required, at least one. */
  verifyChecks: JevVerifyCheckConfig[]
  /** Ordered score levels for the overall question, lowest first. Defaults to a five-level rubric. */
  verifyScoreLevels?: string[]
  /** Segment questions per judgment ask. Defaults to 4; a larger span is chunked. */
  maxSegmentsPerCall?: number
  /** Per-segment character cap for scoring, head and tail kept. Defaults to 2000. */
  segmentMaxChars?: number
  /** Character cap for the draft plus original region a verification reads. Defaults to 6000. */
  verifyMaxChars?: number
  /** Load-bearingness score at or above which a segment is rescued. Defaults to 3. */
  rescueScore?: number
  /** Confidence at or above which a score is trusted. Defaults to 0.6. */
  segmentConfidence?: number
  /** Maximum rescued segments per compaction; `0` disables rescue. Defaults to 2. */
  maxRescues?: number
  /** Boundary hazard probability at or above which an edge is unsafe. Defaults to 0.4. */
  boundaryThreshold?: number
  /** Wobble band below the boundary threshold that also counts as unsafe. Defaults to 0.15. */
  boundaryMargin?: number
  /** Maximum surface nodes one edge may move. Defaults to 2. */
  maxBoundaryAdjustment?: number
  /** Verify-check probability at or above which a check passes. Defaults to 0.7. */
  verifyThreshold?: number
  /** Wobble band below the verify threshold treated as not verified. Defaults to 0.1. */
  verifyMargin?: number
  /** Overall score at or above which a draft passes. Defaults to 4. */
  verifyScore?: number
  /** Provider route for the escalation draft; pair with `escalationModel`, or omit both for the conversation target. */
  escalationProvider?: string
  /** Model for the escalation draft; pair with `escalationProvider`. */
  escalationModel?: string
  /** Escalation drafts after a failed verification. Defaults to 1. */
  maxEscalations?: number
  /** What a draft that failed every escalation attempt does. Defaults to `accept-logged`. */
  onVerifyFailure?: JevOnVerifyFailure
}

/** Validated judgment facts of this backend. */
export interface ResolvedJevFacts {
  /** Judgment tier for scoring and verification. */
  readonly tier: 'fast' | 'accurate'
  /** Segment question text. */
  readonly segmentScoreInstructions: string
  /** Segment score levels, lowest first. */
  readonly segmentScoreLevels: readonly string[]
  /** Boundary question text. */
  readonly boundaryInstructions: string
  /** Overall question text. */
  readonly verifyInstructions: string
  /** Battery checks in configuration order. */
  readonly verifyChecks: readonly Readonly<JevVerifyCheckConfig>[]
  /** Overall score levels, lowest first. */
  readonly verifyScoreLevels: readonly string[]
  /** Segment questions per ask. */
  readonly maxSegmentsPerCall: number
  /** Per-segment character cap. */
  readonly segmentMaxChars: number
  /** Verification character cap. */
  readonly verifyMaxChars: number
  /** Rescue score floor. */
  readonly rescueScore: number
  /** Confidence floor for a trusted score. */
  readonly segmentConfidence: number
  /** Rescue budget; `0` disables rescue. */
  readonly maxRescues: number
  /** Boundary threshold. */
  readonly boundaryThreshold: number
  /** Boundary wobble band. */
  readonly boundaryMargin: number
  /** Maximum nodes one edge may move. */
  readonly maxBoundaryAdjustment: number
  /** Verify threshold. */
  readonly verifyThreshold: number
  /** Verify wobble band. */
  readonly verifyMargin: number
  /** Overall score floor. */
  readonly verifyScore: number
  /** Escalation target, when the deployment names one. */
  readonly escalation?: { readonly provider: string; readonly model: string }
  /** Escalation budget. */
  readonly maxEscalations: number
  /** Failed-verification policy. */
  readonly onVerifyFailure: JevOnVerifyFailure
}

/**
 * One resolution of the judgment layer. The inherited policy is resolved by
 * compaction-basic's own constructor (the base class owns that failure), so this
 * resolver judges only what this backend adds.
 */
export interface ResolvedJevConfig {
  /** Resolved judgment facts. */
  readonly jev: ResolvedJevFacts
}

/** Keys this backend adds on top of {@link BasicCompactionConfig}. */
export const JEV_CONFIG_KEYS: ReadonlySet<string> = new Set([
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

/**
 * The inherited-policy view of one Jev config: every key this backend adds is
 * removed, because compaction-basic's resolver rejects unknown keys by name and
 * its constructor receives exactly this object.
 *
 * The strip has to happen before the base class resolves, so it is a pure
 * function of the key set rather than something the subclass could do after
 * `super()`: a subclass constructor cannot compute a value before its super
 * call.
 * @param config - the full Jev configuration.
 * @returns the configuration with only {@link BasicCompactionConfig} keys.
 */
export function inheritedBasicConfig(config: JevCompactionConfig): BasicCompactionConfig {
  return Object.fromEntries(
    Object.entries(config).filter(([key]) => !JEV_CONFIG_KEYS.has(key)),
  )
}

/** Default ordered levels for the segment load-bearingness question. */
export const DEFAULT_SEGMENT_SCORE_LEVELS: readonly string[] = Object.freeze([
  'expendable: nothing later depends on it',
  'low: context a later turn is unlikely to need',
  'medium: context a later turn may need',
  'high: context a later turn is likely to need',
  'load-bearing: a decision, constraint, or result later work depends on',
])

/** Default ordered levels for the overall draft-quality question. */
export const DEFAULT_VERIFY_SCORE_LEVELS: readonly string[] = Object.freeze([
  'unusable: the draft loses decisions or invents facts',
  'weak: the draft keeps outcomes but drops the constraints behind them',
  'adequate: the draft keeps what later turns need',
  'good: the draft keeps decisions, constraints, and open work',
  'excellent: the draft keeps everything a later turn would need, concisely',
])

/** Default segment questions per ask. */
export const DEFAULT_MAX_SEGMENTS_PER_CALL = 4
/** Default per-segment scoring cap. */
export const DEFAULT_SEGMENT_MAX_CHARS = 2_000
/** Default verification cap. */
export const DEFAULT_VERIFY_MAX_CHARS = 6_000
/** Default rescue score floor on the default five-level rubric. */
export const DEFAULT_RESCUE_SCORE = 3
/** Default confidence floor for a trusted score. */
export const DEFAULT_SEGMENT_CONFIDENCE = 0.6
/** Default rescue budget. */
export const DEFAULT_MAX_RESCUES = 2
/** Default boundary threshold. */
export const DEFAULT_BOUNDARY_THRESHOLD = 0.4
/** Default boundary wobble band. */
export const DEFAULT_BOUNDARY_MARGIN = 0.15
/** Default maximum nodes one edge may move. */
export const DEFAULT_MAX_BOUNDARY_ADJUSTMENT = 2
/** Default verify threshold. */
export const DEFAULT_VERIFY_THRESHOLD = 0.7
/** Default verify wobble band. */
export const DEFAULT_VERIFY_MARGIN = 0.1
/** Default overall score floor on the default five-level rubric. */
export const DEFAULT_VERIFY_SCORE = 4
/** Default escalation budget. */
export const DEFAULT_MAX_ESCALATIONS = 1
/** Default failed-verification policy. */
export const DEFAULT_ON_VERIFY_FAILURE: JevOnVerifyFailure = 'accept-logged'

/** Require one field to be a non-empty string. */
function assertNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
}

/** Require one positive integer. */
function assertPositiveInteger(name: string, value: unknown): void {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
}

/** Require one non-negative integer. */
function assertNonNegativeInteger(name: string, value: unknown): void {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
}

/** Require one value inside [0, 1]. */
function assertRatio(name: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number from 0 through 1`)
  }
}

/** Resolve, validate, and detach one ordered level list. */
function resolveLevels(name: string, configured: readonly string[] | undefined, fallback: readonly string[]): readonly string[] {
  const levels = configured ?? fallback
  if (levels.length < 2) throw new Error(`${name} needs at least two ordered level descriptions`)
  levels.forEach((level, index) => {
    assertNonEmptyString(`${name}[${index}]`, level)
  })
  return Object.freeze([...levels])
}

/** Resolve one score floor against the scale its levels define. */
function resolveScoreFloor(name: string, configured: number | undefined, fallback: number, levelCount: number): number {
  const value = configured ?? fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > levelCount - 1) {
    throw new Error(`${name} must be a number from 0 through ${levelCount - 1}`)
  }
  return value
}

/**
 * Resolve and validate one Jev compaction configuration.
 *
 * The inherited policy is resolved by compaction-basic's own resolver, so both
 * layers fail loud with their own diagnostics and no rule is restated. The
 * judgment layer is re-judged here because a forced-compaction overlay and a
 * programmatic caller both bypass the schema.
 * @param config - raw config from a composition entry or a caller.
 * @returns the resolved inherited policy and judgment facts, frozen.
 * @throws Error naming the offending key or the cross-field conflict.
 */
export function resolveJevConfig(config: JevCompactionConfig): ResolvedJevConfig {
  assertNonEmptyString('JevCompactionConfig.segmentScoreInstructions', config.segmentScoreInstructions)
  assertNonEmptyString('JevCompactionConfig.boundaryInstructions', config.boundaryInstructions)
  assertNonEmptyString('JevCompactionConfig.verifyInstructions', config.verifyInstructions)
  // Read through an unknown-typed view: the discriminated literals are the
  // schema's to enforce for a composition entry, but a programmatic caller
  // bypasses it, so they are re-judged as raw values a type cannot vouch for.
  const raw = config as { tier?: unknown; onVerifyFailure?: unknown }
  if (raw.tier !== undefined && raw.tier !== 'fast' && raw.tier !== 'accurate') {
    throw new Error('JevCompactionConfig.tier must be "fast" or "accurate"')
  }
  const tier: 'fast' | 'accurate' = raw.tier === 'fast' ? 'fast' : 'accurate'
  const segmentScoreLevels = resolveLevels(
    'JevCompactionConfig.segmentScoreLevels',
    config.segmentScoreLevels,
    DEFAULT_SEGMENT_SCORE_LEVELS,
  )
  const verifyScoreLevels = resolveLevels(
    'JevCompactionConfig.verifyScoreLevels',
    config.verifyScoreLevels,
    DEFAULT_VERIFY_SCORE_LEVELS,
  )
  const checks = config.verifyChecks
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new Error('JevCompactionConfig.verifyChecks must list at least one named binary check')
  }
  const seenCheckNames = new Set<string>()
  const verifyChecks = checks.map((check) => {
    assertNonEmptyString('JevCompactionConfig.verifyChecks[].name', check.name)
    assertNonEmptyString(`JevCompactionConfig.verifyChecks["${check.name}"].instructions`, check.instructions)
    if (seenCheckNames.has(check.name)) {
      throw new Error(`JevCompactionConfig.verifyChecks lists "${check.name}" more than once`)
    }
    seenCheckNames.add(check.name)
    return Object.freeze({ name: check.name, instructions: check.instructions })
  })
  const maxSegmentsPerCall = config.maxSegmentsPerCall ?? DEFAULT_MAX_SEGMENTS_PER_CALL
  assertPositiveInteger('JevCompactionConfig.maxSegmentsPerCall', maxSegmentsPerCall)
  const segmentMaxChars = config.segmentMaxChars ?? DEFAULT_SEGMENT_MAX_CHARS
  assertPositiveInteger('JevCompactionConfig.segmentMaxChars', segmentMaxChars)
  const verifyMaxChars = config.verifyMaxChars ?? DEFAULT_VERIFY_MAX_CHARS
  assertPositiveInteger('JevCompactionConfig.verifyMaxChars', verifyMaxChars)
  const rescueScore = resolveScoreFloor(
    'JevCompactionConfig.rescueScore',
    config.rescueScore,
    DEFAULT_RESCUE_SCORE,
    segmentScoreLevels.length,
  )
  const segmentConfidence = config.segmentConfidence ?? DEFAULT_SEGMENT_CONFIDENCE
  assertRatio('JevCompactionConfig.segmentConfidence', segmentConfidence)
  const maxRescues = config.maxRescues ?? DEFAULT_MAX_RESCUES
  assertNonNegativeInteger('JevCompactionConfig.maxRescues', maxRescues)
  const boundaryThreshold = config.boundaryThreshold ?? DEFAULT_BOUNDARY_THRESHOLD
  assertRatio('JevCompactionConfig.boundaryThreshold', boundaryThreshold)
  const boundaryMargin = config.boundaryMargin ?? DEFAULT_BOUNDARY_MARGIN
  assertRatio('JevCompactionConfig.boundaryMargin', boundaryMargin)
  if (boundaryMargin > boundaryThreshold) {
    throw new Error('JevCompactionConfig.boundaryMargin must not exceed boundaryThreshold')
  }
  const maxBoundaryAdjustment = config.maxBoundaryAdjustment ?? DEFAULT_MAX_BOUNDARY_ADJUSTMENT
  assertNonNegativeInteger('JevCompactionConfig.maxBoundaryAdjustment', maxBoundaryAdjustment)
  const verifyThreshold = config.verifyThreshold ?? DEFAULT_VERIFY_THRESHOLD
  assertRatio('JevCompactionConfig.verifyThreshold', verifyThreshold)
  const verifyMargin = config.verifyMargin ?? DEFAULT_VERIFY_MARGIN
  assertRatio('JevCompactionConfig.verifyMargin', verifyMargin)
  if (verifyMargin > verifyThreshold) {
    throw new Error('JevCompactionConfig.verifyMargin must not exceed verifyThreshold')
  }
  const verifyScore = resolveScoreFloor(
    'JevCompactionConfig.verifyScore',
    config.verifyScore,
    DEFAULT_VERIFY_SCORE,
    verifyScoreLevels.length,
  )
  const escalationProvider = config.escalationProvider
  const escalationModel = config.escalationModel
  if ((escalationProvider === undefined) !== (escalationModel === undefined)) {
    throw new Error(
      'JevCompactionConfig.escalationProvider and escalationModel must be set together, or both omitted'
      + ' to escalate on the conversation target',
    )
  }
  if (escalationProvider !== undefined) {
    assertNonEmptyString('JevCompactionConfig.escalationProvider', escalationProvider)
    assertNonEmptyString('JevCompactionConfig.escalationModel', escalationModel)
  }
  const maxEscalations = config.maxEscalations ?? DEFAULT_MAX_ESCALATIONS
  assertNonNegativeInteger('JevCompactionConfig.maxEscalations', maxEscalations)
  if (raw.onVerifyFailure !== undefined && raw.onVerifyFailure !== 'accept-logged' && raw.onVerifyFailure !== 'fail-attempt') {
    throw new Error('JevCompactionConfig.onVerifyFailure must be "accept-logged" or "fail-attempt"')
  }
  const onVerifyFailure: JevOnVerifyFailure = raw.onVerifyFailure === 'fail-attempt' ? 'fail-attempt' : DEFAULT_ON_VERIFY_FAILURE
  return {
    jev: Object.freeze({
      tier,
      segmentScoreInstructions: config.segmentScoreInstructions,
      segmentScoreLevels,
      boundaryInstructions: config.boundaryInstructions,
      verifyInstructions: config.verifyInstructions,
      verifyChecks: Object.freeze(verifyChecks),
      verifyScoreLevels,
      maxSegmentsPerCall,
      segmentMaxChars,
      verifyMaxChars,
      rescueScore,
      segmentConfidence,
      maxRescues,
      boundaryThreshold,
      boundaryMargin,
      maxBoundaryAdjustment,
      verifyThreshold,
      verifyMargin,
      verifyScore,
      ...escalationProvider === undefined || escalationModel === undefined
        ? {}
        : { escalation: Object.freeze({ provider: escalationProvider, model: escalationModel }) },
      maxEscalations,
      onVerifyFailure,
    }),
  }
}
