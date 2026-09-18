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
import type { ModelRoutingCandidate, ModelRoutingCandidateConfig } from './types.ts'

/** Whether routing starts in force. */
export type ModelRoutingInitialMode = 'off' | 'on'

/** What a failed judgment call means for the turn. */
export type ModelRoutingUnavailablePolicy = 'fallback' | 'error'

/** The state window one judgment call reads. */
export interface ModelRoutingStateConfig {
  /** Prior user messages of the conversation to include before the current turn's. Defaults to 2. */
  contextTurns?: number
  /** Hard cap on the assembled state text, in characters. Defaults to 12000. */
  maxChars?: number
}

/** The escalation operating point. */
export interface ModelRoutingEscalateBackConfig {
  /** Difficulty score at or above which a held downgrade escalates back immediately. Defaults to 4. */
  scoreThreshold?: number
}

/** The advisory-hint operating point. */
export interface ModelRoutingHardHintConfig {
  /** Difficulty score at or above which a STRONG turn carries the `consider-stronger` hint. Defaults to 4. */
  scoreThreshold?: number
}

/** The optional difficulty-to-effort lift. */
export interface ModelRoutingDifficultyToEffortConfig {
  /** Difficulty score at or above which the selected route runs at {@link reasoningEffort}. */
  scoreThreshold: number
  /** Effort the selected downgraded route runs at above the threshold. */
  reasoningEffort: string
}

/** Composition config of the model router; also the `model-router` settings section. */
export interface ModelRouterConfig {
  /** Whether routing starts in force. Required: a stored mode is an explicit deployment choice. */
  initialMode: ModelRoutingInitialMode
  /**
   * Downgrade allowlist. Routing may select a member of this list or nothing —
   * never the manual route and never anything stronger — so an empty list
   * leaves every turn on the manual route with `no-candidates` logged.
   */
  candidates?: ModelRoutingCandidateConfig[]
  /** Route confidence at or above which a candidate may be selected. Required. */
  downgradeThreshold: number
  /** Required top-two probability margin (`top1 - top2`) for a selection. Required. */
  downgradeMargin: number
  /**
   * Turns a downgraded streak is held before a failed gate may end it. `0`
   * disables stickiness (each turn is judged on its own), which keeps the
   * non-sticky design reachable and falsifiable. Defaults to 5.
   */
  minTurnsDowngraded?: number
  /** The choice question text asked about the conversation state. Required. */
  routeInstructions: string
  /**
   * The difficulty question text. Required at load while
   * `minTurnsDowngraded > 0`: a held downgrade re-judges every turn and needs
   * the difficulty answer to escalate back immediately.
   */
  difficultyInstructions?: string
  /** Ordered difficulty-level descriptions for the score question, lowest first. Defaults to a five-level rubric. */
  difficultyLevels?: string[]
  /** Escalate-back operating point. */
  escalateBack?: ModelRoutingEscalateBackConfig
  /** Durable route-failure streak at which a held downgrade escalates back immediately. Defaults to 2. */
  maxRouteErrors?: number
  /** What a failed judgment call does to the turn. Defaults to `fallback`. */
  onUnavailable?: ModelRoutingUnavailablePolicy
  /**
   * Optional effort lift for a selected route on a hard turn. Omitted — or
   * written as a valueless key, which the schema resolves to null — means not
   * configured; the group is never implied by a default.
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
}

/** Resolved and validated router configuration. */
export interface ResolvedModelRouterConfig {
  /** Mode in force before any `model-routing/mode` event. */
  readonly initialMode: ModelRoutingInitialMode
  /** Detached allowlist in configuration order. */
  readonly candidates: readonly Readonly<ModelRoutingCandidate>[]
  /** Route-confidence floor. */
  readonly downgradeThreshold: number
  /** Top-two margin floor. */
  readonly downgradeMargin: number
  /** Streak horizon; `0` disables stickiness. */
  readonly minTurnsDowngraded: number
  /** Choice question text. */
  readonly routeInstructions: string
  /** Difficulty question text; absent when stickiness is disabled. */
  readonly difficultyInstructions?: string
  /** Difficulty score levels, lowest first. */
  readonly difficultyLevels: readonly string[]
  /** Escalate-back score threshold. */
  readonly escalateBackScoreThreshold: number
  /** Durable route-failure streak that escalates back. */
  readonly maxRouteErrors: number
  /** Policy for a failed judgment call. */
  readonly onUnavailable: ModelRoutingUnavailablePolicy
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

/** Default streak horizon. */
export const DEFAULT_MIN_TURNS_DOWNGRADED = 5

/** Default escalate-back difficulty threshold on a 1-5 scale. */
export const DEFAULT_ESCALATE_BACK_SCORE_THRESHOLD = 4

/** Default durable route-failure streak. */
export const DEFAULT_MAX_ROUTE_ERRORS = 2

/**
 * Default difficulty levels: the five-level rubric the measured operating
 * points assume (`escalateBack.scoreThreshold` is documented on a 1-5 scale).
 * A deployment replaces the descriptions with its own rubric; the count is
 * what fixes the scale.
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
  'downgradeThreshold',
  'downgradeMargin',
  'minTurnsDowngraded',
  'routeInstructions',
  'difficultyInstructions',
  'difficultyLevels',
  'escalateBack',
  'maxRouteErrors',
  'onUnavailable',
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
  const raw = config as { initialMode?: unknown; onUnavailable?: unknown; tier?: unknown }
  if (raw.initialMode !== 'off' && raw.initialMode !== 'on') {
    throw new Error('ModelRouterConfig.initialMode must be "off" or "on"')
  }
  if (raw.onUnavailable !== undefined && raw.onUnavailable !== 'fallback' && raw.onUnavailable !== 'error') {
    throw new Error('ModelRouterConfig.onUnavailable must be "fallback" or "error"')
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
    assertNonEmptyString(`ModelRouterConfig.candidates["${id}"].provider`, candidate.provider)
    assertNonEmptyString(`ModelRouterConfig.candidates["${id}"].model`, candidate.model)
    if (seen.has(id)) throw new Error(`ModelRouterConfig.candidates lists "${id}" more than once`)
    seen.add(id)
    if (candidate.description !== undefined) {
      assertNonEmptyString(`ModelRouterConfig.candidates["${id}"].description`, candidate.description)
    }
    return Object.freeze({
      id,
      provider: candidate.provider,
      model: candidate.model,
      ...candidate.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(candidate.reasoningEffort) },
      ...candidate.description === undefined ? {} : { description: candidate.description },
    })
  })
  const minTurnsDowngraded = config.minTurnsDowngraded ?? DEFAULT_MIN_TURNS_DOWNGRADED
  if (!Number.isInteger(minTurnsDowngraded) || minTurnsDowngraded < 0) {
    throw new Error('ModelRouterConfig.minTurnsDowngraded must be a non-negative integer')
  }
  const difficultyInstructions = config.difficultyInstructions
  const needsDifficulty = minTurnsDowngraded > 0 || (config.hardHint ?? undefined) !== undefined
  if (needsDifficulty && (difficultyInstructions === undefined || difficultyInstructions.trim() === '')) {
    throw new Error(
      'ModelRouterConfig.difficultyInstructions is required while minTurnsDowngraded > 0 or hardHint'
      + ' is set: a held downgrade re-judges every turn and the advisory hint reads the difficulty'
      + ' answer, so the question those answers come from must be configured',
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
  const scoreThreshold = config.escalateBack?.scoreThreshold ?? DEFAULT_ESCALATE_BACK_SCORE_THRESHOLD
  assertScoreThreshold('ModelRouterConfig.escalateBack.scoreThreshold', scoreThreshold)
  const maxRouteErrors = config.maxRouteErrors ?? DEFAULT_MAX_ROUTE_ERRORS
  if (!Number.isInteger(maxRouteErrors) || maxRouteErrors < 1) {
    throw new Error('ModelRouterConfig.maxRouteErrors must be a positive integer')
  }
  const onUnavailable = config.onUnavailable ?? 'fallback'
  const tier = config.tier ?? 'fast'
  const contextTurns = config.state?.contextTurns ?? DEFAULT_STATE_CONTEXT_TURNS
  if (!Number.isInteger(contextTurns) || contextTurns < 0) {
    throw new Error('ModelRouterConfig.state.contextTurns must be a non-negative integer')
  }
  const maxChars = config.state?.maxChars ?? DEFAULT_STATE_MAX_CHARS
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error('ModelRouterConfig.state.maxChars must be a positive integer')
  }
  // The schema resolves an omitted optional group to absent and a valueless key
  // to null; both mean "not configured" here.
  const hardHintScoreThreshold = (config.hardHint ?? undefined)?.scoreThreshold
  if (hardHintScoreThreshold !== undefined) {
    assertScoreThreshold('ModelRouterConfig.hardHint.scoreThreshold', hardHintScoreThreshold)
  }
  const difficultyToEffort = config.difficultyToEffort ?? undefined
  if (difficultyToEffort !== undefined) {
    assertScoreThreshold('ModelRouterConfig.difficultyToEffort.scoreThreshold', difficultyToEffort.scoreThreshold)
    assertNonEmptyString(
      'ModelRouterConfig.difficultyToEffort.reasoningEffort',
      difficultyToEffort.reasoningEffort,
    )
  }
  return Object.freeze({
    initialMode: config.initialMode,
    candidates: Object.freeze(candidates),
    downgradeThreshold: config.downgradeThreshold,
    downgradeMargin: config.downgradeMargin,
    minTurnsDowngraded,
    routeInstructions: config.routeInstructions,
    ...difficultyInstructions === undefined ? {} : { difficultyInstructions },
    difficultyLevels: Object.freeze([...difficultyLevels]),
    escalateBackScoreThreshold: scoreThreshold,
    maxRouteErrors,
    onUnavailable,
    ...difficultyToEffort === undefined
      ? {}
      : {
        difficultyToEffort: Object.freeze({
          scoreThreshold: difficultyToEffort.scoreThreshold,
          reasoningEffort: difficultyToEffort.reasoningEffort,
        }),
      },
    ...hardHintScoreThreshold === undefined ? {} : { hardHintScoreThreshold },
    state: Object.freeze({ contextTurns, maxChars }),
    tier,
  })
}

/** Require one probability-shaped threshold inside [0, 1]. */
function assertRatio(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number from 0 through 1`)
  }
}

/** Require one difficulty threshold inside the 1-5 scale the levels define. */
function assertScoreThreshold(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 5) {
    throw new Error(`${name} must be a number from 1 through 5`)
  }
}
