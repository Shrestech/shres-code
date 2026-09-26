/**
 * Shared consult-input producer. Live `decide()` calls {@link consultInputFrom}
 * with the live log and request messages. Offline replay slices first.
 *
 * @module @shres-code/shres-code-model-router/replay
 */

import type { ModelSelection } from '@shres-code/shres-code-agent'
import type { LlmCallConfig, LlmRuntime, Message } from '@shres-code/shres-code-llm'
import type { JudgmentQuestion } from '@shres-code/shres-code-judgment'
import { deriveEventMessage, foldSurface } from '@shres-code/shres-code-session'
import type { SessionEvent } from '@shres-code/shres-code-session'
import type { ResolvedModelRouterConfig } from './config.ts'
import { KEEP_CURRENT_OPTION_ID } from './config.ts'
import { assessModelRoutingCandidates } from './eligibility.ts'
import type { ModelRoutingCacheTtl } from './folds.ts'
import { coldPointAt, foldModelRouting, stickyState } from './folds.ts'
import { DIFFICULTY_QUESTION_ID, ROUTE_QUESTION_ID } from './question-ids.ts'
import { buildRoutingStateCandidatesFromEvents } from './state.ts'
import type {
  ModelRoutingCacheTtlView,
  ModelRoutingCandidateEligibility,
  ModelRoutingColdPoint,
} from './types.ts'

/** Clock and coordinates of one consult. `seedLength` is present even when undefined. */
export interface ReplayConsultAt {
  readonly turn: number
  readonly step: number
  readonly now: number
  readonly seedLength: number | undefined
}

/** Prompt-cache lifetime facts one consult records. */
export interface ReplayConsultCache {
  readonly base: ModelRoutingCacheTtlView
}

/** Quota warm-prefix: no eligibility, no questions, no engine lookup beyond TTL. */
export interface ReplayConsultWarm {
  readonly kind: 'warm'
  readonly coldPoint: undefined
  readonly cache: ReplayConsultCache
}

/** Path that cannot ask: eligibility is present, questions are not. */
export interface ReplayConsultIneligible {
  readonly kind: 'ineligible'
  readonly coldPoint: ModelRoutingColdPoint | null
  readonly cache: ReplayConsultCache
  readonly eligibility: ModelRoutingCandidateEligibility
}

/** Path that would ask: states, questions, and consultKey. */
export interface ReplayConsultAsk {
  readonly kind: 'ask'
  readonly coldPoint: ModelRoutingColdPoint | null
  readonly cache: ReplayConsultCache
  readonly eligibility: ModelRoutingCandidateEligibility
  readonly states: readonly string[]
  readonly questions: readonly JudgmentQuestion[]
  readonly consultKey: string
}

/** Shared producer result: warm-prefix, ineligible, or ask. */
export type ReplayConsultInput = ReplayConsultWarm | ReplayConsultIneligible | ReplayConsultAsk

/** Replay-only refusal from {@link consultPrefix} or {@link replayConsultInput}. */
export class ReplayConsultError extends Error {
  /** Stable refusal class the wrapper throws. */
  readonly code: 'missing-step' | 'held-streak' | 'reentry-cooldown' | 'mixed-route' | 'mode-off'
  constructor(code: ReplayConsultError['code'], message: string) {
    super(message)
    this.name = 'ReplayConsultError'
    this.code = code
  }
}

/**
 * How the shared producer obtains the manual base's prompt-cache lifetime and
 * `cache.base`. Internal; live and replay each pass an explicit kind.
 */
export type ConsultCachePolicy =
  | { readonly kind: 'live-given'; readonly ttl: ModelRoutingCacheTtl }
  | { readonly kind: 'live-eligibility' }
  | { readonly kind: 'replay-resolve' }

/** Composed model lookup and preparation used by one consult. */
type ConsultRuntime = Pick<LlmRuntime, 'resolveModelInfo' | 'prepareCall'>

/** Inputs the shared producer reads. Live and replay supply the composed runtime. */
export interface ConsultInputSource {
  readonly config: ResolvedModelRouterConfig
  readonly prefix: readonly SessionEvent[]
  readonly messages: readonly Message[]
  readonly requestConfig: LlmCallConfig
  readonly routeBase: ModelSelection
  readonly coldPointBase: ModelSelection
  readonly at: ReplayConsultAt
  /** Metadata and preparation share the same provider registrations. */
  readonly runtime: ConsultRuntime
  readonly signal?: AbortSignal
  /** Required TTL / cache.base policy; no default. */
  readonly cachePolicy: ConsultCachePolicy
}

/**
 * Events that precede the router consult of `turn`/`step`: through that
 * step's `step/start` and claimed user messages, excluding this request's
 * `agent/route-base`, `request/header`, `model-routing/decision`, and
 * `assistant/*` for the same step.
 * @param events - the session log to slice.
 * @param turn - consult turn.
 * @param step - consult step.
 * @returns the prefix through that step's `step/start` and claimed user messages.
 */
export function consultPrefix(events: readonly SessionEvent[], turn: number, step: number): readonly SessionEvent[] {
  let startSeq: number | undefined
  for (const event of events) {
    if (event.type === 'step/start' && event.data.turn === turn && event.data.step === step) {
      startSeq = event.seq
      break
    }
  }
  if (startSeq === undefined) {
    throw new ReplayConsultError(
      'missing-step',
      `consultPrefix: no step/start for turn ${String(turn)} step ${String(step)}`,
    )
  }
  const out: SessionEvent[] = []
  for (const event of events) {
    if (event.seq < startSeq) {
      out.push(event)
      continue
    }
    if (event.seq === startSeq) {
      out.push(event)
      continue
    }
    if (event.type === 'turn/start' || event.type === 'step/start') break
    if (event.type === 'agent/route-base'
      || event.type === 'request/header'
      || event.type === 'model-routing/decision'
      || event.type === 'model-routing/child-decision'
      || event.type === 'assistant/chunk'
      || event.type === 'assistant/message') {
      break
    }
    out.push(event)
  }
  return out
}

function sameRoute(left: { provider: string; model: string }, right: { provider: string; model: string }): boolean {
  return left.provider === right.provider && left.model === right.model
}

function conversationRoute(events: readonly SessionEvent[]): { provider: string; model: string } | undefined {
  let route: { provider: string; model: string } | undefined
  for (const event of events) {
    if (event.type !== 'request/header') continue
    const config = event.data.header.config
    const next = { provider: config.provider, model: config.model }
    if (route === undefined) route = next
    else if (!sameRoute(route, next)) {
      throw new ReplayConsultError('mixed-route', 'replayConsultInput refuses a log whose request headers name more than one route')
    }
  }
  return route
}

function derivedMessages(events: readonly SessionEvent[]): Message[] {
  const messages: Message[] = []
  for (const seq of foldSurface(events).nodes) {
    const event = events[seq]
    if (event === undefined) continue
    const message = deriveEventMessage(event)
    if (message !== null) messages.push(message)
  }
  return messages
}

function routeFromFor(config: ResolvedModelRouterConfig, base: ModelSelection) {
  return config.routeFrom.find(entry => entry.provider === base.provider && entry.model === base.model)
}

function routeDescription(route: { provider: string; model: string; reasoningEffort?: string }): string {
  return `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : `, reasoning effort ${route.reasoningEffort}`}`
}

function routeQuestion(config: ResolvedModelRouterConfig, base: ModelSelection): JudgmentQuestion {
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

function difficultyQuestion(config: ResolvedModelRouterConfig, instructions: string): JudgmentQuestion {
  return {
    kind: 'score',
    id: DIFFICULTY_QUESTION_ID,
    instructions,
    levels: [...config.difficultyLevels],
  }
}

async function cacheTtl(
  config: ResolvedModelRouterConfig,
  base: ModelSelection,
  runtime: ConsultRuntime,
  signal?: AbortSignal,
): Promise<ModelRoutingCacheTtl> {
  let declared: number | undefined
  try {
    declared = (await runtime.resolveModelInfo(base.provider, base.model, signal)).promptCacheTtlMs
  } catch {
    signal?.throwIfAborted()
  }
  return declared === undefined
    ? { ttlMs: config.coldPoints.unknownTtlMs, ttlSource: 'fallback' }
    : { ttlMs: declared, ttlSource: 'adapter' }
}

/** Report the manual base with the already-resolved cache lifetime. */
function cacheBaseFromTtl(routeBase: ModelSelection, ttl: ModelRoutingCacheTtl): ReplayConsultCache {
  return {
    base: { provider: routeBase.provider, model: routeBase.model, ttlMs: ttl.ttlMs, source: ttl.ttlSource },
  }
}

function cacheBaseFromEligibility(
  config: ResolvedModelRouterConfig,
  routeBase: ModelSelection,
  eligibility: ModelRoutingCandidateEligibility,
): ReplayConsultCache {
  return {
    base: {
      provider: routeBase.provider,
      model: routeBase.model,
      ...eligibility.requirements.promptCacheTtlMs === undefined
        ? { ttlMs: config.coldPoints.unknownTtlMs, source: 'fallback' as const }
        : { ttlMs: eligibility.requirements.promptCacheTtlMs, source: 'adapter' as const },
    },
  }
}

/**
 * Shared producer: coldPoint, eligibility, states, questions, consultKey, cache.
 * No slicing and no replay refusals. Live `decide()` supplies the live log and
 * request messages; the replay wrapper slices first.
 * @param src - live or replay consult inputs, including a required cachePolicy.
 * @returns warm, ineligible, or ask.
 */
export async function consultInputFrom(src: ConsultInputSource): Promise<ReplayConsultInput> {
  const { config, prefix, messages, requestConfig, routeBase, coldPointBase, at, runtime, signal, cachePolicy } = src
  const from = routeFromFor(config, routeBase)
  const consultKey = `turn:${at.turn}/step:${at.step}`
  const quotaGate = from?.objective === 'quota' && from.allowEveryTurn !== true
  const runEligibility = () => assessModelRoutingCandidates(
    runtime,
    requestConfig,
    messages,
    config.candidates,
    config.difficultyToEffort,
    signal,
  )
  const finish = async (coldPoint: ModelRoutingColdPoint | null, cache: ReplayConsultCache): Promise<ReplayConsultInput> => {
    const eligibility = await runEligibility()
    if (eligibility.eligibleCandidates.length === 0) {
      return { kind: 'ineligible', coldPoint, cache, eligibility }
    }
    const eligibleConfig = { ...config, candidates: eligibility.eligibleCandidates }
    const alternatives = buildRoutingStateCandidatesFromEvents(prefix, config.state)
    const questions: JudgmentQuestion[] = [
      routeQuestion(eligibleConfig, routeBase),
      ...config.difficultyInstructions === undefined ? [] : [difficultyQuestion(config, config.difficultyInstructions)],
    ]
    return {
      kind: 'ask',
      coldPoint,
      cache,
      eligibility,
      states: alternatives.map(candidate => candidate.text),
      questions,
      consultKey,
    }
  }
  if (cachePolicy.kind === 'live-eligibility') {
    const eligibility = await runEligibility()
    const cache = cacheBaseFromEligibility(config, routeBase, eligibility)
    if (eligibility.eligibleCandidates.length === 0) {
      return { kind: 'ineligible', coldPoint: null, cache, eligibility }
    }
    const eligibleConfig = { ...config, candidates: eligibility.eligibleCandidates }
    const alternatives = buildRoutingStateCandidatesFromEvents(prefix, config.state)
    const questions: JudgmentQuestion[] = [
      routeQuestion(eligibleConfig, routeBase),
      ...config.difficultyInstructions === undefined ? [] : [difficultyQuestion(config, config.difficultyInstructions)],
    ]
    return {
      kind: 'ask',
      coldPoint: null,
      cache,
      eligibility,
      states: alternatives.map(candidate => candidate.text),
      questions,
      consultKey,
    }
  }
  const ttl = cachePolicy.kind === 'live-given'
    ? cachePolicy.ttl
    : await cacheTtl(config, routeBase, runtime, signal)
  const cache = cacheBaseFromTtl(routeBase, ttl)
  const observedCold = quotaGate
    ? coldPointAt(prefix, coldPointBase, ttl, at.now, at.seedLength !== undefined)
    : undefined
  const coldPoint: ModelRoutingColdPoint | null = quotaGate ? observedCold ?? null : null
  if (quotaGate && observedCold === undefined) {
    return { kind: 'warm', coldPoint: undefined, cache }
  }
  return finish(coldPoint, cache)
}

/**
 * Offline reconstruction of the entry-path consult. Applies {@link consultPrefix}
 * and replay-only refusals, then {@link consultInputFrom}. Live `decide()` does
 * not call this. `cache.base` reports the independently resolved lifetime; the
 * live decision reports the lifetime eligibility retained, which is the fallback
 * when base preparation fails.
 * @param config - resolved router configuration.
 * @param events - the session log to slice.
 * @param at - consult coordinates and clock.
 * @param routeBase - manual route the consult compares against.
 * @param coldPointBase - route whose prompt-cache lifetime is folded.
 * @param requestConfig - live request config; never read from the log.
 * @param runtime - composed LLM runtime; prepares base and candidate calls as live routing does.
 * @param signal - optional cancellation.
 * @returns the shared producer result after replay-only refusals.
 */
export async function replayConsultInput(
  config: ResolvedModelRouterConfig,
  events: readonly SessionEvent[],
  at: ReplayConsultAt,
  routeBase: ModelSelection,
  coldPointBase: ModelSelection,
  requestConfig: LlmCallConfig,
  runtime: ConsultRuntime,
  signal?: AbortSignal,
): Promise<ReplayConsultInput> {
  const prefix = consultPrefix(events, at.turn, at.step)
  if (!sameRoute(routeBase, coldPointBase)) conversationRoute(events)
  const sticky = stickyState(prefix)
  if (sticky.active) {
    throw new ReplayConsultError('held-streak', 'replayConsultInput evaluates the entry path only; the consult prefix has an active held streak')
  }
  if (sticky.cooldownTurn !== undefined && config.reentryCooldownTurns > 0
    && at.turn - sticky.cooldownTurn <= config.reentryCooldownTurns) {
    throw new ReplayConsultError('reentry-cooldown', 'replayConsultInput evaluates the entry path only; a re-entry cooldown is in force')
  }
  const mode = foldModelRouting(prefix, prefix.length, config.initialMode)
  if (mode === 'off') {
    throw new ReplayConsultError('mode-off', 'replayConsultInput refuses a consult prefix whose folded mode is off')
  }
  return consultInputFrom({
    config,
    prefix,
    messages: derivedMessages(prefix),
    requestConfig,
    routeBase,
    coldPointBase,
    at,
    runtime,
    cachePolicy: { kind: 'replay-resolve' },
    ...signal === undefined ? {} : { signal },
  })
}
