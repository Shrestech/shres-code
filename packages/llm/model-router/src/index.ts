/**
 * Asymmetric, cache-sticky model routing.
 *
 * The deployment declares the manual/default model and a downgrade allowlist.
 * The judgment can keep that model or select an allowlisted candidate. A
 * downgrade requires both `confidence >= downgradeThreshold` and
 * `top1 - top2 >= downgradeMargin`, above the measured wobble of a rented
 * classifier's borderline answers.
 *
 * A downgrade is then held as a **streak**: a model transition costs a prefix
 * re-prefill at production context sizes, so a downgrade has to persist several
 * turns to net positive. The streak lives in the log (`model-routing/decision`,
 * `model-routing/mode`, plus `request/header` and turn events) and is folded
 * purely by `stickyState`, so resume, fork, compaction, and a process restart
 * continue it exactly as the live consult left it. While downgraded each new
 * step is judged — the difficulty question is then mandatory — so harder work
 * revealed by steering or tool results can return to the manual model.
 *
 * The consult sits inside the model-selection hook (`installModelSelection`,
 * `packages/core/agent`) that the agent registry installs on every root agent:
 * after the manual selection rewrote the request, `resolveRequest` may replace
 * it. The controller adopts root agents only; a delegated child, one whose
 * session header records a delegation depth, is routed only by the policy
 * that spawned it. A root agent without the hook cannot be routed, so the
 * controller reports it at error level once and records no routing mode for it.
 * Same-step retries reuse their judgment while its input is unchanged and
 * recheck capabilities and manual authority. A manual-model decision remains
 * in force for the rest of the turn.
 *
 * Agent Notes:
 * - .agents/notes/implemented/bug-fix/2026-09-22-routing-choice-and-difficulty.md
 * - .agents/notes/implemented/bug-fix/2026-09-25-router-selection-install-gap.md
 *
 * @module @shres-code/shres-code-model-router
 */

import { Context, Service, symbols } from '@shres-code/cordis'
import type { Events } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { modelSelectionInstalled } from '@shres-code/shres-code-agent'
import type {
  Agent,
  ModelRoutingConsult,
  ModelRoutingRequest,
  ModelSelection,
  PreStepDecision,
  RequestErrorAction,
} from '@shres-code/shres-code-agent'
import {
  declareJudgmentConsumer,
  JudgmentError,
  judgmentConsumerId,
  judgmentEngineId,
  judgmentEnabled,
  judgmentQuestionId,
} from '@shres-code/shres-code-judgment'
import type {
  JudgmentChoiceAnswer,
  JudgmentChoiceQuestion,
  JudgmentEngineId,
  JudgmentQuestion,
  JudgmentResult,
  JudgmentScoreAnswer,
  JudgmentScoreQuestion,
  JudgmentService,
} from '@shres-code/shres-code-judgment'
import { ReasoningEffortId as toEffortId } from '@shres-code/shres-code-llm'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import { installSettingsSection, settingsNamespace } from '@shres-code/shres-code-settings'
import { Remote, bindTypertRemote } from '@shres-code/shres-code-typert-protocol'
// Type-only edges: resolve `ctx.commands` and `ctx.sessionProjections` for the optional children.
import type {} from '@shres-code/shres-code-commands'
import type {} from '@shres-code/shres-code-session-projection'
import {
  DEFAULT_ESCALATE_BACK_SCORE_THRESHOLD,
  DEFAULT_ENTRY_SCORE_CEILING,
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
  DEFAULT_DIFFICULTY_LEVELS,
  KEEP_CURRENT_OPTION_ID,
  MAX_CANDIDATE_DESCRIPTION_CHARS,
  MAX_JUDGMENT_DEADLINE_MS,
  resolveConfig,
} from './config.ts'
import type { ModelRouterConfig, ResolvedModelRouterConfig } from './config.ts'
import {
  advanceStickyFoldState,
  createStickyFoldState,
  foldModelRouting,
  judgmentFailuresFor,
  readStickyFoldState,
  sameSelection,
  stickyState,
} from './folds.ts'
import { buildRoutingStateCandidates } from './state.ts'
import {
  applyStatsEvent,
  createStatsState,
  modelRoutingStatsSchema,
  positionBefore,
  routeMargin,
  viewStats,
} from './stats.ts'
import type { ModelRoutingStatsState } from './stats.ts'
import type { RoutingState as RoutingStateCandidate } from './state.ts'
import { assessModelRoutingCandidates } from './eligibility.ts'
import type { ModelRoutingJudgmentFailures, ModelRoutingStickyFoldState, ModelRoutingStickyState } from './folds.ts'
import type {
  ModelRoutingCandidate,
  ModelRoutingDecision,
  ModelRoutingDecisionDetail,
  ModelRoutingEngineFailure,
  ModelRoutingGateView,
  ModelRoutingEntryBaseView,
  ModelRoutingLastDecision,
  ModelRoutingProjection,
  ModelRoutingReason,
  ModelRoutingRouteFrom,
  ModelRoutingThresholds,
  ModelRoutingSelection,
  ModelRoutingSelectionView,
} from './types.ts'
// The `modelRouting` projection-key and session-event declarations live in
// src/types.ts (their one home); this re-export keeps the module edge in the
// emitted declarations so aggregate programs receive both merges.
export type * from './types.ts'
export {
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
  KEEP_CURRENT_OPTION_ID,
  MAX_CANDIDATE_DESCRIPTION_CHARS,
  MAX_JUDGMENT_DEADLINE_MS,
  MAX_LATENCY_JUDGMENT_DEADLINE_MS,
  resolveConfig,
} from './config.ts'
export { foldModelRouting, stickyState } from './folds.ts'
export { foldModelRoutingStats, routeMargin } from './stats.ts'
export type { ModelRoutingJudgmentFailures, ModelRoutingStickyState } from './folds.ts'

/** Settings namespace carrying the deployment's routing configuration. */
export const MODEL_ROUTER_SETTINGS_NAMESPACE = settingsNamespace('model-router')

/**
 * The consumer id every judgment ask of this router carries, so a
 * `judgment.overrides` entry for `model-router` routes its asks.
 */
export const MODEL_ROUTER_JUDGMENT_CONSUMER = judgmentConsumerId('model-router')

/** The route question's id, echoed by the answer this service reads. */
export const ROUTE_QUESTION_ID = judgmentQuestionId('model-route')

/** The difficulty question's id, echoed by the answer this service reads. */
export const DIFFICULTY_QUESTION_ID = judgmentQuestionId('turn-difficulty')

/** The human command that switches routing. */
export const ROUTE_COMMAND = 'route'

declare module '@shres-code/cordis' {
  interface Context {
    modelRouting: ModelRoutingController
  }
}

/** The engine facts one judgment call is decided on, read with no await between them. */
interface EngineSnapshot {
  /** Registry id of the engine; absent when a single-engine service selects none. */
  readonly engineId?: JudgmentEngineId
  /** Whether the engine declares `verbalized` calibration and no operating point accepts it. */
  readonly refused: boolean
  /** The engine's registry state while it is becoming ready. */
  readonly warming?: 'starting' | 'not-installed'
  /** Counted failures that apply to this engine; undefined when none do. */
  readonly failures: ModelRoutingJudgmentFailures | undefined
  /** Thresholds in force for this engine. */
  readonly thresholds: ModelRoutingThresholds
}

/** One assembled judgment state, with the surface seqs it came from. */
interface RoutingState {
  /** Complete alternatives, ordered by retained context. */
  alternatives: readonly RoutingStateCandidate[]
  /** Exact complete candidate inputs used to recognize an unchanged retry. */
  inputKey: string
  /** Assembled state text. */
  text: string
  /** Stable hash of that text. */
  hash: string
  /** Surface seqs the text was assembled from, in order. */
  seqs: number[]
  /** Selected-window messages omitted to retain the complete current request. */
  omittedSeqs: number[]
  /** The complete current request cannot fit the configured state budget. */
  oversizedCurrent: boolean
}

/** A downgraded step's retry decision, or the manual route retained for its turn. */
interface PinnedDecision {
  /** Turn the decision belongs to. */
  turn: number
  /** Step whose judgment can be reused by a request retry. */
  step: number
  /** Unredacted candidate inputs, before a provider selects or transforms one. */
  inputKey: string
  /** The logged decision. */
  decision: ModelRoutingDecision
  /** For a `route-failed` pin: the route that failed and the manual route its retry runs. */
  manualRetry?: { readonly failed: ModelRoutingSelection; readonly manual: ModelSelection }
}

/** A mode change awaiting an accepted request boundary. */
interface PendingMode {
  active: boolean
  source: 'configuration' | 'user'
}

/** Projection unit state: mode and command fields plus the shared sticky fold. */
interface ModelRoutingUnitState {
  active: boolean
  wanted: boolean | null
  last: ModelRoutingLastDecision | null
  sticky: ModelRoutingStickyFoldState
  lastStrong: ModelRoutingEntryBaseView | null
  /** A streak just ended and its first manual-route reply has not arrived. */
  returnPending: boolean
  returnThinking: 'present' | 'absent' | null
}

/** Project one in-process selection onto its plain wire view. */
function selectionView(selection: ModelRoutingSelection): ModelRoutingSelectionView {
  return {
    candidateId: selection.candidateId,
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: String(selection.reasoningEffort) },
  }
}

/** Convert the durable entry-base view back to the in-process model selection. */
function modelSelectionFromEntryBase(base: ModelRoutingEntryBaseView): ModelSelection {
  return {
    provider: base.provider,
    model: base.model,
    ...base.reasoningEffort === undefined ? {} : { reasoningEffort: toEffortId(base.reasoningEffort) },
  }
}

/**
 * Find the manual route behind the request header that actually served the last
 * routed request. A later decision without a header is deliberately ignored:
 * the process may have stopped between decision logging and request assembly.
 * @param events - the session log to inspect.
 * @returns the routed decision's entry base, or undefined when the last header
 *   was manual or no matching decision exists in that turn.
 */
function entryBaseForLastRoutedHeader(events: readonly SessionEvent[]): ModelRoutingEntryBaseView | undefined {
  let header: Extract<SessionEvent, { type: 'request/header' }> | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (header === undefined) {
      if (event?.type === 'request/header') header = event
      continue
    }
    if (event?.type === 'turn/start') return undefined
    if (event?.type !== 'model-routing/decision') continue
    if (event.data.outcome !== 'downgraded' || event.data.selection === undefined) return undefined
    const selection = event.data.selection
    const headerConfig = header.data.header.config
    if (selection.provider !== headerConfig.provider || selection.model !== headerConfig.model) return undefined
    const selectionEffort = selection.reasoningEffort === undefined ? undefined : String(selection.reasoningEffort)
    const headerEffort = header.data.header.adapterDefaults?.reasoningEffort === true
      ? undefined
      : headerConfig.reasoningEffort === undefined ? undefined : String(headerConfig.reasoningEffort)
    if (selectionEffort !== headerEffort) return undefined
    return event.data.sticky.entryBase
  }
  return undefined
}

/**
 * The manual route one downgraded decision records as the streak's entry base.
 *
 * The live base supplies the effort only when the fold carried none: the entry
 * base outlives the header it came from, because routing rewrites that header to
 * the candidate once the streak holds.
 * @param sticky - the sticky state this decision was taken from.
 * @param base - the manual selection the consult was handed for this turn.
 * @returns the entry base to record, effort included.
 */
function entryBaseOf(sticky: ModelRoutingStickyState, base: ModelSelection): ModelRoutingEntryBaseView {
  const effort = sticky.entryBase?.reasoningEffort
    ?? (base.reasoningEffort === undefined ? undefined : String(base.reasoningEffort))
  return {
    provider: sticky.entryBase?.provider ?? base.provider,
    model: sticky.entryBase?.model ?? base.model,
    ...effort === undefined ? {} : { reasoningEffort: effort },
  }
}

/**
 * The `routeFrom` entry for one manual route: provider and model match, and
 * the reasoning effort is not compared.
 * @param config - the resolved configuration.
 * @param base - the manual route in force.
 * @returns the matching entry, or undefined when routing never starts from this route.
 */
function routeFromFor(config: ResolvedModelRouterConfig, base: ModelSelection): ModelRoutingRouteFrom | undefined {
  return config.routeFrom.find(entry => entry.provider === base.provider && entry.model === base.model)
}

/**
 * The entry position a decision continuing a held streak records: the turn and
 * step the fold carries for it, each omitted when the entering record lacked it.
 * @param sticky - the sticky state of the held streak.
 * @returns the entered turn and step to record.
 */
function heldEntry(sticky: ModelRoutingStickyState): { enteredTurn?: number; enteredStep?: number } {
  return {
    /* v8 ignore next -- stickyState assigns enteredTurn whenever a held candidate exists */
    ...sticky.enteredTurn === undefined ? {} : { enteredTurn: sticky.enteredTurn },
    ...sticky.enteredStep === undefined ? {} : { enteredStep: sticky.enteredStep },
  }
}

/** Wire payload schema of the `modelRouting` projection. */
const modelRoutingProjectionSchema = zod.object({
  active: zod.boolean(),
  pending: zod.boolean(),
  last: zod.object({
    outcome: zod.union([zod.literal('downgraded'), zod.literal('kept-strong'), zod.literal('skipped'), zod.literal('error')]),
    reason: zod.string(),
    confidence: zod.number(),
    hint: zod.literal('consider-stronger'),
    selection: zod.object({
      candidateId: zod.string(),
      provider: zod.string(),
      model: zod.string(),
      reasoningEffort: zod.string(),
    }).partial({ reasoningEffort: true }),
  }).partial({ selection: true, confidence: true, hint: true }).optional(),
  sticky: zod.object({
    active: zod.boolean(),
    stepsElapsed: zod.number(),
    selection: zod.object({
      candidateId: zod.string(),
      provider: zod.string(),
      model: zod.string(),
      reasoningEffort: zod.string(),
    }).partial({ reasoningEffort: true }).optional(),
  }).optional(),
  lastStrong: zod.object({
    provider: zod.string(),
    model: zod.string(),
    reasoningEffort: zod.string(),
  }).partial({ reasoningEffort: true }).optional(),
  returnThinking: zod.union([zod.literal('present'), zod.literal('absent')]).optional(),
}) as unknown as ZodType<ModelRoutingProjection>

/**
 * The stable hash recorded on every decision: a 32-bit FNV-1a of the state
 * text, rendered as eight hex digits. Recorded so a rerun with the same state
 * is recognizable; it never gates a decision.
 * @param text - the assembled state.
 * @returns the hash.
 */
export function stateHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Whether the log holds an opened turn without its closing `turn/end`. */
function hasOpenTurn(events: readonly SessionEvent[]): boolean {
  let open = false
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  return open
}

/**
 * `ctx.modelRouting`: owns the logged routing mode, routing decisions, and
 * the consult `installModelSelection` reaches. No live mirror of the mode is
 * kept — the log is the state — and its configuration, mode, and decision events write no prompt, tool,
 * or model request.
 */
export class ModelRoutingController extends Service implements ModelRoutingConsult {
  /**
   * Composition config schema, which is also the `model-router` settings
   * section schema. Unknown keys and wrong types fail plugin load by name.
   */
  static Config = z.object({
    initialMode: z.union(['off', 'on']).required(),
    candidates: z.array(z.object({
      id: z.string().required(),
      provider: z.string().required(),
      model: z.string().required(),
      reasoningEffort: z.string(),
      description: z.string().max(MAX_CANDIDATE_DESCRIPTION_CHARS).required(),
    })).default([]),
    routeFrom: z.array(z.object({
      provider: z.string().required(),
      model: z.string().required(),
      objective: z.union(['quota', 'dollars', 'latency']).required(),
      allowEveryTurn: z.boolean(),
    })).default([]),
    downgradeThreshold: z.number().min(0).max(1).required(),
    downgradeMargin: z.number().min(0).max(1).required(),
    operatingPoints: z.array(z.object({
      engine: z.string().required(),
      downgradeThreshold: z.number().min(0).max(1).required(),
      downgradeMargin: z.number().min(0).max(1).required(),
      calibratedBy: z.string(),
      acceptVerbalized: z.boolean(),
    })).default([]),
    hold: z.object({
      minSteps: z.number().step(1).min(0).default(DEFAULT_HOLD_MIN_STEPS),
      maxSteps: z.number().step(1).min(1).default(DEFAULT_HOLD_MAX_STEPS),
    }),
    reentryCooldownTurns: z.number().step(1).min(0).default(DEFAULT_REENTRY_COOLDOWN_TURNS),
    routeInstructions: z.string().required(),
    difficultyInstructions: z.string(),
    difficultyLevels: z.array(z.string()).default([...DEFAULT_DIFFICULTY_LEVELS]),
    difficulty: z.object({
      entryScoreCeiling: z.number().min(0).default(DEFAULT_ENTRY_SCORE_CEILING),
    }),
    escalateBack: z.object({
      scoreThreshold: z.number().min(0).default(DEFAULT_ESCALATE_BACK_SCORE_THRESHOLD),
    }),
    maxRouteErrors: z.number().step(1).min(1).default(DEFAULT_MAX_ROUTE_ERRORS),
    onUnavailable: z.union(['fallback', 'error']).default('fallback'),
    judgmentDeadlineMs: z.number().step(1).min(1).max(MAX_JUDGMENT_DEADLINE_MS).default(DEFAULT_JUDGMENT_DEADLINE_MS),
    judgmentFailures: z.object({
      holdTolerance: z.number().step(1).min(0).default(DEFAULT_JUDGMENT_HOLD_TOLERANCE),
      breakerThreshold: z.number().step(1).min(1).default(DEFAULT_JUDGMENT_BREAKER_THRESHOLD),
      breakerOpenTurns: z.number().step(1).min(0).default(DEFAULT_JUDGMENT_BREAKER_OPEN_TURNS),
    }),
    inTurnFallback: z.union(['manual', 'off']).default('manual'),
    // Both optional field groups are unions with `z.const(null)`: schemastery
    // materializes an absent bare object as `{}` (probe-verified), which would
    // make the router see a lift or a hint the deployment never wrote. The
    // union keeps an omitted key absent, and a valueless `difficultyToEffort:`
    // resolves to null — which resolveConfig reads as not configured.
    difficultyToEffort: z.union([z.const(null), z.object({
      scoreThreshold: z.number().min(0),
      reasoningEffort: z.string(),
    })]) as unknown as z<ModelRouterConfig['difficultyToEffort']>,
    hardHint: z.union([z.const(null), z.object({
      scoreThreshold: z.number().min(0).default(DEFAULT_ESCALATE_BACK_SCORE_THRESHOLD),
    })]) as unknown as z<ModelRouterConfig['hardHint']>,
    state: z.object({
      contextTurns: z.number().step(1).min(0).default(DEFAULT_STATE_CONTEXT_TURNS),
      maxChars: z.number().step(1).min(1).default(DEFAULT_STATE_MAX_CHARS),
      maxFitCandidates: z.number().step(1).min(2).default(DEFAULT_STATE_MAX_FIT_CANDIDATES),
    }),
    tier: z.union(['fast', 'accurate']).default('fast'),
    // The annotation is a cast because two fields are unions with `z.const(null)`
    // (see their comment above); the schema is still one inline `z.object` call,
    // which is what the config catalog walks.
  }) as z<ModelRouterConfig>

  /** Binds `ctx.modelRouting` to the `modelRouting` Remote namespace. */
  readonly typertRemote = bindTypertRemote(this, 'modelRouting')
  private source: () => ModelRouterConfig
  private lastRaw: ModelRouterConfig | undefined
  private lastGood: ResolvedModelRouterConfig | undefined
  private readonly pins = new WeakMap<Session, PinnedDecision>()
  private readonly pendingIntents = new WeakMap<Session, PendingMode>()
  private readonly liveAgents = new Set<Agent>()
  /** Root agents this controller has not adopted because they carried no model-selection hook when announced. */
  private readonly unreachable = new WeakSet<Agent>()

  /**
   * @param ctx - the context this service registers `ctx.modelRouting` on.
   * @param config - composition config; the settings user layer merges over it.
   */
  constructor(ctx: Context, config: ModelRouterConfig) {
    super(ctx, 'modelRouting')
    this.source = () => config
    this.config()
    ctx.on('agent/created', ({ agent }) => { this.attachAgent(agent) })
    ctx.on('agent/disposed', ({ agent }) => { this.forgetAgent(agent) }, { global: true })
    ctx.effect(() => () => { this.liveAgents.clear() })
    // A pending mode selection is committed at the next accepted in-turn
    // pre-step, so the change lands with the request assembly it belongs to
    // rather than mid-step.
    ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted || !this.ownsAgent(agent)) return decision
      this.attachAgent(agent)
      const wanted = this.pendingIntents.get(agent.session)
      if (wanted === undefined) return decision
      this.commitMode(agent.session, wanted)
      return decision
    })
    // A failed downgraded request retries its step on the manual route only
    // after every other recovery listener declined: calling `next()` first
    // leaves transient retries of the candidate to their owner in any listener
    // order. A waterfall can hold this callback past disposal, so a stale
    // callback only delegates.
    let recoveryLive = true
    ctx.on('agent/request-error', async (payload, next): Promise<RequestErrorAction> => {
      const downstream = await next()
      if (!recoveryLive || downstream?.kind === 'retry') return downstream
      return this.fallBackToManual(payload)
    })
    ctx.effect(() => () => { recoveryLive = false })
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register<'modelRouting', ModelRoutingUnitState>({
        key: 'modelRouting',
        schema: modelRoutingProjectionSchema,
        init: () => ({
          active: false,
          wanted: null,
          last: null,
          sticky: createStickyFoldState(),
          lastStrong: null,
          returnPending: false,
          returnThinking: null,
        }),
        apply: (state, event) => {
          const sticky = advanceStickyFoldState(state.sticky, event)
          switch (event.type) {
            case 'command/run':
              if (event.data.name !== ROUTE_COMMAND || event.data.args === undefined) return state
              if (event.data.args.trim() !== 'on' && event.data.args.trim() !== 'off') return state
              return { ...state, wanted: event.data.args.trim() === 'on' }
            case 'model-routing/mode':
            case 'model-routing/configuration':
              return { ...state, active: event.data.active, wanted: null, sticky }
            case 'model-routing/decision': {
              const data = event.data
              const last: ModelRoutingLastDecision = {
                outcome: data.outcome,
                reason: data.reason,
                ...data.selection === undefined ? {} : { selection: selectionView(data.selection) },
                ...data.route === undefined ? {} : { confidence: data.route.confidence },
                ...data.hint === undefined ? {} : { hint: data.hint },
              }
              return {
                ...state,
                sticky,
                last,
                // Only an active record carries a base, so the retained route
                // outlives the streak: ending one reports nothing itself.
                lastStrong: data.sticky.entryBase ?? state.lastStrong,
                // The next reply is the first on the manual route after the streak.
                returnPending: state.sticky.active && !sticky.active ? true : state.returnPending,
              }
            }
            // The sticky fold ignores replies, so its accumulator is unchanged here.
            case 'assistant/message':
              if (!state.returnPending) return state
              return {
                ...state,
                returnPending: false,
                returnThinking: event.data.message.content.some(block => block.type === 'reasoning') ? 'present' : 'absent',
              }
            default:
              return sticky === state.sticky ? state : { ...state, sticky }
          }
        },
        view: (state) => {
          const sticky = readStickyFoldState(state.sticky)
          return {
            active: state.active,
            pending: state.wanted !== null && state.wanted !== state.active,
            ...state.last === null ? {} : { last: state.last },
            ...state.lastStrong === null ? {} : { lastStrong: state.lastStrong },
            ...state.returnThinking === null ? {} : { returnThinking: state.returnThinking },
            sticky: {
              active: sticky.active,
              stepsElapsed: sticky.stepsElapsed,
              ...sticky.candidate === undefined ? {} : { selection: selectionView(sticky.candidate) },
            },
          }
        },
        // The accumulator keys its counted judgment failures by engine.
        stateVersion: 10,
      })
      projectionCtx.sessionProjections.register<'modelRoutingStats', ModelRoutingStatsState>({
        key: 'modelRoutingStats',
        schema: modelRoutingStatsSchema,
        init: createStatsState,
        apply: applyStatsEvent,
        view: viewStats,
        // The unit state counts warm-ups, judge usage, recorded thresholds, and failed-ask latency.
        stateVersion: 4,
      })
    })
    declareJudgmentConsumer(ctx, MODEL_ROUTER_JUDGMENT_CONSUMER)
    this.reportUnregisteredOperatingPoints(ctx)
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: ROUTE_COMMAND,
        description: 'Switch automatic model routing on or off, or report its state',
        input: { hint: '[on|off]' },
        handler: ({ agent, rawInput }) => this.runCommand(agent, rawInput),
      })
    })
    installSettingsSection(ctx, MODEL_ROUTER_SETTINGS_NAMESPACE, ModelRoutingController.Config, config, {
      // A stored section this router could not act on is refused where it is
      // written, naming the offending key.
      validate: (next) => {
        resolveConfig(next)
      },
      setSource: (next) => {
        this.source = next
      },
      onChange: () => {
        for (const agent of this.liveAgents) {
          if (this.ownsAgent(agent)) this.reconcileConfiguration(agent.session)
          else this.forgetAgent(agent)
        }
      },
    })
    ctx.inject(['agents', 'modelRouting'], (agentCtx) => {
      for (const agent of agentCtx.agents.list()) this.attachAgent(agent)
    })
  }

  /**
   * Report each operating point that names an engine no provider registered,
   * once, after the Loader settles and again whenever a settings or registry
   * change introduces one; report at info level when one resolves. A point for
   * an unregistered engine never applies, and routing on the engine that was
   * meant runs on the uncalibrated global defaults, so the typo must be seen.
   * The Loader is read structurally, as `judgment-dispatch` reads it.
   * @param ctx - the router's context.
   */
  private reportUnregisteredOperatingPoints(ctx: Context): void {
    ctx.inject(['judgmentEngines'], (registryCtx) => {
      const registry = registryCtx.judgmentEngines
      const reported = new Set<string>()
      let settled = false
      const reconcile = (): void => {
        if (!settled) return
        const named = new Set(this.config().operatingPoints.map(point => point.engine))
        for (const id of named) {
          if (registry.get(judgmentEngineId(id)) !== undefined || reported.has(id)) continue
          reported.add(id)
          registryCtx.logger.error('model-router: operatingPoints names engine "%s", which is not composed; the point never applies', id)
        }
        for (const id of [...reported]) {
          if (named.has(id) && registry.get(judgmentEngineId(id)) === undefined) continue
          reported.delete(id)
          if (named.has(id)) registryCtx.logger.info('model-router: engine "%s" is now composed; its operating point applies', id)
        }
      }
      registryCtx.effect(() => {
        let live = true
        const loader = (registryCtx.get as (name: string) => { await(): Promise<void> } | undefined)('loader')
        loader?.await().then(() => {
          if (!live) return
          settled = true
          reconcile()
        }, () => {
          // A fiber elsewhere failed to load; the Loader reports it, and a
          // later settings or registry change reconciles again.
        })
        return () => {
          live = false
        }
      }, 'model-router: report unregistered operating points')
      registryCtx.effect(() => registry.subscribe(reconcile), 'model-router: reconcile operating points on registry change')
      registryCtx.effect(() => registryCtx.on('settings/updated', (ns) => {
        if (ns === MODEL_ROUTER_SETTINGS_NAMESPACE) reconcile()
      }), 'model-router: reconcile operating points on settings change')
    })
  }

  /**
   * The engine facts one judgment call is decided on, read with no await
   * between them: the engine's registry calibration and status, its operating
   * point, the thresholds in force, and the failures counted against it.
   * @param engine - the judgment service.
   * @param config - resolved configuration carrying the operating points and global thresholds.
   * @param sticky - fold state carrying the counted failures.
   * @param engineId - the engine to describe; omission reads the one selected for this router now.
   * @returns the snapshot.
   */
  private engineSnapshot(
    engine: JudgmentService,
    config: ResolvedModelRouterConfig,
    sticky: ModelRoutingStickyState,
    engineId: JudgmentEngineId | undefined = engine.selectedEngine(MODEL_ROUTER_JUDGMENT_CONSUMER),
  ): EngineSnapshot {
    const entry = engineId === undefined ? undefined : this.ctx.get('judgmentEngines')?.get(engineId)
    const point = engineId === undefined ? undefined : config.operatingPoints.find(candidate => candidate.engine === engineId)
    const state = entry?.status().state
    return {
      ...engineId === undefined ? {} : { engineId },
      // A generative model's stated probabilities do not gate unless the
      // deployment accepted them for this engine.
      refused: entry?.descriptor.calibration === 'verbalized' && point?.acceptVerbalized !== true,
      ...state === 'starting' || state === 'not-installed' ? { warming: state } : {},
      failures: judgmentFailuresFor(sticky.judgmentFailures, engineId),
      // Built in one fixed key order, so equal inputs log equal decisions.
      thresholds: {
        downgradeThreshold: point?.downgradeThreshold ?? config.downgradeThreshold,
        downgradeMargin: point?.downgradeMargin ?? config.downgradeMargin,
        ...config.difficultyInstructions === undefined ? {} : {
          entryScoreCeiling: config.entryScoreCeiling,
          escalateBackScoreThreshold: config.escalateBackScoreThreshold,
        },
        source: point === undefined ? 'global' : 'operating-point',
        ...point?.calibratedBy === undefined ? {} : { calibratedBy: point.calibratedBy },
      },
    }
  }

  /**
   * Adopt a root agent whose resolved routing service is this controller. A
   * root agent without the model-selection hook is reported once and gets no
   * routing mode, because no request of it can reach the consult.
   */
  private attachAgent(agent: Agent): void {
    if (!this.ownsAgent(agent) || delegatedChild(agent)) return
    if (!modelSelectionInstalled(agent)) {
      if (this.unreachable.has(agent)) return
      this.unreachable.add(agent)
      this.ctx.logger.error(
        'model-router: agent "%s" has no model-selection hook, so routing cannot run for it; '
          + 'the agent registry installs the hook for every root agent',
        agent.id,
      )
      return
    }
    this.liveAgents.add(agent)
    this.reconcileConfiguration(agent.session)
  }

  /**
   * Adopt a root agent reported unreachable once it carries the hook, which a
   * front end providing its selection later installs. Its routing mode is
   * committed then, or at the next accepted pre-step while a turn is open.
   */
  private adoptIfReachable(agent: Agent): void {
    if (!this.unreachable.has(agent) || !modelSelectionInstalled(agent)) return
    this.unreachable.delete(agent)
    this.liveAgents.add(agent)
    this.reconcileConfiguration(agent.session)
  }

  /** Resolve service ownership through the agent's current isolation realm. */
  private ownsAgent(agent: Agent): boolean {
    const service = agent.ctx.get('modelRouting') as (ModelRoutingController & {
      [symbols.original]?: ModelRoutingController
    }) | undefined
    return (service?.[symbols.original] ?? service) === this
  }

  /** Release pending work when an agent leaves this controller. */
  private forgetAgent(agent: Agent): void {
    if (!this.liveAgents.delete(agent)) return
    this.pendingIntents.delete(agent.session)
    this.pins.delete(agent.session)
  }

  /** Commit deployment defaults without replacing an explicit session choice. */
  private reconcileConfiguration(session: Session): void {
    if (this.hasManualMode(session) || this.pendingIntents.get(session)?.source === 'user') return
    const active = this.config().initialMode === 'on'
    if (active === this.modeOf(session)) {
      this.pendingIntents.delete(session)
      return
    }
    const wanted: PendingMode = { active, source: 'configuration' }
    if (hasOpenTurn(session.events)) this.pendingIntents.set(session, wanted)
    else this.commitMode(session, wanted)
  }

  /** An explicit user selection remains authoritative across settings updates. */
  private hasManualMode(session: Session): boolean {
    return session.events.some(event => event.type === 'model-routing/mode')
  }

  /**
   * The resolved configuration in force, re-resolved per read and memoized by
   * the raw snapshot's identity.
   *
   * There is no keep-last-good recovery here on purpose: a settings write this
   * resolver could not act on is refused by the `validate` hook below before it
   * commits, and the settings seam keeps a namespace's last good value when an
   * already-stored section fails to resolve — so a bad value reaches this method
   * only from a caller that bypassed both, and failing loud there is the honest
   * answer rather than masking a configuration the deployment did not write.
   * @returns the resolved configuration.
   */
  config(): ResolvedModelRouterConfig {
    const raw = this.source()
    if (raw === this.lastRaw && this.lastGood !== undefined) return this.lastGood
    const next = resolveConfig(raw)
    this.lastRaw = raw
    this.lastGood = next
    return next
  }

  /**
   * The gate configuration in force now. Decisions do not record it, so a
   * drill-down reads the current values.
   * @returns the thresholds, judgment deadline, difficulty band, and hold.
   */
  @Remote('gate')
  gateView(): ModelRoutingGateView {
    const config = this.config()
    return {
      downgradeThreshold: config.downgradeThreshold,
      downgradeMargin: config.downgradeMargin,
      operatingPoints: config.operatingPoints.map(point => ({ ...point })),
      judgmentDeadlineMs: config.judgmentDeadlineMs,
      entryScoreCeiling: config.entryScoreCeiling,
      escalateBackScoreThreshold: config.escalateBackScoreThreshold,
      difficultyLevels: [...config.difficultyLevels],
      hold: { minSteps: config.hold.minSteps, maxSteps: config.hold.maxSteps },
      stateMaxChars: config.state.maxChars,
    }
  }

  /**
   * One logged decision, verbatim, with the turn and step it was logged in and
   * the gate configuration in force now.
   * @param agent - the session's Agent.
   * @param seq - seq of a `model-routing/decision` event in that session's log.
   * @returns the decision detail.
   * @throws when the seq does not name a `model-routing/decision` event.
   */
  @Remote('decision')
  decisionDetail(agent: Agent, seq: number): ModelRoutingDecisionDetail {
    const events = agent.session.events
    const index = events.findIndex(event => event.seq === seq)
    const event = events[index]
    if (event?.type !== 'model-routing/decision') {
      throw new Error(`session "${agent.session.id}" logs no model-routing/decision at seq ${String(seq)}`)
    }
    return { seq, time: event.time, ...positionBefore(events, index), decision: event.data, gate: this.gateView() }
  }

  /**
   * Read the logged mode and any selection awaiting the next accepted pre-step.
   * @param agent - the agent to read.
   * @returns the mode in force plus a pending selection, when present.
   */
  get(agent: Agent): { active: boolean; pending?: boolean } {
    const active = this.modeOf(agent.session)
    const pending = this.pendingIntents.get(agent.session)
    return pending === undefined ? { active } : { active, pending: pending.active }
  }

  /**
   * The mode in force on one session, derived from committed configuration
   * and user mode events. A log with neither starts off.
   * @param session - the session to read.
   * @param end - fold the first `end` events; defaults to the whole log.
   * @returns whether routing is active.
   */
  modeOf(session: Session, end: number = session.events.length): boolean {
    return foldModelRouting(session.events, end)
  }

  /**
   * Switch routing on or off. Between turns the change is appended
   * immediately; a changed value during an open turn waits for the next
   * accepted pre-step. An explicit choice equal to the current value records
   * user authority immediately and prevents later settings from overriding it.
   * @param agent - the agent to switch.
   * @param active - whether routing should be active.
   * @returns what happened: `committed`, `queued`, `cancelled`, or `noop`.
   */
  set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop' {
    const session = agent.session
    const pending = this.pendingIntents.get(session)
    const logged = this.modeOf(session)
    const manual = this.hasManualMode(session)
    if (pending?.source === 'user' && active === pending.active) return 'noop'
    const wanted: PendingMode = { active, source: 'user' }
    if (active === logged) {
      this.commitMode(session, wanted)
      return pending !== undefined ? 'cancelled' : manual ? 'noop' : 'committed'
    }
    if (hasOpenTurn(session.events)) {
      this.pendingIntents.set(session, wanted)
      return 'queued'
    }
    this.commitMode(session, wanted)
    return 'committed'
  }

  /** Append one pending selection before the next request assembly. */
  private commitMode(session: Session, wanted: PendingMode): void {
    const manual = this.hasManualMode(session)
    if (wanted.source === 'user') {
      if (!manual || wanted.active !== this.modeOf(session)) {
        session.append('model-routing/mode', { active: wanted.active })
      }
    } else {
      session.append('model-routing/configuration', { active: wanted.active })
    }
    // Delete only after the append succeeds so a later accepted pre-step can
    // retry a failed durable write.
    this.pendingIntents.delete(session)
  }

  /**
   * Resolve the route one request should run. Called by
   * `installModelSelection` after the manual selection rewrote the request: a
   * non-undefined result replaces provider/model/effort, and `undefined` leaves
   * the manual route in force.
   *
   * Each new downgraded step reassesses the latest task evidence. Same-step
   * retries reuse the judgment only while its complete candidate inputs are
   * unchanged, and recheck manual authority, `routeFrom` and pool membership, and
   * capabilities. A manual-model decision lasts for the turn.
   * @param agent - the agent whose turn is being prepared.
   * @param turn - the turn number, as the loop dispatched it.
   * @param step - the step number within the turn; retries share its judgment.
   * @param base - the route the manual selection left in force.
   * @param signal - the request's cancellation signal.
   * @param request - frozen conversation content and the manually selected call configuration.
   * @returns the route to run, or `undefined` to keep the manual route.
   */
  async resolveRequest(
    agent: Agent,
    turn: number,
    step: number,
    base: ModelSelection,
    signal: AbortSignal,
    request: ModelRoutingRequest,
  ): Promise<ModelSelection | undefined> {
    signal.throwIfAborted()
    // A delegated child is routed only by the policy that spawned it, even
    // when a front end gave it a model-selection hook.
    if (delegatedChild(agent)) return undefined
    // Only the hook calls the consult, so an agent reported unreachable has it now.
    this.adoptIfReachable(agent)
    const session = agent.session
    const active = this.modeOf(session)
    const pinned = this.pins.get(session)
    let state: RoutingState | undefined
    if (pinned !== undefined && pinned.turn === turn) {
      if (!active) {
        // A committed off-switch releases this turn's pinned selection.
        this.pins.delete(session)
        this.log(session, {
          outcome: 'skipped',
          reason: 'mode-off',
          stateHash: pinned.decision.stateHash,
          stateSeqs: pinned.decision.stateSeqs,
          sticky: { active: false, stepsElapsed: 0 },
        })
        return undefined
      }
      if (pinned.decision.outcome === 'downgraded') {
        if (pinned.step === step) {
          state = this.buildState(session, this.config())
          if (pinned.inputKey === state.inputKey) {
            return this.revalidatePinned(agent, turn, step, pinned.decision, base, request, signal)
          }
        }
      } else if (pinned.manualRetry !== undefined) {
        // Without an installed session selection, the manual base is read from
        // the last request header, which carries the route that just failed.
        const { failed, manual } = pinned.manualRetry
        return failed.provider === base.provider && failed.model === base.model ? manual : undefined
      } else {
        const manual = pinned.decision.sticky.entryBase
        if (pinned.decision.reason !== 'route-errors'
          || (manual?.provider === base.provider && manual.model === base.model)) return undefined
      }
    }
    if (!active) {
      // Off is off: no judgment, no decision event, no request rewrite. This is
      // what keeps a composed-but-off run byte-identical to one without the
      // package.
      return undefined
    }
    const config = this.config()
    state ??= this.buildState(session, config)
    const sticky = stickyState(session.events)
    const resolved = await this.decide(config, state, sticky, base, turn, step, signal, request)
    const from = routeFromFor(config, base)
    const decision = {
      ...resolved,
      ...from === undefined ? {} : { objective: from.objective },
      stateProjection: resolved.stateProjection ?? {
        renderer: 'conversation-v1' as const,
        contextTurns: config.state.contextTurns,
        maxChars: config.state.maxChars,
        omittedSeqs: state.omittedSeqs,
      },
    }
    signal.throwIfAborted()
    this.log(session, decision)
    this.pins.set(session, { turn, step, inputKey: state.inputKey, decision })
    return decision.outcome === 'downgraded' ? selectionAsModel(decision.selection) : undefined
  }

  /**
   * Retry one failed downgraded request on the manual route.
   *
   * Only the request this controller routed qualifies: the step's pinned
   * decision is a downgrade, and the latest request header and the failed
   * provider carry its selection. The `route-failed` decision is appended
   * before the pin changes, so the retried request resolves the manual route
   * and its header follows the decision; the pin keeps the recorded manual
   * route for a caller whose manual base is the failed header. Cancellation and
   * `inTurnFallback: 'off'` leave the failure terminal.
   * @param payload - the failed attempt as the loop reported it.
   * @returns a retry of the step, or `undefined` to leave the failure terminal.
   */
  private fallBackToManual(payload: Parameters<Events['agent/request-error']>[0]): RequestErrorAction {
    const { agent, turn, step, provider, failure, signal } = payload
    if (signal.aborted || failure.code === 'ABORTED' || this.config().inTurnFallback !== 'manual') return undefined
    const session = agent.session
    const pinned = this.pins.get(session)
    if (pinned === undefined || pinned.turn !== turn || pinned.step !== step) return undefined
    const routed = pinned.decision
    const selection = routed.selection
    if (routed.outcome !== 'downgraded') return undefined
    /* v8 ignore next -- only this controller's complete downgraded decisions enter the pin. */
    if (selection === undefined) return undefined
    const ran = session.events.findLast((event): event is SessionEvent<'request/header'> => event.type === 'request/header')
      ?.data.header.config
    if (ran === undefined || ran.provider !== selection.provider || ran.model !== selection.model
      || provider !== selection.provider) return undefined
    const failedChunk = session.events.findLast((event): event is SessionEvent<'assistant/chunk'> =>
      event.type === 'assistant/chunk' && event.data.turn === turn && event.data.step === step)
    const entryBase = routed.sticky.entryBase
    /* v8 ignore next -- a downgraded decision always records the manual route it descends beneath */
    if (entryBase === undefined) return undefined
    const decision: ModelRoutingDecision = {
      outcome: 'kept-strong',
      reason: 'route-failed',
      stateHash: routed.stateHash,
      stateSeqs: routed.stateSeqs,
      failure: { code: failure.code, provider: selection.provider, model: selection.model },
      ...failedChunk === undefined ? {} : { failedChunkSeq: failedChunk.seq },
      /* v8 ignore next -- a downgrade is only resolved against a listed route, which records its objective */
      ...routed.objective === undefined ? {} : { objective: routed.objective },
      sticky: {
        active: false,
        stepsElapsed: 0,
        brokenBy: 'route-failed',
        entryBase,
      },
    }
    this.log(session, decision)
    this.pins.set(session, { ...pinned, decision, manualRetry: { failed: selection, manual: modelSelectionFromEntryBase(entryBase) } })
    return { kind: 'retry' }
  }

  /**
   * Recheck a retry's held route against manual authority, the `routeFrom`
   * allowlist, the candidate pool, and current provider registrations.
   */
  private async revalidatePinned(
    agent: Agent,
    turn: number,
    step: number,
    previous: ModelRoutingDecision,
    base: ModelSelection,
    request: ModelRoutingRequest,
    signal: AbortSignal,
  ): Promise<ModelSelection | undefined> {
    const selection = previous.selection
    /* v8 ignore next -- only this controller's complete downgraded decisions enter the pin. */
    if (selection === undefined) return undefined
    const config = this.config()
    const entryBase = previous.sticky.entryBase
    const candidate = config.candidates.find(entry => entry.id === selection.candidateId
      && entry.provider === selection.provider && entry.model === selection.model)
    const from = routeFromFor(config, base)
    let reason: 'manual-deviation' | 'base-unlisted' | 'unknown-candidate' | 'candidate-ineligible' | undefined
    let candidateEligibility: ModelRoutingDecision['candidateEligibility']
    let eligibilityMs: number | undefined
    if (entryBase !== undefined && (entryBase.provider !== base.provider || entryBase.model !== base.model)) {
      reason = 'manual-deviation'
    } else if (from === undefined) {
      // As in a fresh consult: the retry keeps the manual route once settings
      // remove it from `routeFrom`, and the ended streak starts no cooldown.
      reason = 'base-unlisted'
    } else if (candidate === undefined) {
      reason = 'unknown-candidate'
    } else {
      const llm = this.ctx.get('llm')
      if (llm !== undefined) {
        const { reasoningEffort: _configuredEffort, ...identity } = candidate
        const heldCandidate = {
          ...identity,
          ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
        }
        const eligibilityStarted = Date.now()
        candidateEligibility = await assessModelRoutingCandidates(
          llm, request.config, request.content.messages, [heldCandidate], undefined, signal,
        )
        eligibilityMs = Date.now() - eligibilityStarted
      }
      if (candidateEligibility?.eligibleCandidates.length !== 1) reason = 'candidate-ineligible'
    }
    signal.throwIfAborted()
    if (reason === undefined) return selectionAsModel(selection)
    const state = this.buildState(agent.session, config)
    const decision: ModelRoutingDecision = {
      outcome: 'kept-strong',
      reason,
      stateHash: state.hash,
      stateSeqs: state.seqs,
      stateProjection: {
        renderer: 'conversation-v1',
        contextTurns: config.state.contextTurns,
        maxChars: config.state.maxChars,
        omittedSeqs: state.omittedSeqs,
      },
      ...candidateEligibility === undefined ? {} : { candidateEligibility },
      ...eligibilityMs === undefined ? {} : { eligibilityMs },
      ...from === undefined ? {} : { objective: from.objective },
      sticky: { active: false, stepsElapsed: 0, brokenBy: reason },
    }
    this.log(agent.session, decision)
    this.pins.set(agent.session, { turn, step, inputKey: state.inputKey, decision })
    return undefined
  }

  /**
   * Report the manual selection a held downgrade descends beneath.
   *
   * A held streak rewrites the consumed `request/header` to the candidate, so
   * that header stops reporting the route the session is pointed at; a reader
   * asking for the session's selection asks this first. The answer is the same
   * fold the consult reads — no live mirror — and the effort is the one the
   * streak was entered on, because that is what the manual route still runs at.
   * When the streak has just ended, the last request header can still carry its
   * candidate. In that case the decision immediately before that header retains
   * the manual entry route until a later manual header replaces it. A decision
   * logged after the header is ignored because it may be a crash-orphaned turn.
   * @param agent - the agent whose selection is being read.
   * @returns the manual route behind an active streak or the last routed header
   *   awaiting replacement; `undefined` when the logged header is already manual.
   */
  stickySelection(agent: Agent): ModelSelection | undefined {
    const sticky = stickyState(agent.session.events)
    const base = sticky.active ? sticky.entryBase : entryBaseForLastRoutedHeader(agent.session.events)
    // A state with no base is one this consult never produced — a replayed
    // decision from a log whose entering turn recorded none — and it reports
    // nothing rather than inventing the candidate it holds.
    if (base === undefined) return undefined
    return modelSelectionFromEntryBase(base)
  }

  /**
   * Judge one step and resolve it against the allowlist and the sticky state.
   * @param config - resolved configuration.
   * @param state - the assembled state.
   * @param sticky - the sticky state before this decision.
   * @param base - the manual route in force.
   * @param turn - the turn being judged.
   * @param step - the step being judged; an entered streak records it.
   * @param signal - cancellation signal forwarded to the judgment call.
   * @param request - content and call configuration whose requirements candidates must preserve.
   * @returns the decision to log.
   */
  private async decide(
    config: ResolvedModelRouterConfig,
    state: RoutingState,
    sticky: ModelRoutingStickyState,
    base: ModelSelection,
    turn: number,
    step: number,
    signal: AbortSignal,
    request: ModelRoutingRequest,
  ): Promise<ModelRoutingDecision> {
    const held = sticky.active ? sticky.candidate : undefined
    let observed = state
    const facts: Pick<ModelRoutingDecision,
      'candidateEligibility' | 'judgmentQuestions' | 'stateProjection' | 'judgmentInput'
      | 'judgmentRejection' | 'engine' | 'model' | 'engineId' | 'latencyMs' | 'judgeUsage'
      | 'eligibilityMs' | 'inputChars'> = {}
    /** One fallback: the manual route stands, with the class that kept it. */
    const keep = (reason: ModelRoutingReason): ModelRoutingDecision => ({
      outcome: 'kept-strong',
      reason,
      stateHash: observed.hash,
      stateSeqs: observed.seqs,
      ...facts,
      sticky: { active: false, stepsElapsed: 0 },
    })
    if (sticky.needsStrongTurn === true) {
      return {
        ...keep('route-errors'),
        sticky: {
          active: false,
          stepsElapsed: 0,
          brokenBy: 'route-errors',
          entryBase: entryBaseOf({ active: false, stepsElapsed: 0 }, base),
        },
      }
    }
    // The allowlist is the enforcement point: with nothing on it nothing may be
    // downgraded to, and no judgment call is worth making.
    if (config.candidates.length === 0) return keep('no-candidates')
    if (state.oversizedCurrent) return keep('state-too-large')
    if (held !== undefined && !config.candidates.some(candidate => candidate.id === held.candidateId
      && candidate.provider === held.provider && candidate.model === held.model)) {
      return { ...keep('unknown-candidate'), sticky: { active: false, stepsElapsed: 0, brokenBy: 'unknown-candidate' } }
    }
    if (held !== undefined && sticky.entryBase !== undefined
      && (sticky.entryBase.provider !== base.provider || sticky.entryBase.model !== base.model)) {
      // Manual authority wins immediately: only the provider/model comparison
      // counts, so an unrelated header change never ends a streak.
      return {
        outcome: 'kept-strong',
        reason: 'manual-deviation',
        stateHash: observed.hash,
        stateSeqs: observed.seqs,
        sticky: { active: false, stepsElapsed: 0, brokenBy: 'manual-deviation' },
      }
    }
    // Routing starts only from a listed strong route: an unlisted one is never
    // judged, and a held streak ends when its route is removed from the list.
    if (routeFromFor(config, base) === undefined) {
      return {
        ...keep('base-unlisted'),
        sticky: { active: false, stepsElapsed: 0, ...held === undefined ? {} : { brokenBy: 'base-unlisted' as const } },
      }
    }
    // The cap bounds every hold, including one inside its entering turn, and
    // returns to the manual route while its cache is still warm.
    if (held !== undefined && sticky.stepsElapsed >= config.hold.maxSteps) {
      return { ...keep('hold-cap'), sticky: { active: false, stepsElapsed: 0, brokenBy: 'hold-cap' } }
    }
    if (held === undefined && sticky.cooldownTurn !== undefined && config.reentryCooldownTurns > 0
      && turn - sticky.cooldownTurn <= config.reentryCooldownTurns) {
      return keep('reentry-cooldown')
    }
    const consumer = MODEL_ROUTER_JUDGMENT_CONSUMER
    let engine = this.ctx.get('judgment')
    // Failures count per engine, so an engine switch starts from none. The
    // breaker is half-open once its window passes: only an answered call
    // clears the count, so the next failure opens it again.
    const breakerOpen = (failures: ModelRoutingJudgmentFailures | undefined): boolean => failures !== undefined
      && config.judgmentFailures.breakerOpenTurns > 0
      && failures.count >= config.judgmentFailures.breakerThreshold
      && turn - failures.turn <= config.judgmentFailures.breakerOpenTurns
    const withEngine = (decision: ModelRoutingDecision, snapshot: EngineSnapshot | undefined): ModelRoutingDecision =>
      snapshot?.engineId === undefined ? decision : { ...decision, engineId: snapshot.engineId }
    // A refusal needs no capability assessment, so the engine selected now is
    // checked first; the call re-checks the engine it asks immediately before
    // asking, because the selection can change during the assessment.
    let snapshot = engine === undefined ? undefined : this.engineSnapshot(engine, config, sticky)
    if (breakerOpen(snapshot === undefined ? sticky.judgmentFailures : snapshot.failures)) {
      return withEngine(keep('breaker-open'), snapshot)
    }
    if (engine === undefined || snapshot === undefined) return keep('engine-absent')
    if (!judgmentEnabled(engine.settings)) return keep('engine-disabled')
    if (snapshot.refused) return withEngine(keep('engine-uncalibrated'), snapshot)
    const llm = this.ctx.get('llm')
    if (llm === undefined) return keep('model-unavailable')
    const eligibilityStarted = Date.now()
    const eligibility = await assessModelRoutingCandidates(
      llm, request.config, request.content.messages, config.candidates, config.difficultyToEffort, signal,
    )
    facts.eligibilityMs = Date.now() - eligibilityStarted
    facts.candidateEligibility = eligibility
    const eligibleConfig = { ...config, candidates: eligibility.eligibleCandidates }
    if (eligibility.eligibleCandidates.length === 0
      || (held !== undefined && !eligibility.eligibleCandidates.some(candidate => candidate.id === held.candidateId))) {
      // Every configured candidate is the manual route itself: routing is on and
      // can change nothing, which the routing UI reports as its idle state.
      if (held === undefined && eligibility.assessments.every(assessment => assessment.reason === 'equals-base')) {
        return keep('candidate-equals-base')
      }
      if (held === undefined && eligibility.assessments.some(assessment => assessment.reason === 'thinking-mode-incompatible')) {
        return keep('thinking-mode-incompatible')
      }
      return {
        ...keep('candidate-ineligible'),
        sticky: { active: false, stepsElapsed: 0, ...held === undefined ? {} : { brokenBy: 'candidate-ineligible' as const } },
      }
    }
    const difficultyInstructions = config.difficultyInstructions
    const questions: JudgmentQuestion[] = [
      routeQuestion(eligibleConfig, base),
      ...difficultyInstructions === undefined ? [] : [difficultyQuestion(config, difficultyInstructions)],
    ]
    facts.judgmentQuestions = questions
    /**
     * One failed judgment call. A held streak keeps its candidate while the
     * consecutive failures before this one are below the hold tolerance.
     */
    const judgmentFailed = (
      reason: 'engine-unavailable' | 'invalid-answer',
      appliesPolicy: boolean,
      failures: ModelRoutingJudgmentFailures | undefined,
      code?: ModelRoutingEngineFailure['code'],
      engineState?: ModelRoutingEngineFailure['engineState'],
    ): ModelRoutingDecision => {
      const engineFailure = code === undefined
        ? {}
        : { engineFailure: { code, ...engineState === undefined ? {} : { engineState } } }
      // A warming engine has not failed: it holds a streak without spending the tolerance.
      if (held !== undefined && (engineState !== undefined
        || (failures?.count ?? 0) < config.judgmentFailures.holdTolerance)) {
        return {
          outcome: 'downgraded',
          reason: 'judgment-failure-held',
          stateHash: observed.hash,
          stateSeqs: observed.seqs,
          selection: held,
          ...facts,
          ...engineFailure,
          sticky: {
            active: true,
            routeErrorLimit: config.maxRouteErrors,
            stepsElapsed: sticky.stepsElapsed,
            ...heldEntry(sticky),
            entryBase: entryBaseOf(sticky, base),
          },
        }
      }
      if (appliesPolicy && config.onUnavailable === 'error') {
        return {
          outcome: 'error',
          reason: 'judgment-error',
          stateHash: observed.hash,
          stateSeqs: observed.seqs,
          ...facts,
          ...engineFailure,
          sticky: { active: false, stepsElapsed: 0 },
        }
      }
      return { ...keep(reason), ...engineFailure }
    }
    // From here to the ask nothing awaits: the dispatcher reads its selection
    // when the ask is called, so this snapshot names the engine that answers.
    engine = this.ctx.get('judgment')
    if (engine === undefined) return keep('engine-absent')
    if (!judgmentEnabled(engine.settings)) return keep('engine-disabled')
    snapshot = this.engineSnapshot(engine, config, sticky)
    const asked = snapshot
    const fitting = engine.fittingFor(consumer)
    if (breakerOpen(asked.failures)) return withEngine(keep('breaker-open'), asked)
    if (asked.refused) return withEngine(keep('engine-uncalibrated'), asked)
    if (asked.engineId !== undefined) facts.engineId = asked.engineId
    // An engine that is still starting or not yet installed cannot answer: the
    // call is not made and the fold does not count it as a failure.
    if (asked.warming !== undefined) {
      return judgmentFailed('engine-unavailable', true, asked.failures, 'UNAVAILABLE', asked.warming)
    }
    // The deadline aborts the call alone: the turn's own signal still cancels
    // the turn, and an answer arriving after the deadline is not used.
    const deadline = AbortSignal.timeout(config.judgmentDeadlineMs)
    const askSignal = AbortSignal.any([signal, deadline])
    const states = fitting === undefined ? [state.text] : state.alternatives.map(candidate => candidate.text)
    facts.inputChars = states.reduce((total, text) => total + text.length, 0)
    const askStarted = Date.now()
    let result: JudgmentResult
    try {
      if (fitting === undefined) {
        result = await engine.ask({ state: state.text, questions, tier: config.tier, signal: askSignal, consumer })
      } else {
        const fitted = await fitting.ask({ states, questions, tier: config.tier, signal: askSignal, consumer })
        signal.throwIfAborted()
        if (fitted.kind === 'unfit') {
          facts.judgmentRejection = { limits: fitted.limits, reason: fitted.reason }
          facts.engine = fitted.engine
          facts.model = fitted.model
          if (fitted.engineId !== undefined) facts.engineId = fitted.engineId
          facts.latencyMs = Date.now() - askStarted
          return keep('judgment-input-too-large')
        }
        // Providers validate the selected index against the exact outbound candidates.
        const selected = state.alternatives[fitted.fit.selectedIndex] as RoutingStateCandidate
        observed = { ...state, ...selected, text: fitted.fit.state, hash: stateHash(fitted.fit.state) }
        facts.judgmentInput = fitted.fit
        facts.stateProjection = {
          renderer: 'conversation-v1',
          contextTurns: config.state.contextTurns,
          maxChars: config.state.maxChars,
          omittedSeqs: selected.omittedSeqs,
        }
        result = fitted.result
      }
    } catch (error: unknown) {
      signal.throwIfAborted()
      // A failed call still ran: record where it went and how long it took.
      facts.latencyMs = Date.now() - askStarted
      // The failure is judged against the engine that produced it, with its
      // status as it reads now: an engine that began restarting is warming up.
      const stamped = error instanceof JudgmentError ? error.engineId : undefined
      const failed = this.engineSnapshot(engine, config, sticky, stamped ?? asked.engineId)
      if (failed.engineId !== undefined) facts.engineId = failed.engineId
      // A coded failure is classified by its code, whenever it arrives; only a
      // cancellation or an uncoded failure after the deadline is the deadline.
      const code = error instanceof JudgmentError ? error.code : undefined
      if (code === 'INPUT_TOO_LARGE') return keep('judgment-input-too-large')
      if (code === 'INVALID_ANSWER') return judgmentFailed('invalid-answer', true, failed.failures, code)
      if (code === 'UNAVAILABLE' || code === 'UNCONFIGURED') {
        return judgmentFailed('engine-unavailable', true, failed.failures, code, failed.warming)
      }
      if (deadline.aborted) return judgmentFailed('engine-unavailable', true, failed.failures, 'DEADLINE', failed.warming)
      if (code === 'ABORTED') throw error
      return judgmentFailed('engine-unavailable', true, failed.failures)
    }
    facts.engine = result.engine
    facts.model = result.model
    facts.latencyMs = result.latencyMs
    if (result.engineId !== undefined) facts.engineId = result.engineId
    if (result.usage !== undefined) facts.judgeUsage = result.usage
    // The answer is judged against the engine that gave it. An engine the
    // router refuses never gates, even when it answered: its call is billed and
    // recorded, and its answer is discarded.
    const answering = result.engineId === undefined || result.engineId === asked.engineId
      ? asked
      : this.engineSnapshot(engine, config, sticky, result.engineId)
    if (answering.refused) return withEngine(keep('engine-uncalibrated'), answering)
    // A late answer was billed but is not used.
    if (deadline.aborted) return judgmentFailed('engine-unavailable', true, answering.failures, 'DEADLINE')
    const thresholds = answering.thresholds
    const route = result.answers.find((answer): answer is JudgmentChoiceAnswer =>
      answer.kind === 'choice' && answer.id === ROUTE_QUESTION_ID)
    const score = result.answers.find((answer): answer is JudgmentScoreAnswer =>
      answer.kind === 'score' && answer.id === DIFFICULTY_QUESTION_ID)
    if (route === undefined || (difficultyInstructions !== undefined && score === undefined)) {
      return judgmentFailed('invalid-answer', false, answering.failures)
    }
    const routeAnswer = { choice: route.option, confidence: route.confidence, probabilities: { ...route.probabilities } }
    const difficulty = score === undefined ? undefined : { score: score.score, confidence: score.confidence }
    const answered = {
      ...facts,
      route: routeAnswer,
      ...difficulty === undefined ? {} : { difficulty },
      thresholds,
    }
    // Entry and exit use different thresholds: a score in between holds a
    // streak but does not enter one.
    const ceiling = held === undefined ? config.entryScoreCeiling : config.escalateBackScoreThreshold
    if (difficulty !== undefined && difficulty.score >= ceiling) {
      return {
        outcome: 'kept-strong',
        reason: held === undefined ? 'difficulty-too-high' : 'escalated',
        stateHash: observed.hash,
        stateSeqs: observed.seqs,
        ...answered,
        ...hintFor(config, difficulty),
        sticky: { active: false, stepsElapsed: 0, ...held === undefined ? {} : { brokenBy: 'escalated' } },
      }
    }
    // The question omits the manual route's own allowlist entries, so an answer
    // naming one chose the current model: it must end a held streak here rather
    // than fail the gate and fall into `sticky-hold`.
    const namesBase = eligibility.assessments.some(assessment =>
      assessment.reason === 'equals-base' && assessment.id === route.option)
    if (route.option === KEEP_CURRENT_OPTION_ID || namesBase) {
      return {
        outcome: 'kept-strong',
        reason: 'current-preferred',
        stateHash: observed.hash,
        stateSeqs: observed.seqs,
        ...answered,
        ...hintFor(config, difficulty),
        sticky: { active: false, stepsElapsed: 0, ...held === undefined ? {} : { brokenBy: 'current-preferred' } },
      }
    }
    const verdict = gate({ ...eligibleConfig, ...thresholds }, routeAnswer)
    const picked = verdict.ok
      ? { ok: true as const, selection: candidateSelection(verdict.candidate, config, difficulty, held) }
      : verdict
    // A different candidate or a different effort is a candidate change: below
    // the horizon the held selection stands, and inside the difficulty band a
    // change is an entry the band refuses.
    const continuing = held !== undefined && picked.ok && sameSelection(held, picked.selection)
    const bandRefused = picked.ok && !continuing && difficulty !== undefined
      && difficulty.score >= config.entryScoreCeiling
    if (held !== undefined && (bandRefused || (sticky.stepsElapsed < config.hold.minSteps && !continuing))) {
      return {
        outcome: 'downgraded',
        reason: 'sticky-hold',
        stateHash: observed.hash,
        stateSeqs: observed.seqs,
        selection: held,
        ...answered,
        sticky: {
          active: true,
          routeErrorLimit: config.maxRouteErrors,
          stepsElapsed: sticky.stepsElapsed,
          ...heldEntry(sticky),
          entryBase: entryBaseOf(sticky, base),
        },
      }
    }
    if (picked.ok) {
      return {
        outcome: 'downgraded',
        reason: 'gate-passed',
        stateHash: observed.hash,
        stateSeqs: observed.seqs,
        selection: picked.selection,
        ...answered,
        sticky: {
          active: true,
          routeErrorLimit: config.maxRouteErrors,
          stepsElapsed: continuing ? sticky.stepsElapsed : 0,
          ...continuing ? heldEntry(sticky) : { enteredTurn: turn, enteredStep: step },
          entryBase: entryBaseOf(sticky, base),
        },
      }
    }
    if (held !== undefined) {
      return {
        outcome: 'kept-strong',
        reason: 'gate-failed',
        stateHash: observed.hash,
        stateSeqs: observed.seqs,
        ...answered,
        sticky: { active: false, stepsElapsed: 0, brokenBy: 'gate-failed' },
      }
    }
    return {
      outcome: 'kept-strong',
      reason: picked.reason,
      stateHash: observed.hash,
      stateSeqs: observed.seqs,
      ...answered,
      ...hintFor(config, difficulty),
      sticky: { active: false, stepsElapsed: 0 },
    }
  }

  /** Render the current conversation projection within the configured character budget. */
  private buildState(session: Session, config: ResolvedModelRouterConfig): RoutingState {
    const alternatives = buildRoutingStateCandidates(session, config.state)
    const state = alternatives[0]
    return {
      ...state,
      alternatives,
      inputKey: JSON.stringify(alternatives.map(candidate => candidate.text)),
      hash: stateHash(state.text),
    }
  }

  /** Append one decision to the session log. */
  private log(session: Session, decision: ModelRoutingDecision): void {
    session.append('model-routing/decision', decision)
  }

  /** Render the `/route` command's result. */
  private runCommand(agent: Agent, rawInput: string): { kind: 'success'; text: string } {
    const args = rawInput.trim()
    const config = this.config()
    this.adoptIfReachable(agent)
    if (this.unreachable.has(agent)) {
      return { kind: 'success', text: 'Routing can\'t run for this agent: it has no model-selection hook.' }
    }
    if (args === '' || args === 'status') {
      const { active, pending } = this.get(agent)
      const sticky = stickyState(agent.session.events)
      const state = active ? 'Routing is on.' : 'Routing is off.'
      const queued = pending === undefined ? '' : ' A change applies from the next step.'
      const held = sticky.active && sticky.candidate !== undefined
        ? ` Holding ${sticky.candidate.provider}/${sticky.candidate.model} for step ${sticky.stepsElapsed + 1} of at least ${config.hold.minSteps} and at most ${config.hold.maxSteps}.`
        : ''
      return { kind: 'success', text: `${state}${queued}${held}` }
    }
    const wanted = args === 'on' ? true : args === 'off' ? false : undefined
    if (wanted === undefined) return { kind: 'success', text: 'Usage: /route [on|off]' }
    switch (this.set(agent, wanted)) {
      case 'committed':
        return { kind: 'success', text: wanted ? 'Model routing on.' : 'Model routing off.' }
      case 'queued':
        return {
          kind: 'success',
          text: wanted
            ? 'Enabling model routing (applies from the next step).'
            : 'Disabling model routing (applies from the next step).',
        }
      case 'cancelled':
        // The request reversed a pending selection and lands where the session
        // already is. The completed operation is \"a pending change was dropped\",
        // so the text names neither direction: which way it was going is visible
        // in the status line either way.
        return { kind: 'success', text: 'Model routing change cancelled.' }
      case 'noop':
        return { kind: 'success', text: wanted ? 'Model routing is already on.' : 'Model routing is already off.' }
    }
  }
}

/** One route answer's verdict: the allowlisted candidate it may select, or why it may not. */
type RouteVerdict =
  | { readonly ok: true; readonly candidate: ModelRoutingCandidate }
  | { readonly ok: false; readonly reason: ModelRoutingReason }

/**
 * Judge one route answer against the gate and the allowlist.
 *
 * The gate is two measured operating points, both required: the answer's own
 * confidence and its top-two margin. The allowlist is the enforcement point, so
 * a choice it does not contain is refused rather than trusted. `config` carries
 * only eligible candidates, and eligibility already excludes every candidate
 * naming the manual provider/model, so a selected candidate is always a change
 * of model.
 * @param config - resolved configuration carrying both thresholds and the eligible candidates.
 * @param route - the judgment's route answer.
 * @returns the candidate to select, or the reason it may not be.
 */
function gate(
  config: ResolvedModelRouterConfig,
  route: { choice: string; confidence: number; probabilities: Record<string, number> },
): RouteVerdict {
  if (route.confidence < config.downgradeThreshold) return { ok: false, reason: 'low-confidence' }
  if (routeMargin(route.probabilities) < config.downgradeMargin) return { ok: false, reason: 'thin-margin' }
  const candidate = config.candidates.find(entry => entry.id === route.choice)
  if (candidate === undefined) return { ok: false, reason: 'unknown-candidate' }
  return { ok: true, candidate }
}

/**
 * The route one passing answer selects, with its effort frozen for a streak.
 *
 * The difficulty lift is an entry-time choice. Re-affirming the held candidate
 * returns the held selection while its effort is still one the candidate can
 * enter at under the current configuration — its own configured effort or the
 * lift — so per-step difficulty answers never move effort inside a streak. A
 * configuration change that makes the held effort unreachable yields a fresh
 * entry selection, which the caller treats as a candidate change.
 * @param candidate - the eligible candidate the gate selected.
 * @param config - resolved configuration carrying the optional lift.
 * @param difficulty - this step's difficulty answer, used only at entry.
 * @param held - the selection the active streak holds, if any.
 * @returns the selection to record and run.
 */
function candidateSelection(
  candidate: ModelRoutingCandidate,
  config: ResolvedModelRouterConfig,
  difficulty: { score: number; confidence: number } | undefined,
  held: ModelRoutingSelection | undefined,
): ModelRoutingSelection {
  const lift = config.difficultyToEffort
  if (held !== undefined && held.candidateId === candidate.id) {
    const heldEffort = held.reasoningEffort === undefined ? undefined : String(held.reasoningEffort)
    const configured = candidate.reasoningEffort === undefined ? undefined : String(candidate.reasoningEffort)
    if (heldEffort === configured || (lift !== undefined && heldEffort === lift.reasoningEffort)) return held
  }
  const lifted = lift !== undefined && difficulty !== undefined && difficulty.score >= lift.scoreThreshold
    ? lift.reasoningEffort
    : undefined
  const effort = lifted ?? (candidate.reasoningEffort === undefined ? undefined : String(candidate.reasoningEffort))
  return {
    candidateId: candidate.id,
    provider: candidate.provider,
    model: candidate.model,
    ...effort === undefined ? {} : { reasoningEffort: toEffortId(effort) },
  }
}

/** Turn one selection into the route the loop runs. */
function selectionAsModel(selection: ModelRoutingSelection | undefined): ModelSelection | undefined {
  // Every downgraded decision this service logs carries a selection, so this
  // guard only satisfies the optional field's type; a durable log that somehow
  // lacked one falls back to the manual route.
  /* v8 ignore next -- written decisions always carry a selection */
  if (selection === undefined) return undefined
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
  }
}

/** The advisory hint a STRONG turn carries when the difficulty answer is high. */
function hintFor(
  config: ResolvedModelRouterConfig,
  difficulty: { score: number; confidence: number } | undefined,
): { hint?: 'consider-stronger' } {
  const threshold = config.hardHintScoreThreshold
  return threshold !== undefined && difficulty !== undefined && difficulty.score >= threshold
    ? { hint: 'consider-stronger' }
    : {}
}

/**
 * Whether an agent is a delegated child: its session header records a
 * delegation depth above zero. `parentSession` does not decide it, because a
 * user fork of a root session sets it too.
 * @param agent - the agent to classify.
 * @returns `true` for a subagent or Team seat, `false` for a root agent.
 */
function delegatedChild(agent: Agent): boolean {
  return (agent.session.header.delegationDepth ?? 0) > 0
}

/** The route question includes the manual model so the judgment can decline every downgrade. */
function routeQuestion(config: ResolvedModelRouterConfig, base: ModelSelection): JudgmentChoiceQuestion {
  return {
    kind: 'choice',
    id: ROUTE_QUESTION_ID,
    instructions: config.routeInstructions,
    options: [
      {
        option: KEEP_CURRENT_OPTION_ID,
        description: `Keep the current model (${routeDescription(base)}). Choose this when no downgrade candidate is suitable or the task is uncertain.`,
      },
      ...config.candidates.map(candidate => ({
        option: candidate.id,
        description: `Use ${routeDescription(candidate)}. ${candidate.description}`,
      })),
    ],
  }
}

/** Provider, model, and explicit effort shown to the judgment for one route. */
function routeDescription(route: ModelSelection | ModelRoutingCandidate): string {
  return `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : `, reasoning effort ${route.reasoningEffort}`}`
}

/** The mandatory score question a held downgrade needs. */
function difficultyQuestion(config: ResolvedModelRouterConfig, instructions: string): JudgmentScoreQuestion {
  return {
    kind: 'score',
    id: DIFFICULTY_QUESTION_ID,
    instructions,
    levels: [...config.difficultyLevels],
  }
}

export default ModelRoutingController
