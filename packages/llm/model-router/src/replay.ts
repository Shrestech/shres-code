/**
 * Public consult-input reconstruction for offline replay. Live `decide()`
 * calls the same producer, so bench never imports `src/*`.
 *
 * @module @shres-code/shres-code-model-router/replay
 */

import type { ModelSelection } from '@shres-code/shres-code-agent'
import type { LlmCallConfig, LlmResolvedModelInfo, Message } from '@shres-code/shres-code-llm'
import type { JudgmentQuestion } from '@shres-code/shres-code-judgment'
import { deriveEventMessage, foldSurface } from '@shres-code/shres-code-session'
import type { SessionEvent } from '@shres-code/shres-code-session'
import type { ResolvedModelRouterConfig } from './config.ts'
import { KEEP_CURRENT_OPTION_ID } from './config.ts'
import { assessModelRoutingCandidates } from './eligibility.ts'
import type { ModelRoutingCacheTtl } from './folds.ts'
import { coldPointAt, stickyState } from './folds.ts'
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

/** Entry path that cannot ask: eligibility is present, questions are not. */
export interface ReplayConsultIneligible {
  readonly kind: 'ineligible'
  readonly coldPoint: ModelRoutingColdPoint | null
  readonly cache: ReplayConsultCache
  readonly eligibility: ModelRoutingCandidateEligibility
}

/** Entry path that would ask: states, questions, and consultKey. */
export interface ReplayConsultAsk {
  readonly kind: 'ask'
  readonly coldPoint: ModelRoutingColdPoint | null
  readonly cache: ReplayConsultCache
  readonly eligibility: ModelRoutingCandidateEligibility
  readonly states: readonly string[]
  readonly questions: readonly JudgmentQuestion[]
  readonly consultKey: string
}

export type ReplayConsultInput = ReplayConsultWarm | ReplayConsultIneligible | ReplayConsultAsk

export class ReplayConsultError extends Error {
  readonly code: 'held-streak' | 'mixed-route'
  constructor(code: 'held-streak' | 'mixed-route', message: string) {
    super(message)
    this.name = 'ReplayConsultError'
    this.code = code
  }
}

/**
 * Events that precede the router consult of `turn`/`step`: through that
 * step's `step/start` and claimed user messages, excluding this request's
 * `agent/route-base`, `request/header`, `model-routing/decision`, and
 * `assistant/*` for the same step.
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
    throw new Error(`consultPrefix: no step/start for turn ${String(turn)} step ${String(step)}`)
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

/**
 * Reconstruct the entry-path consult input live `decide()` would ask.
 *
 * Entry path only: no held streak, re-entry cooldown, breaker, or engine
 * snapshot. A log whose sticky fold is active at `at` is refused. Messages
 * are `foldSurface(consultPrefix).nodes` mapped through `deriveEventMessage`
 * (the same public session exports `Session.deriveMessages` uses). There is
 * no public reconstruction of `request.config` from the log; callers pass
 * `requestConfig` explicitly.
 *
 * @param config - resolved router configuration.
 * @param events - the full session log; the consult prefix is applied internally.
 * @param at - turn, step, step-start clock, and seedLength (present even when undefined).
 * @param routeBase - keep-current / eligibility / cache.base route.
 * @param coldPointBase - the trial's own conversation route for `coldPointAt`.
 * @param requestConfig - the assembled request config of this step; never read from the log.
 * @param resolveModelInfo - the same resolver eligibility uses live (`ctx.llm.resolveModelInfo`).
 * @param signal - optional cancellation forwarded to eligibility.
 */
export async function replayConsultInput(
  config: ResolvedModelRouterConfig,
  events: readonly SessionEvent[],
  at: ReplayConsultAt,
  routeBase: ModelSelection,
  coldPointBase: ModelSelection,
  requestConfig: LlmCallConfig,
  resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) => Promise<LlmResolvedModelInfo>,
  signal?: AbortSignal,
): Promise<ReplayConsultInput> {
  const prefix = consultPrefix(events, at.turn, at.step)
  if (!sameRoute(routeBase, coldPointBase)) conversationRoute(events)
  if (stickyState(prefix).active) {
    throw new ReplayConsultError('held-streak', 'replayConsultInput evaluates the entry path only; the consult prefix has an active held streak')
  }
  const from = routeFromFor(config, routeBase)
  const consultKey = `turn:${at.turn}/step:${at.step}`
  const ttl = await cacheTtl(config, routeBase, resolveModelInfo, signal)
  const cache: ReplayConsultCache = {
    base: { provider: routeBase.provider, model: routeBase.model, ttlMs: ttl.ttlMs, source: ttl.ttlSource },
  }
  const quotaGate = from?.objective === 'quota' && from.allowEveryTurn !== true
  const observedCold = quotaGate
    ? coldPointAt(prefix, coldPointBase, ttl, at.now, at.seedLength !== undefined)
    : undefined
  const coldPoint: ModelRoutingColdPoint | null = quotaGate ? observedCold ?? null : null
  const quotaWarm = quotaGate && observedCold === undefined
  if (quotaWarm) {
    return { kind: 'warm', coldPoint: undefined, cache }
  }
  const eligibility = await assessModelRoutingCandidates(
    { resolveModelInfo, prepareCall: async (callConfig: LlmCallConfig) => ({ config: callConfig }) } as never,
    requestConfig,
    derivedMessages(prefix),
    config.candidates,
    config.difficultyToEffort,
    signal,
  )
  const eligibleConfig = { ...config, candidates: eligibility.eligibleCandidates }
  if (eligibility.eligibleCandidates.length === 0) {
    return { kind: 'ineligible', coldPoint, cache, eligibility }
  }
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

async function cacheTtl(
  config: ResolvedModelRouterConfig,
  base: ModelSelection,
  resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) => Promise<LlmResolvedModelInfo>,
  signal?: AbortSignal,
): Promise<ModelRoutingCacheTtl> {
  let declared: number | undefined
  try {
    declared = (await resolveModelInfo(base.provider, base.model, signal)).promptCacheTtlMs
  } catch {
    signal?.throwIfAborted()
  }
  return declared === undefined
    ? { ttlMs: config.coldPoints.unknownTtlMs, ttlSource: 'fallback' }
    : { ttlMs: declared, ttlSource: 'adapter' }
}
