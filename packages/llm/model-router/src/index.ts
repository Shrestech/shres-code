/**
 * Asymmetric, cache-sticky model routing.
 *
 * The manual/default selection is always the strong model; `candidates` is a
 * **downgrade allowlist**, so this service can select a member of that list or
 * nothing at all — never the manual route and never anything stronger. A
 * downgrade requires both `confidence >= downgradeThreshold` and
 * `top1 - top2 >= downgradeMargin`, above the measured wobble of a rented
 * classifier's borderline answers.
 *
 * A downgrade is then held as a **streak**: a model transition costs a prefix
 * re-prefill at production context sizes, so a downgrade has to persist several
 * turns to net positive. The streak lives in the log (`model-routing/decision`,
 * `model-routing/mode`, plus `request/header` and turn events) and is folded
 * purely by `stickyState`, so resume, fork, compaction, and a process restart
 * continue it exactly as the live consult left it. While downgraded the turn is
 * still judged — the difficulty question is then mandatory — so a turn that
 * turns hard escalates back immediately.
 *
 * The consult sits inside `installModelSelection` (`packages/core/agent`): after
 * the manual selection rewrote the request, `resolveRequest` may replace it.
 * One decision is taken per turn and reused by later steps and retries.
 *
 * Agent Note:
 * - .agents/notes/proposed/feature/2026-09-17-jev-judgment-routing-and-compaction.md
 *
 * @module @shres-code/shres-code-model-router
 */

import { Context, Service } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { Agent, ModelRoutingConsult, ModelSelection, PreStepDecision } from '@shres-code/shres-code-agent'
import { judgmentEnabled, judgmentQuestionId } from '@shres-code/shres-code-judgment'
import type {
  JudgmentChoiceAnswer,
  JudgmentChoiceQuestion,
  JudgmentQuestion,
  JudgmentScoreAnswer,
  JudgmentScoreQuestion,
} from '@shres-code/shres-code-judgment'
import type { Message } from '@shres-code/shres-code-llm'
import { ReasoningEffortId as toEffortId } from '@shres-code/shres-code-llm'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import { installSettingsSection, settingsNamespace } from '@shres-code/shres-code-settings'
// Type-only edges: resolve `ctx.commands` and `ctx.sessionProjections` for the optional children.
import type {} from '@shres-code/shres-code-commands'
import type {} from '@shres-code/shres-code-session-projection'
import {
  DEFAULT_ESCALATE_BACK_SCORE_THRESHOLD,
  DEFAULT_MAX_ROUTE_ERRORS,
  DEFAULT_MIN_TURNS_DOWNGRADED,
  DEFAULT_STATE_CONTEXT_TURNS,
  DEFAULT_STATE_MAX_CHARS,
  DEFAULT_DIFFICULTY_LEVELS,
  resolveConfig,
} from './config.ts'
import type { ModelRouterConfig, ResolvedModelRouterConfig } from './config.ts'
import { foldModelRouting, stickyState } from './folds.ts'
import type { ModelRoutingStickyState } from './folds.ts'
import type {
  ModelRoutingCandidate,
  ModelRoutingDecision,
  ModelRoutingEntryBaseView,
  ModelRoutingLastDecision,
  ModelRoutingProjection,
  ModelRoutingReason,
  ModelRoutingSelection,
  ModelRoutingSelectionView,
} from './types.ts'
// The `modelRouting` projection-key and session-event declarations live in
// src/types.ts (their one home); this re-export keeps the module edge in the
// emitted declarations so aggregate programs receive both merges.
export type * from './types.ts'
export {
  DEFAULT_DIFFICULTY_LEVELS,
  DEFAULT_ESCALATE_BACK_SCORE_THRESHOLD,
  DEFAULT_MAX_ROUTE_ERRORS,
  DEFAULT_MIN_TURNS_DOWNGRADED,
  DEFAULT_STATE_CONTEXT_TURNS,
  DEFAULT_STATE_MAX_CHARS,
  resolveConfig,
} from './config.ts'
export { foldModelRouting, stickyState } from './folds.ts'
export type { ModelRoutingStickyState } from './folds.ts'

/** Settings namespace carrying the deployment's routing configuration. */
export const MODEL_ROUTER_SETTINGS_NAMESPACE = settingsNamespace('model-router')

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

/** One assembled judgment state, with the surface seqs it came from. */
interface RoutingState {
  /** Assembled state text. */
  text: string
  /** Stable hash of that text. */
  hash: string
  /** Surface seqs the text was assembled from, in order. */
  seqs: number[]
}

/** The intra-turn pin: one decision per turn, reused by later steps and retries. */
interface PinnedDecision {
  /** Turn the decision belongs to. */
  turn: number
  /** The logged decision. */
  decision: ModelRoutingDecision
}

/** Projection unit state: the logged mode, an outstanding `/route` selection, the last decision, and the last entered streak base. */
interface ModelRoutingUnitState {
  active: boolean
  wanted: boolean | null
  turn: number
  last: ModelRoutingLastDecision | null
  stickyActive: boolean
  stickyEnteredTurn: number | null
  stickyCandidate: ModelRoutingSelectionView | null
  lastStrong: ModelRoutingEntryBaseView | null
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
    turnsElapsed: zod.number(),
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

/** Text blocks of one message, joined. */
function messageText(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
  }
  return parts.join('\n')
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
 * The top-two probability margin of one choice answer.
 * @param probabilities - the answer's distribution.
 * @returns the margin between the two highest probabilities.
 */
export function routeMargin(probabilities: Readonly<Record<string, number>>): number {
  let top1 = 0
  let top2 = 0
  for (const value of Object.values(probabilities)) {
    if (value > top1) {
      top2 = top1
      top1 = value
    } else if (value > top2) {
      top2 = value
    }
  }
  return top1 - top2
}

/**
 * `ctx.modelRouting`: owns the logged routing mode, the per-turn decision, and
 * the consult `installModelSelection` reaches. No live mirror of the mode is
 * kept — the log is the state — and beyond its two routing events it writes
 * nothing: no prompt, no tool, and no request of its own.
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
      description: z.string(),
    })).default([]),
    downgradeThreshold: z.number().min(0).max(1).required(),
    downgradeMargin: z.number().min(0).max(1).required(),
    minTurnsDowngraded: z.number().step(1).min(0).default(DEFAULT_MIN_TURNS_DOWNGRADED),
    routeInstructions: z.string().required(),
    difficultyInstructions: z.string(),
    difficultyLevels: z.array(z.string()).default([...DEFAULT_DIFFICULTY_LEVELS]),
    escalateBack: z.object({
      scoreThreshold: z.number().min(1).max(5).default(DEFAULT_ESCALATE_BACK_SCORE_THRESHOLD),
    }),
    maxRouteErrors: z.number().step(1).min(1).default(DEFAULT_MAX_ROUTE_ERRORS),
    onUnavailable: z.union(['fallback', 'error']).default('fallback'),
    // Both optional field groups are unions with `z.const(null)`: schemastery
    // materializes an absent bare object as `{}` (probe-verified), which would
    // make the router see a lift or a hint the deployment never wrote. The
    // union keeps an omitted key absent, and a valueless `difficultyToEffort:`
    // resolves to null — which resolveConfig reads as not configured.
    difficultyToEffort: z.union([z.const(null), z.object({
      scoreThreshold: z.number().min(1).max(5),
      reasoningEffort: z.string(),
    })]) as unknown as z<ModelRouterConfig['difficultyToEffort']>,
    hardHint: z.union([z.const(null), z.object({
      scoreThreshold: z.number().min(1).max(5).default(DEFAULT_ESCALATE_BACK_SCORE_THRESHOLD),
    })]) as unknown as z<ModelRouterConfig['hardHint']>,
    state: z.object({
      contextTurns: z.number().step(1).min(0).default(DEFAULT_STATE_CONTEXT_TURNS),
      maxChars: z.number().step(1).min(1).default(DEFAULT_STATE_MAX_CHARS),
    }),
    tier: z.union(['fast', 'accurate']).default('fast'),
    // The annotation is a cast because two fields are unions with `z.const(null)`
    // (see their comment above); the schema is still one inline `z.object` call,
    // which is what the config catalog walks.
  }) as z<ModelRouterConfig>

  private source: () => ModelRouterConfig
  private lastRaw: ModelRouterConfig | undefined
  private lastGood: ResolvedModelRouterConfig | undefined
  private readonly pins = new WeakMap<Session, PinnedDecision>()
  private readonly pendingIntents = new WeakMap<Session, boolean>()

  /**
   * @param ctx - the context this service registers `ctx.modelRouting` on.
   * @param config - composition config; the settings user layer merges over it.
   */
  constructor(ctx: Context, config: ModelRouterConfig) {
    super(ctx, 'modelRouting')
    this.source = () => config
    this.config()
    // A pending mode selection is committed at the next accepted in-turn
    // pre-step, so the change lands with the request assembly it belongs to
    // rather than mid-step.
    ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      const wanted = this.pendingIntents.get(agent.session)
      if (wanted === undefined || decision.kind === 'reject' || signal.aborted) return decision
      this.commitMode(agent.session, wanted)
      return decision
    })
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register<'modelRouting', ModelRoutingUnitState>({
        key: 'modelRouting',
        schema: modelRoutingProjectionSchema,
        init: () => ({
          active: false,
          wanted: null,
          turn: 0,
          last: null,
          stickyActive: false,
          stickyEnteredTurn: null,
          stickyCandidate: null,
          lastStrong: null,
        }),
        apply: (state, event) => {
          switch (event.type) {
            case 'command/run':
              if (event.data.name !== ROUTE_COMMAND || event.data.args === undefined) return state
              return { ...state, wanted: event.data.args.trim() !== 'off' }
            case 'model-routing/mode':
              return { ...state, active: event.data.active, wanted: null }
            case 'turn/start':
              return { ...state, turn: event.data.turn }
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
                last,
                stickyActive: data.sticky.active,
                stickyEnteredTurn: data.sticky.active ? (data.sticky.enteredTurn ?? state.turn) : null,
                stickyCandidate: data.sticky.active && data.selection !== undefined ? selectionView(data.selection) : null,
                // Only an active record carries a base, so the retained route
                // outlives the streak: ending one reports nothing itself.
                lastStrong: data.sticky.entryBase ?? state.lastStrong,
              }
            }
            default:
              return state
          }
        },
        view: state => ({
          active: state.active,
          pending: state.wanted !== null && state.wanted !== state.active,
          ...state.last === null ? {} : { last: state.last },
          ...state.lastStrong === null ? {} : { lastStrong: state.lastStrong },
          sticky: {
            active: state.stickyActive,
            turnsElapsed: state.stickyActive && state.stickyEnteredTurn !== null
              ? Math.max(0, state.turn - state.stickyEnteredTurn)
              : 0,
            ...state.stickyCandidate === null ? {} : { selection: state.stickyCandidate },
          },
        }),
        // Version 2 adds the retained entry base to the unit state.
        stateVersion: 2,
      })
    })
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
        // Nothing is derived from the configuration at registration: every
        // decision re-resolves it, so a committed change reaches the next turn.
      },
    })
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
   * Read the logged mode and any selection awaiting the next accepted pre-step.
   * @param agent - the agent to read.
   * @returns the mode in force plus a pending selection, when present.
   */
  get(agent: Agent): { active: boolean; pending?: boolean } {
    const active = this.modeOf(agent.session)
    const pending = this.pendingIntents.get(agent.session)
    return pending === undefined ? { active } : { active, pending }
  }

  /**
   * The mode in force on one session: the last logged `model-routing/mode`
   * wins, and a log with none starts from the configured `initialMode`.
   * @param session - the session to read.
   * @param end - fold the first `end` events; defaults to the whole log.
   * @returns whether routing is active.
   */
  modeOf(session: Session, end: number = session.events.length): boolean {
    return foldModelRouting(session.events, end, this.config().initialMode === 'on')
  }

  /**
   * Switch routing on or off. Between turns the change is appended
   * immediately; during an open turn it waits for the next accepted in-turn
   * pre-step, like every other logged mode in this harness.
   * @param agent - the agent to switch.
   * @param active - whether routing should be active.
   * @returns what happened: `committed`, `queued`, `cancelled`, or `noop`.
   */
  set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop' {
    const session = agent.session
    const pending = this.pendingIntents.get(session)
    const target = pending ?? this.modeOf(session)
    if (active === target) return 'noop'
    if (hasOpenTurn(session.events)) {
      this.pendingIntents.set(session, active)
      return this.modeOf(session) === active ? 'cancelled' : 'queued'
    }
    const logged = this.modeOf(session)
    if (logged === active) {
      this.pendingIntents.delete(session)
      return 'cancelled'
    }
    session.append('model-routing/mode', { active })
    this.pendingIntents.delete(session)
    return 'committed'
  }

  /** Append one pending selection before the next request assembly. */
  private commitMode(session: Session, active: boolean): void {
    if (active === this.modeOf(session)) {
      this.pendingIntents.delete(session)
      return
    }
    session.append('model-routing/mode', { active })
    // Delete only after the append succeeds so a later accepted pre-step can
    // retry a failed durable write.
    this.pendingIntents.delete(session)
  }

  /**
   * Resolve the route one turn should run. Called by
   * `installModelSelection` after the manual selection rewrote the request: a
   * non-undefined result replaces provider/model/effort, and `undefined` leaves
   * the manual route in force.
   *
   * One decision per turn: later steps of the same turn and same-turn request
   * retries reuse the pinned decision instead of judging again.
   * @param agent - the agent whose turn is being prepared.
   * @param turn - the turn number, as the loop dispatched it.
   * @param _step - the step number within that turn; underscore-prefixed because
   *   the pin is keyed by turn, so the decision is taken once and later steps
   *   reuse it.
   * @param base - the route the manual selection left in force.
   * @param signal - the request's cancellation signal.
   * @returns the route to run, or `undefined` to keep the manual route.
   */
  async resolveRequest(
    agent: Agent,
    turn: number,
    _step: number,
    base: ModelSelection,
    signal: AbortSignal,
  ): Promise<ModelSelection | undefined> {
    const session = agent.session
    const active = this.modeOf(session)
    const pinned = this.pins.get(session)
    if (pinned !== undefined && pinned.turn === turn) {
      if (active) {
        return pinned.decision.outcome === 'downgraded'
          ? selectionAsModel(pinned.decision.selection)
          : undefined
      }
      // The mode went off under a turn that had already been judged: record the
      // skip once, then stop applying the decision.
      this.pins.delete(session)
      this.log(session, {
        outcome: 'skipped',
        reason: 'mode-off',
        stateHash: pinned.decision.stateHash,
        stateSeqs: pinned.decision.stateSeqs,
        sticky: { active: false, turnsElapsed: 0 },
      })
      return undefined
    }
    if (!active) {
      // Off is off: no judgment, no decision event, no request rewrite. This is
      // what keeps a composed-but-off run byte-identical to one without the
      // package.
      return undefined
    }
    const config = this.config()
    const state = this.buildState(session, config)
    const sticky = stickyState(session.events, config)
    const decision = await this.decide(config, state, sticky, base, turn, signal)
    this.log(session, decision)
    this.pins.set(session, { turn, decision })
    return decision.outcome === 'downgraded' ? selectionAsModel(decision.selection) : undefined
  }

  /**
   * Report the manual selection a held downgrade descends beneath.
   *
   * A held streak rewrites the consumed `request/header` to the candidate, so
   * that header stops reporting the route the session is pointed at; a reader
   * asking for the session's selection asks this first. The answer is the same
   * fold the consult reads — no live mirror — and the effort is the one the
   * streak was entered on, because that is what the manual route still runs at.
   * @param agent - the agent whose selection is being read.
   * @returns the route the held streak was entered on, or `undefined` while the
   *   state is strong, where the last logged header already is that route.
   */
  stickySelection(agent: Agent): ModelSelection | undefined {
    const sticky = stickyState(agent.session.events, this.config())
    if (!sticky.active) return undefined
    const base = sticky.entryBase
    // A state with no base is one this consult never produced — a replayed
    // decision from a log whose entering turn recorded none — and it reports
    // nothing rather than inventing the candidate it holds.
    if (base === undefined) return undefined
    return {
      provider: base.provider,
      model: base.model,
      ...base.reasoningEffort === undefined ? {} : { reasoningEffort: toEffortId(base.reasoningEffort) },
    }
  }

  /**
   * Judge one turn and resolve it against the allowlist and the sticky state.
   * @param config - resolved configuration.
   * @param state - the assembled state.
   * @param sticky - the sticky state before this decision.
   * @param base - the manual route in force.
   * @param turn - the turn being judged.
   * @param signal - cancellation signal forwarded to the judgment call.
   * @returns the decision to log.
   */
  private async decide(
    config: ResolvedModelRouterConfig,
    state: RoutingState,
    sticky: ModelRoutingStickyState,
    base: ModelSelection,
    turn: number,
    signal: AbortSignal,
  ): Promise<ModelRoutingDecision> {
    const held = sticky.active ? sticky.candidate : undefined
    /** One fallback: the manual route stands, with the class that kept it. */
    const keep = (reason: ModelRoutingReason): ModelRoutingDecision => ({
      outcome: 'kept-strong',
      reason,
      stateHash: state.hash,
      stateSeqs: state.seqs,
      sticky: { active: false, turnsElapsed: 0 },
    })
    // The allowlist is the enforcement point: with nothing on it nothing may be
    // downgraded to, and no judgment call is worth making.
    if (config.candidates.length === 0) return keep('no-candidates')
    if (held !== undefined && sticky.entryBase !== undefined
      && (sticky.entryBase.provider !== base.provider || sticky.entryBase.model !== base.model)) {
      // Manual authority wins immediately: only the provider/model comparison
      // counts, so an unrelated header change never ends a streak.
      return {
        outcome: 'kept-strong',
        reason: 'manual-deviation',
        stateHash: state.hash,
        stateSeqs: state.seqs,
        sticky: { active: false, turnsElapsed: 0, brokenBy: 'manual-deviation' },
      }
    }
    const engine = this.ctx.get('judgment')
    if (engine === undefined) return keep('engine-absent')
    if (!judgmentEnabled(engine.settings)) return keep('engine-disabled')
    const difficultyInstructions = config.difficultyInstructions
    const questions: JudgmentQuestion[] = [
      routeQuestion(config),
      ...difficultyInstructions === undefined ? [] : [difficultyQuestion(config, difficultyInstructions)],
    ]
    let result
    try {
      result = await engine.ask({
        state: state.text,
        questions,
        tier: config.tier,
        signal,
      })
    } catch (error: unknown) {
      if (config.onUnavailable === 'error') {
        return {
          outcome: 'error',
          reason: 'judgment-error',
          stateHash: state.hash,
          stateSeqs: state.seqs,
          sticky: { active: sticky.active, turnsElapsed: sticky.turnsElapsed },
        }
      }
      const code = (error as { code?: unknown } | null)?.code
      return keep(code === 'INVALID_ANSWER' ? 'invalid-answer' : 'engine-unavailable')
    }
    const route = result.answers.find((answer): answer is JudgmentChoiceAnswer => answer.kind === 'choice')
    const score = result.answers.find((answer): answer is JudgmentScoreAnswer => answer.kind === 'score')
    if (route === undefined) return keep('invalid-answer')
    const routeAnswer = { choice: route.option, confidence: route.confidence, probabilities: { ...route.probabilities } }
    const difficulty = score === undefined ? undefined : { score: score.score, confidence: score.confidence }
    const answered = {
      route: routeAnswer,
      ...difficulty === undefined ? {} : { difficulty },
      engine: result.engine,
      model: result.model,
      latencyMs: result.latencyMs,
    }
    // While downgraded, a hard turn escalates back at any elapsed count: a
    // sticky session never runs blind.
    if (held !== undefined && difficulty !== undefined && difficulty.score >= config.escalateBackScoreThreshold) {
      return {
        outcome: 'kept-strong',
        reason: 'escalated',
        stateHash: state.hash,
        stateSeqs: state.seqs,
        ...answered,
        sticky: { active: false, turnsElapsed: 0, brokenBy: 'escalated' },
      }
    }
    const verdict = gate(config, routeAnswer, base)
    if (verdict.ok) {
      const selection = candidateSelection(verdict.candidate, config, difficulty)
      return {
        outcome: 'downgraded',
        reason: 'gate-passed',
        stateHash: state.hash,
        stateSeqs: state.seqs,
        selection,
        ...answered,
        sticky: {
          active: true,
          turnsElapsed: sticky.active ? sticky.turnsElapsed : 0,
          enteredTurn: sticky.active && sticky.enteredTurn !== undefined ? sticky.enteredTurn : turn,
          entryBase: entryBaseOf(sticky, base),
        },
      }
    }
    const failed = verdict.reason
    // A held streak survives a failed gate until its horizon; after the horizon
    // the failed gate ends it and the manual route returns.
    if (held !== undefined) {
      if (sticky.turnsElapsed < config.minTurnsDowngraded) {
        return {
          outcome: 'downgraded',
          reason: 'sticky-hold',
          stateHash: state.hash,
          stateSeqs: state.seqs,
          selection: held,
          ...answered,
          sticky: {
            active: true,
            turnsElapsed: sticky.turnsElapsed,
            // An active streak always carries enteredTurn, so this guard only
            // satisfies the optional field's type.
            /* v8 ignore next -- active streaks always carry enteredTurn */
            ...sticky.enteredTurn === undefined ? {} : { enteredTurn: sticky.enteredTurn },
            entryBase: entryBaseOf(sticky, base),
          },
        }
      }
      return {
        outcome: 'kept-strong',
        reason: 'gate-failed',
        stateHash: state.hash,
        stateSeqs: state.seqs,
        ...answered,
        sticky: { active: false, turnsElapsed: 0, brokenBy: 'gate-failed' },
      }
    }
    return {
      outcome: 'kept-strong',
      reason: failed,
      stateHash: state.hash,
      stateSeqs: state.seqs,
      ...answered,
      ...hintFor(config, difficulty),
      sticky: { active: false, turnsElapsed: 0 },
    }
  }

  /** Assemble the judgment state: the turn's user message plus prior context, capped. */
  private buildState(session: Session, config: ResolvedModelRouterConfig): RoutingState {
    const wanted = config.state.contextTurns + 1
    const picked: Array<{ seq: number; text: string }> = []
    for (const event of session.events) {
      if (event.type !== 'user/message') continue
      const text = messageText(event.data)
      if (text.length === 0) continue
      picked.push({ seq: event.seq, text })
    }
    const recent = picked.slice(Math.max(0, picked.length - wanted))
    let text = recent.map(entry => entry.text).join('\n\n')
    if (text.length > config.state.maxChars) text = text.slice(text.length - config.state.maxChars)
    return { text, hash: stateHash(text), seqs: recent.map(entry => entry.seq) }
  }

  /** Append one decision to the session log. */
  private log(session: Session, decision: ModelRoutingDecision): void {
    session.append('model-routing/decision', decision)
  }

  /** Render the `/route` command's result. */
  private runCommand(agent: Agent, rawInput: string): { kind: 'success'; text: string } {
    const args = rawInput.trim()
    const config = this.config()
    if (args === '' || args === 'status') {
      const { active, pending } = this.get(agent)
      const sticky = stickyState(agent.session.events, config)
      const state = active ? 'Routing is on.' : 'Routing is off.'
      const queued = pending === undefined ? '' : ' A change applies from the next step.'
      const held = sticky.active && sticky.candidate !== undefined
        ? ` Holding ${sticky.candidate.provider}/${sticky.candidate.model} for turn ${sticky.turnsElapsed + 1} of at least ${config.minTurnsDowngraded}.`
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
 * a choice it does not contain is refused rather than trusted, and a candidate
 * equal to the route already in force is not a downgrade.
 * @param config - resolved configuration carrying both thresholds.
 * @param route - the judgment's route answer.
 * @param base - the manual route in force.
 * @returns the candidate to select, or the reason it may not be.
 */
function gate(
  config: ResolvedModelRouterConfig,
  route: { choice: string; confidence: number; probabilities: Record<string, number> },
  base: ModelSelection,
): RouteVerdict {
  if (route.confidence < config.downgradeThreshold) return { ok: false, reason: 'low-confidence' }
  if (routeMargin(route.probabilities) < config.downgradeMargin) return { ok: false, reason: 'thin-margin' }
  const candidate = config.candidates.find(entry => entry.id === route.choice)
  if (candidate === undefined) return { ok: false, reason: 'unknown-candidate' }
  if (candidate.provider === base.provider && candidate.model === base.model
    && (candidate.reasoningEffort ?? undefined) === (base.reasoningEffort ?? undefined)) {
    return { ok: false, reason: 'candidate-equals-base' }
  }
  return { ok: true, candidate }
}
function candidateSelection(
  candidate: ModelRoutingCandidate,
  config: ResolvedModelRouterConfig,
  difficulty: { score: number; confidence: number } | undefined,
): ModelRoutingSelection {
  const lift = config.difficultyToEffort
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

/** The choice question asking which allowlisted candidate should handle the turn. */
function routeQuestion(config: ResolvedModelRouterConfig): JudgmentChoiceQuestion {
  return {
    kind: 'choice',
    id: ROUTE_QUESTION_ID,
    instructions: config.routeInstructions,
    options: config.candidates.map(candidate => ({
      option: candidate.id,
      ...candidate.description === undefined ? {} : { description: candidate.description },
    })),
  }
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
