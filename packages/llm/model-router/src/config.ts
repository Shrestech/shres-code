/**
 * Configuration schema and the one explicit resolve step for the model router.
 *
 * Every deployment-varying choice is a validated field: the allowlist is the
 * enforcement point that bounds what routing may select, the thresholds are
 * operating points measured rather than assumed, and every question string is
 * consumer-owned text because the judgment provider adds none of its own.
 *
 * @module @shres-code/shres-code-model-router/config
 */

import { ReasoningEffortId } from '@shres-code/shres-code-llm'
import type {
  ModelRoutingCandidate,
  ModelRoutingCandidateConfig,
  ModelRoutingObjective,
  ModelRoutingOperatingPoint,
  ModelRoutingOperatingPointConfig,
  ModelRoutingRouteFrom,
  ModelRoutingRouteFromConfig,
} from './types.ts'

/** Whether routing starts in force. */
export type ModelRoutingInitialMode = 'off' | 'on'

/** What a failed judgment call means for the turn. */
export type ModelRoutingUnavailablePolicy = 'fallback' | 'error'

/** What a failed downgraded request means for its step. */
export type ModelRoutingInTurnFallback = 'manual' | 'off'

/** The state window one judgment call reads. */
export interface ModelRoutingStateConfig {
  /** Prior user messages of the conversation to include before the current turn's. Defaults to 2. */
  contextTurns?: number
  /** Hard cap on the assembled state text, in characters. Defaults to 12000. */
  maxChars?: number
  /** Maximum complete context alternatives offered to a tokenizer-aware provider. Defaults to 8. */
  maxFitCandidates?: number
}

/** The escalation operating point. */
export interface ModelRoutingEscalateBackConfig {
  /** Difficulty at or above which the manual model handles the turn. Defaults to level 3 in the five-level rubric. */
  scoreThreshold?: number
}

/**
 * The streak horizon, counted in model steps: every `step/start` the loop logs
 * while a downgrade is held advances it, including later steps of the turn that
 * entered the streak.
 */
export interface ModelRoutingHoldConfig {
  /**
   * Steps a downgrade is held through a failed gate or a different candidate
   * before either may end it. `0` disables stickiness, so every step is judged
   * on its own. Defaults to 20.
   */
  minSteps?: number
  /**
   * Steps after which the next consult ends a held downgrade with `hold-cap`,
   * whatever the judgment would answer. Defaults to 40.
   */
  maxSteps?: number
}

/** The entry side of the difficulty band. */
export interface ModelRoutingDifficultyConfig {
  /**
   * Difficulty at or above which a streak is not entered. A held streak ends
   * only at `escalateBack.scoreThreshold`, so scores between the two hold but
   * do not enter. Must not exceed `escalateBack.scoreThreshold`. Defaults to
   * level 2 of the five-level rubric.
   */
  entryScoreCeiling?: number
}

/** How failed judgment calls affect a held streak and later consults. */
export interface ModelRoutingJudgmentFailuresConfig {
  /**
   * Consecutive failed judgment calls a held streak survives, keeping its
   * candidate with `judgment-failure-held`; the next failure ends it. `0`
   * ends a held streak at the first failure. Defaults to 2.
   */
  holdTolerance?: number
  /**
   * Consecutive failed judgment calls that open the breaker. Only an answered
   * call resets the count, so after the breaker closes one more failure opens
   * it again. Defaults to 3.
   */
  breakerThreshold?: number
  /**
   * Turns after the turn of the latest failure during which an open breaker
   * keeps the manual route with `breaker-open` and no judgment call. `0`
   * disables the breaker. Defaults to 5.
   */
  breakerOpenTurns?: number
}

/** The advisory-hint operating point. */
export interface ModelRoutingHardHintConfig {
  /** Difficulty at or above which a manual-model turn carries `consider-stronger`. Defaults to level 3 in the five-level rubric. */
  scoreThreshold?: number
}

/** The optional difficulty-to-effort lift. */
export interface ModelRoutingDifficultyToEffortConfig {
  /**
   * Difficulty score, on the step that enters a streak, at or above which the
   * entered route runs at {@link reasoningEffort}. Must be below
   * `difficulty.entryScoreCeiling`, because no streak is entered at or above it.
   */
  scoreThreshold: number
  /** Effort a route entering a streak runs at above the threshold; the streak keeps it. */
  reasoningEffort: string
}

/** Composition config of the model router; also the `model-router` settings section. */
export interface ModelRouterConfig {
  /** Deployment mode for sessions without an explicit user choice. Changes commit between requests. */
  initialMode: ModelRoutingInitialMode
  /**
   * The one shared pool of downgrade candidates, whose relative capability and
   * cost the deployment owns. An empty pool leaves every turn on the manual
   * route with `no-candidates`.
   */
  candidates?: ModelRoutingCandidateConfig[]
  /**
   * Strong routes routing may start from, each with its billing objective. A
   * manual route not listed here keeps its model with `base-unlisted` and no
   * judgment call. Must be non-empty unless `initialMode` is `off`.
   */
  routeFrom?: ModelRoutingRouteFromConfig[]
  /**
   * Route confidence at or above which a candidate may be selected. Required.
   * The global default for any engine without an operating point.
   */
  downgradeThreshold: number
  /**
   * Required top-two probability margin (`top1 - top2`) for a selection.
   * Required. The global default for any engine without an operating point.
   */
  downgradeMargin: number
  /**
   * Gate thresholds per judgment engine, which replace the global defaults
   * for the engine each names. At most one per engine. A `verbalized` engine
   * gates only through a point that sets `acceptVerbalized`.
   */
  operatingPoints?: ModelRoutingOperatingPointConfig[]
  /** Streak horizon and cap, in model steps. */
  hold?: ModelRoutingHoldConfig
  /** Entry side of the difficulty band. */
  difficulty?: ModelRoutingDifficultyConfig
  /**
   * Turns after the one whose `escalated`, `current-preferred`, or
   * `route-failed` decision ended a streak that keep the manual route without
   * judgment, logged as `reentry-cooldown`. The ending turn itself stays on the
   * manual route either way. `0` disables the cooldown. Defaults to 2.
   */
  reentryCooldownTurns?: number
  /** The choice question text asked about the conversation state. Required. */
  routeInstructions: string
  /**
   * The difficulty question text. Required by stickiness (`hold.minSteps > 0`),
   * `hardHint`, and `difficultyToEffort`. When configured, every consult asks
   * it and checks the difficulty limit before allowing a downgrade.
   */
  difficultyInstructions?: string
  /** Ordered score descriptions, lowest first; scores use zero-based indices. Defaults to a five-level rubric. */
  difficultyLevels?: string[]
  /** Escalate-back operating point. */
  escalateBack?: ModelRoutingEscalateBackConfig
  /**
   * Consecutive candidate failures that require a manual-model turn: terminal
   * failures of a held route, or `route-failed` decisions for one candidate
   * across streaks. Recorded on each held decision; settings changes affect
   * subsequent decisions. Defaults to 2.
   */
  maxRouteErrors?: number
  /** What a failed judgment call does to the turn. Defaults to `fallback`. */
  onUnavailable?: ModelRoutingUnavailablePolicy
  /**
   * Milliseconds one judgment call may take before the router records it as
   * `engine-unavailable` with `engineFailure.code` `DEADLINE`; a turn
   * cancellation still cancels the turn. At most 30000. Defaults to 1500.
   */
  judgmentDeadlineMs?: number
  /** How failed judgment calls affect a held streak and later consults. */
  judgmentFailures?: ModelRoutingJudgmentFailuresConfig
  /**
   * What a failed downgraded request does to its step. `manual` records a
   * `route-failed` decision and retries the step on the manual route after
   * every other recovery listener declined; `off` leaves the failure terminal.
   * Defaults to `manual`.
   */
  inTurnFallback?: ModelRoutingInTurnFallback
  /**
   * Optional effort lift for a route entering a streak on a hard step; the
   * streak keeps its entry effort. Omitted — or written as a valueless key,
   * which the schema resolves to null — means not configured; the group is
   * never implied by a default.
   */
  difficultyToEffort?: ModelRoutingDifficultyToEffortConfig
  /**
   * Optional advisory hint while the manual route stands. Omitted — or a
   * valueless key — means not configured, so a deployment without it is not
   * asked for the difficulty question.
   */
  hardHint?: ModelRoutingHardHintConfig
  /** The state window each judgment call reads. */
  state?: ModelRoutingStateConfig
  /** Judgment tier each call runs at. Defaults to `fast`. */
  tier?: 'fast' | 'accurate'
}

/** Resolved state window. */
export interface ResolvedModelRoutingState {
  /** Prior user messages included before the current turn's. */
  readonly contextTurns: number
  /** Hard cap on the assembled state text. */
  readonly maxChars: number
  /** Maximum alternatives, including the full selected context and the current entry alone. */
  readonly maxFitCandidates: number
}

/** Resolved and validated router configuration. */
export interface ResolvedModelRouterConfig {
  /** Deployment mode applied until the session records an explicit user choice. */
  readonly initialMode: ModelRoutingInitialMode
  /** Detached candidate pool in configuration order. */
  readonly candidates: readonly Readonly<ModelRoutingCandidate>[]
  /** Detached `routeFrom` allowlist in configuration order. */
  readonly routeFrom: readonly ModelRoutingRouteFrom[]
  /** Route-confidence floor. */
  readonly downgradeThreshold: number
  /** Top-two margin floor. */
  readonly downgradeMargin: number
  /** Detached operating points in configuration order. */
  readonly operatingPoints: readonly ModelRoutingOperatingPoint[]
  /** Streak horizon and cap, in model steps. */
  readonly hold: { readonly minSteps: number; readonly maxSteps: number }
  /** Difficulty at or above which a streak is not entered. */
  readonly entryScoreCeiling: number
  /** Turns after a quality exit that keep the manual route without judgment. */
  readonly reentryCooldownTurns: number
  /** Choice question text. */
  readonly routeInstructions: string
  /** Difficulty question text; absent when no configured feature reads difficulty. */
  readonly difficultyInstructions?: string
  /** Difficulty score levels, lowest first. */
  readonly difficultyLevels: readonly string[]
  /** Escalate-back score threshold. */
  readonly escalateBackScoreThreshold: number
  /** Durable route-failure streak that escalates back. */
  readonly maxRouteErrors: number
  /** Policy for a failed judgment call. */
  readonly onUnavailable: ModelRoutingUnavailablePolicy
  /** Deadline of one judgment call, in milliseconds. */
  readonly judgmentDeadlineMs: number
  /** Hold tolerance and breaker for failed judgment calls. */
  readonly judgmentFailures: {
    readonly holdTolerance: number
    readonly breakerThreshold: number
    readonly breakerOpenTurns: number
  }
  /** Policy for a failed downgraded request. */
  readonly inTurnFallback: ModelRoutingInTurnFallback
  /** Effort lift for a hard turn, when configured. */
  readonly difficultyToEffort?: { readonly scoreThreshold: number; readonly reasoningEffort: string }
  /** Advisory-hint threshold, when configured. */
  readonly hardHintScoreThreshold?: number
  /** State window. */
  readonly state: ResolvedModelRoutingState
  /** Judgment tier. */
  readonly tier: 'fast' | 'accurate'
}

/** Default number of prior user messages included in the state. */
export const DEFAULT_STATE_CONTEXT_TURNS = 2

/** Default assembled-state cap, in characters. */
export const DEFAULT_STATE_MAX_CHARS = 12_000

/** Default number of complete input alternatives for exact token fitting. */
export const DEFAULT_STATE_MAX_FIT_CANDIDATES = 8

/**
 * Default streak horizon, in steps. At a 200k-token prefix with a five-minute
 * manual-route cache, a return after expiry breaks even after about 20 steps on
 * a DeepSeek-class candidate.
 */
export const DEFAULT_HOLD_MIN_STEPS = 20

/**
 * Default streak cap, in steps: about the number of steps at 7.8 s each that fit
 * a five-minute manual-route cache lifetime, and the bound on a hold inside the
 * turn that entered it.
 */
export const DEFAULT_HOLD_MAX_STEPS = 40

/** Default entry ceiling: the third level (index 2) of the five-level rubric. */
export const DEFAULT_ENTRY_SCORE_CEILING = 2

/** Default number of turns after a quality exit that keep the manual route without judgment. */
export const DEFAULT_REENTRY_COOLDOWN_TURNS = 2

/** Longest candidate description, in characters: every description is sent in every judgment question. */
export const MAX_CANDIDATE_DESCRIPTION_CHARS = 160

/** Largest judgment deadline a `latency` route accepts, in milliseconds. */
export const MAX_LATENCY_JUDGMENT_DEADLINE_MS = 200

/** Billing objectives a `routeFrom` entry may name. */
const OBJECTIVES: ReadonlySet<string> = new Set<ModelRoutingObjective>(['quota', 'dollars', 'latency'])

/** Default escalate-back difficulty threshold: the fourth level (index 3) of the five-level rubric. */
export const DEFAULT_ESCALATE_BACK_SCORE_THRESHOLD = 3

/** Default durable route-failure streak. */
export const DEFAULT_MAX_ROUTE_ERRORS = 2

/**
 * Default judgment deadline, in milliseconds: above the slowest judgment call a
 * live session recorded (924 ms) and far above a local Laya call (about 14 ms).
 */
export const DEFAULT_JUDGMENT_DEADLINE_MS = 1500

/** Largest accepted judgment deadline, in milliseconds. */
export const MAX_JUDGMENT_DEADLINE_MS = 30_000

/** Default number of consecutive failed judgment calls a held streak survives. */
export const DEFAULT_JUDGMENT_HOLD_TOLERANCE = 2

/** Default number of consecutive failed judgment calls that open the breaker. */
export const DEFAULT_JUDGMENT_BREAKER_THRESHOLD = 3

/** Default number of turns an open breaker keeps the manual route. */
export const DEFAULT_JUDGMENT_BREAKER_OPEN_TURNS = 5

/**
 * Default difficulty levels. Scores are zero-based indexes into this ordered
 * list, so the fourth level (`hard`) is score 3. A deployment replaces the
 * descriptions with its own rubric; the count fixes the valid score range.
 */
export const DEFAULT_DIFFICULTY_LEVELS: readonly string[] = Object.freeze([
  'routine: the turn is a small, well-scoped change',
  'moderate: the turn needs a few files or one new concept',
  'involved: the turn needs several files or a design decision',
  'hard: the turn needs cross-cutting reasoning or unfamiliar code',
  'very hard: the turn needs architecture work or unresolved ambiguity',
])

/** Keys one composition entry may set; every other key fails load by name. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'initialMode',
  'candidates',
  'routeFrom',
  'downgradeThreshold',
  'downgradeMargin',
  'operatingPoints',
  'hold',
  'difficulty',
  'reentryCooldownTurns',
  'routeInstructions',
  'difficultyInstructions',
  'difficultyLevels',
  'escalateBack',
  'maxRouteErrors',
  'onUnavailable',
  'judgmentDeadlineMs',
  'judgmentFailures',
  'inTurnFallback',
  'difficultyToEffort',
  'hardHint',
  'state',
  'tier',
])

/** Reject a key this router could not act on, naming it. */
function validateKeys(config: object): void {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`ModelRouterConfig: unknown key "${key}"`)
    }
  }
}

/** Require one field to be a non-empty string. */
function assertNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
}

/**
 * Resolve, validate, and detach the router configuration.
 *
 * Schemastery normalizes a composition entry before the plugin starts, but
 * programmatic construction bypasses it, so every default, bound, and key is
 * re-judged here and a rejected config fails plugin load naming the offender.
 * @param config - raw config from a composition entry, a settings snapshot, or a caller.
 * @returns the resolved facts, frozen.
 * @throws Error naming the offending key when the config carries an unknown
 *   key, a missing question text, an empty model id, a threshold outside its
 *   range, or stickiness without the difficulty question it needs.
 */
export function resolveConfig(config: ModelRouterConfig): ResolvedModelRouterConfig {
  validateKeys(config)
  // Read through an unknown-typed view: the discriminated literals are the
  // schema's to enforce for a composition entry, but programmatic construction
  // bypasses it, so they are re-judged here as raw values a type cannot vouch for.
  const raw = config as { initialMode?: unknown; onUnavailable?: unknown; inTurnFallback?: unknown; tier?: unknown }
  if (raw.initialMode !== 'off' && raw.initialMode !== 'on') {
    throw new Error('ModelRouterConfig.initialMode must be "off" or "on"')
  }
  if (raw.onUnavailable !== undefined && raw.onUnavailable !== 'fallback' && raw.onUnavailable !== 'error') {
    throw new Error('ModelRouterConfig.onUnavailable must be "fallback" or "error"')
  }
  if (raw.inTurnFallback !== undefined && raw.inTurnFallback !== 'manual' && raw.inTurnFallback !== 'off') {
    throw new Error('ModelRouterConfig.inTurnFallback must be "manual" or "off"')
  }
  if (raw.tier !== undefined && raw.tier !== 'fast' && raw.tier !== 'accurate') {
    throw new Error('ModelRouterConfig.tier must be "fast" or "accurate"')
  }
  assertNonEmptyString('ModelRouterConfig.routeInstructions', config.routeInstructions)
  assertRatio('ModelRouterConfig.downgradeThreshold', config.downgradeThreshold)
  assertRatio('ModelRouterConfig.downgradeMargin', config.downgradeMargin)
  const seen = new Set<string>()
  const candidates: ModelRoutingCandidate[] = (config.candidates ?? []).map((candidate) => {
    const id = candidate.id
    assertNonEmptyString('ModelRouterConfig.candidates[].id', id)
    if (id === KEEP_CURRENT_OPTION_ID) {
      throw new Error(`ModelRouterConfig.candidates["${id}"].id is reserved for the keep-current route option`)
    }
    assertNonEmptyString(`ModelRouterConfig.candidates["${id}"].provider`, candidate.provider)
    assertNonEmptyString(`ModelRouterConfig.candidates["${id}"].model`, candidate.model)
    if (seen.has(id)) throw new Error(`ModelRouterConfig.candidates lists "${id}" more than once`)
    seen.add(id)
    assertNonEmptyString(`ModelRouterConfig.candidates["${id}"].description`, candidate.description)
    if (candidate.description.length > MAX_CANDIDATE_DESCRIPTION_CHARS) {
      throw new Error(
        `ModelRouterConfig.candidates["${id}"].description must be at most ${MAX_CANDIDATE_DESCRIPTION_CHARS} characters`,
      )
    }
    return Object.freeze({
      id,
      provider: candidate.provider,
      model: candidate.model,
      ...candidate.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(candidate.reasoningEffort) },
      description: candidate.description,
    })
  })
  const minSteps = config.hold?.minSteps ?? DEFAULT_HOLD_MIN_STEPS
  if (!Number.isInteger(minSteps) || minSteps < 0) {
    throw new Error('ModelRouterConfig.hold.minSteps must be a non-negative integer')
  }
  const maxSteps = config.hold?.maxSteps ?? DEFAULT_HOLD_MAX_STEPS
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error('ModelRouterConfig.hold.maxSteps must be a positive integer')
  }
  if (minSteps > maxSteps) {
    throw new Error('ModelRouterConfig.hold.minSteps must not exceed hold.maxSteps')
  }
  const reentryCooldownTurns = config.reentryCooldownTurns ?? DEFAULT_REENTRY_COOLDOWN_TURNS
  if (!Number.isInteger(reentryCooldownTurns) || reentryCooldownTurns < 0) {
    throw new Error('ModelRouterConfig.reentryCooldownTurns must be a non-negative integer')
  }
  const difficultyInstructions = config.difficultyInstructions
  const needsDifficulty = minSteps > 0
    || (config.hardHint ?? undefined) !== undefined
    || (config.difficultyToEffort ?? undefined) !== undefined
  if (needsDifficulty && (difficultyInstructions === undefined || difficultyInstructions.trim() === '')) {
    throw new Error(
      'ModelRouterConfig.difficultyInstructions is required while hold.minSteps > 0 or hardHint or difficultyToEffort'
      + ' is set: these features require a difficulty answer',
    )
  }
  if (difficultyInstructions !== undefined) {
    assertNonEmptyString('ModelRouterConfig.difficultyInstructions', difficultyInstructions)
  }
  const difficultyLevels = config.difficultyLevels ?? [...DEFAULT_DIFFICULTY_LEVELS]
  if (difficultyLevels.length < 2) {
    throw new Error('ModelRouterConfig.difficultyLevels needs at least two ordered level descriptions')
  }
  difficultyLevels.forEach((level, index) => {
    assertNonEmptyString(`ModelRouterConfig.difficultyLevels[${index}]`, level)
  })
  const maxDifficultyScore = difficultyLevels.length - 1
  const scoreThreshold = config.escalateBack?.scoreThreshold ?? DEFAULT_ESCALATE_BACK_SCORE_THRESHOLD
  assertScoreThreshold('ModelRouterConfig.escalateBack.scoreThreshold', scoreThreshold, maxDifficultyScore)
  const entryScoreCeiling = config.difficulty?.entryScoreCeiling ?? DEFAULT_ENTRY_SCORE_CEILING
  assertScoreThreshold('ModelRouterConfig.difficulty.entryScoreCeiling', entryScoreCeiling, maxDifficultyScore)
  if (entryScoreCeiling > scoreThreshold) {
    throw new Error('ModelRouterConfig.difficulty.entryScoreCeiling must not exceed escalateBack.scoreThreshold')
  }
  const maxRouteErrors = config.maxRouteErrors ?? DEFAULT_MAX_ROUTE_ERRORS
  if (!Number.isInteger(maxRouteErrors) || maxRouteErrors < 1) {
    throw new Error('ModelRouterConfig.maxRouteErrors must be a positive integer')
  }
  const judgmentDeadlineMs = config.judgmentDeadlineMs ?? DEFAULT_JUDGMENT_DEADLINE_MS
  if (!Number.isInteger(judgmentDeadlineMs) || judgmentDeadlineMs < 1 || judgmentDeadlineMs > MAX_JUDGMENT_DEADLINE_MS) {
    throw new Error(`ModelRouterConfig.judgmentDeadlineMs must be a positive integer no greater than ${MAX_JUDGMENT_DEADLINE_MS}`)
  }
  const holdTolerance = config.judgmentFailures?.holdTolerance ?? DEFAULT_JUDGMENT_HOLD_TOLERANCE
  if (!Number.isInteger(holdTolerance) || holdTolerance < 0) {
    throw new Error('ModelRouterConfig.judgmentFailures.holdTolerance must be a non-negative integer')
  }
  const breakerThreshold = config.judgmentFailures?.breakerThreshold ?? DEFAULT_JUDGMENT_BREAKER_THRESHOLD
  if (!Number.isInteger(breakerThreshold) || breakerThreshold < 1) {
    throw new Error('ModelRouterConfig.judgmentFailures.breakerThreshold must be a positive integer')
  }
  const breakerOpenTurns = config.judgmentFailures?.breakerOpenTurns ?? DEFAULT_JUDGMENT_BREAKER_OPEN_TURNS
  if (!Number.isInteger(breakerOpenTurns) || breakerOpenTurns < 0) {
    throw new Error('ModelRouterConfig.judgmentFailures.breakerOpenTurns must be a non-negative integer')
  }
  const routeFrom = resolveRouteFrom(config.routeFrom ?? [], judgmentDeadlineMs)
  const operatingPoints = resolveOperatingPoints(config.operatingPoints ?? [])
  if (config.initialMode !== 'off' && routeFrom.length === 0) {
    throw new Error('ModelRouterConfig.routeFrom is empty: routing can never run')
  }
  const onUnavailable = config.onUnavailable ?? 'fallback'
  const inTurnFallback = config.inTurnFallback ?? 'manual'
  const tier = config.tier ?? 'fast'
  const contextTurns = config.state?.contextTurns ?? DEFAULT_STATE_CONTEXT_TURNS
  if (!Number.isInteger(contextTurns) || contextTurns < 0) {
    throw new Error('ModelRouterConfig.state.contextTurns must be a non-negative integer')
  }
  const maxChars = config.state?.maxChars ?? DEFAULT_STATE_MAX_CHARS
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error('ModelRouterConfig.state.maxChars must be a positive integer')
  }
  const maxFitCandidates = config.state?.maxFitCandidates ?? DEFAULT_STATE_MAX_FIT_CANDIDATES
  if (!Number.isInteger(maxFitCandidates) || maxFitCandidates < 2) {
    throw new Error('ModelRouterConfig.state.maxFitCandidates must be an integer of at least two')
  }
  // The schema resolves an omitted optional group to absent and a valueless key
  // to null; both mean "not configured" here.
  const hardHintScoreThreshold = (config.hardHint ?? undefined)?.scoreThreshold
  if (hardHintScoreThreshold !== undefined) {
    assertScoreThreshold('ModelRouterConfig.hardHint.scoreThreshold', hardHintScoreThreshold, maxDifficultyScore)
  }
  const difficultyToEffort = config.difficultyToEffort ?? undefined
  if (difficultyToEffort !== undefined) {
    assertScoreThreshold(
      'ModelRouterConfig.difficultyToEffort.scoreThreshold',
      difficultyToEffort.scoreThreshold,
      maxDifficultyScore,
    )
    assertNonEmptyString(
      'ModelRouterConfig.difficultyToEffort.reasoningEffort',
      difficultyToEffort.reasoningEffort,
    )
    // The lift applies on the entering step, and entry needs a score below the
    // ceiling, so a threshold at or above it could never lift anything.
    if (difficultyToEffort.scoreThreshold >= entryScoreCeiling) {
      throw new Error(
        'ModelRouterConfig.difficultyToEffort.scoreThreshold must be below difficulty.entryScoreCeiling: '
        + 'a streak is only entered below the ceiling, so the lift could never apply',
      )
    }
  }
  return Object.freeze({
    initialMode: config.initialMode,
    candidates: Object.freeze(candidates),
    routeFrom,
    downgradeThreshold: config.downgradeThreshold,
    downgradeMargin: config.downgradeMargin,
    operatingPoints,
    hold: Object.freeze({ minSteps, maxSteps }),
    entryScoreCeiling,
    reentryCooldownTurns,
    routeInstructions: config.routeInstructions,
    ...difficultyInstructions === undefined ? {} : { difficultyInstructions },
    difficultyLevels: Object.freeze([...difficultyLevels]),
    escalateBackScoreThreshold: scoreThreshold,
    maxRouteErrors,
    onUnavailable,
    judgmentDeadlineMs,
    judgmentFailures: Object.freeze({ holdTolerance, breakerThreshold, breakerOpenTurns }),
    inTurnFallback,
    ...difficultyToEffort === undefined
      ? {}
      : {
        difficultyToEffort: Object.freeze({
          scoreThreshold: difficultyToEffort.scoreThreshold,
          reasoningEffort: difficultyToEffort.reasoningEffort,
        }),
      },
    ...hardHintScoreThreshold === undefined ? {} : { hardHintScoreThreshold },
    state: Object.freeze({ contextTurns, maxChars, maxFitCandidates }),
    tier,
  })
}

/**
 * Resolve the `routeFrom` allowlist: each entry names a strong route and its
 * billing objective once.
 * @param entries - the configured entries.
 * @param judgmentDeadlineMs - the resolved judgment deadline, which a `latency` route bounds.
 * @returns the frozen entries in configuration order.
 * @throws Error naming the entry when a route is empty or listed twice, the
 *   objective is unknown, a `latency` route has a deadline above 200 ms, or a
 *   `quota` route lacks `allowEveryTurn` under the per-turn entry policy.
 */
function resolveRouteFrom(
  entries: readonly ModelRoutingRouteFromConfig[],
  judgmentDeadlineMs: number,
): readonly ModelRoutingRouteFrom[] {
  const seen = new Set<string>()
  return Object.freeze(entries.map((entry, index) => {
    assertNonEmptyString(`ModelRouterConfig.routeFrom[${index}].provider`, entry.provider)
    assertNonEmptyString(`ModelRouterConfig.routeFrom[${index}].model`, entry.model)
    const name = `ModelRouterConfig.routeFrom["${entry.provider}/${entry.model}"]`
    const key = JSON.stringify([entry.provider, entry.model])
    if (seen.has(key)) throw new Error(`ModelRouterConfig.routeFrom lists "${entry.provider}/${entry.model}" more than once`)
    seen.add(key)
    // Read through an unknown-typed view: programmatic construction bypasses the schema.
    const raw = entry as { objective?: unknown; allowEveryTurn?: unknown }
    if (typeof raw.objective !== 'string' || !OBJECTIVES.has(raw.objective)) {
      throw new Error(`${name}.objective must be "quota", "dollars", or "latency"`)
    }
    if (raw.allowEveryTurn !== undefined && typeof raw.allowEveryTurn !== 'boolean') {
      throw new Error(`${name}.allowEveryTurn must be a boolean`)
    }
    const allowEveryTurn = entry.allowEveryTurn ?? false
    if (entry.objective === 'latency' && judgmentDeadlineMs > MAX_LATENCY_JUDGMENT_DEADLINE_MS) {
      throw new Error(
        `${name}.objective "latency" requires judgmentDeadlineMs of at most ${MAX_LATENCY_JUDGMENT_DEADLINE_MS}`,
      )
    }
    // Per-turn entry is the only entry policy, so a quota route opts into it.
    if (entry.objective === 'quota' && !allowEveryTurn) {
      throw new Error(`${name}.objective "quota" requires allowEveryTurn: true under the per-turn entry policy`)
    }
    return Object.freeze({ provider: entry.provider, model: entry.model, objective: entry.objective, allowEveryTurn })
  }))
}

/**
 * Resolve the per-engine operating points.
 * @param entries - the configured points.
 * @returns the frozen points in configuration order.
 * @throws Error naming the point when its engine is empty or listed twice, a
 *   threshold is outside [0, 1], `calibratedBy` is empty, or
 *   `acceptVerbalized` is not a boolean.
 */
function resolveOperatingPoints(entries: readonly ModelRoutingOperatingPointConfig[]): readonly ModelRoutingOperatingPoint[] {
  const seen = new Set<string>()
  return Object.freeze(entries.map((entry, index) => {
    assertNonEmptyString(`ModelRouterConfig.operatingPoints[${index}].engine`, entry.engine)
    const name = `ModelRouterConfig.operatingPoints["${entry.engine}"]`
    if (seen.has(entry.engine)) throw new Error(`ModelRouterConfig.operatingPoints lists engine "${entry.engine}" more than once`)
    seen.add(entry.engine)
    assertRatio(`${name}.downgradeThreshold`, entry.downgradeThreshold)
    assertRatio(`${name}.downgradeMargin`, entry.downgradeMargin)
    // Read through an unknown-typed view: programmatic construction bypasses the schema.
    const raw = entry as { calibratedBy?: unknown; acceptVerbalized?: unknown }
    if (raw.calibratedBy !== undefined) assertNonEmptyString(`${name}.calibratedBy`, raw.calibratedBy)
    if (raw.acceptVerbalized !== undefined && typeof raw.acceptVerbalized !== 'boolean') {
      throw new Error(`${name}.acceptVerbalized must be a boolean`)
    }
    return Object.freeze({
      engine: entry.engine,
      downgradeThreshold: entry.downgradeThreshold,
      downgradeMargin: entry.downgradeMargin,
      ...entry.calibratedBy === undefined ? {} : { calibratedBy: entry.calibratedBy },
      acceptVerbalized: entry.acceptVerbalized ?? false,
    })
  }))
}

/** Require one probability-shaped threshold inside [0, 1]. */
function assertRatio(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number from 0 through 1`)
  }
}

/** Require one difficulty threshold inside the zero-based scale the levels define. */
function assertScoreThreshold(name: string, value: unknown, maxScore: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maxScore) {
    throw new Error(`${name} must be a number from 0 through ${maxScore}`)
  }
}

/** Protocol id reserved for the explicit route option that keeps the manual model. */
export const KEEP_CURRENT_OPTION_ID = 'keep-current'
