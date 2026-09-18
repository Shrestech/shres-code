/**
 * Jev-backed compaction: `BasicCompactionEngine` with three judgment-backed
 * steps and an EXACT degradation path.
 *
 * Overrides the inherited `selectRange` to pick semantic, step-bounded segments
 * out of the baseline span, score them for load-bearingness, rescue the ones a
 * later turn needs, judge each sub-span edge conservatively, and hand the
 * rescued sub-spans to `compactIfNeeded` tail-most-first. Overrides
 * `summarize` to verify each draft against a binary battery plus an overall
 * score, escalating once to a configured strong route and then applying
 * `onVerifyFailure`.
 *
 * With no judgment engine composed, judgment turned off, an unusable answer, or
 * an engine failure, both overrides fall back to the inherited behavior — the
 * default selection and `super.summarize` — so a degraded run IS the
 * compaction-basic run, with `degraded: true` and a reason on the companion
 * events.
 *
 * Agent Note:
 * - .agents/notes/proposed/feature/2026-09-17-jev-judgment-routing-and-compaction.md
 *
 * @module @shres-code/shres-code-compaction-jev
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import BasicCompactionEngine, { summarizeWithLlm } from '@shres-code/shres-code-compaction-basic'
import type { BasicCompactionConfig, SummarizationInput, SummaryResult } from '@shres-code/shres-code-compaction-basic'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@shres-code/shres-code-compaction'
import type { CompactionResult, CompactionTrigger } from '@shres-code/shres-code-compaction'
import { judgmentEnabled, judgmentQuestionId } from '@shres-code/shres-code-judgment'
import type {
  JudgmentBinaryQuestion,
  JudgmentInput,
  JudgmentQuestionId,
  JudgmentResult,
  JudgmentScoreQuestion,
} from '@shres-code/shres-code-judgment'
import type { Agent } from '@shres-code/shres-code-agent'
import type { ContentBlock, Message } from '@shres-code/shres-code-llm'
import type { Session, SurfaceEvent } from '@shres-code/shres-code-session'
import type { TokenMeasurement } from '@shres-code/shres-code-token-meter'
import {
  DEFAULT_BOUNDARY_MARGIN,
  DEFAULT_BOUNDARY_THRESHOLD,
  DEFAULT_MAX_BOUNDARY_ADJUSTMENT,
  DEFAULT_MAX_ESCALATIONS,
  DEFAULT_MAX_RESCUES,
  DEFAULT_MAX_SEGMENTS_PER_CALL,
  DEFAULT_ON_VERIFY_FAILURE,
  DEFAULT_SEGMENT_CONFIDENCE,
  DEFAULT_SEGMENT_MAX_CHARS,
  DEFAULT_SEGMENT_SCORE_LEVELS,
  DEFAULT_VERIFY_MAX_CHARS,
  DEFAULT_VERIFY_MARGIN,
  DEFAULT_VERIFY_SCORE_LEVELS,
  DEFAULT_VERIFY_THRESHOLD,
  inheritedBasicConfig,
  resolveJevConfig,
} from './config.ts'
import type { JevCompactionConfig, ResolvedJevFacts } from './config.ts'
import type {
  CompactionBoundaryAdjustment,
  CompactionDegradationReason,
  CompactionSegmentFact,
  CompactionSelectionEvent,
  CompactionVerificationEvent,
  CompactionVerificationQuestionFact,
  CompactionVerificationVerdict,
} from './types.ts'

export type * from './types.ts'
export {
  DEFAULT_BOUNDARY_MARGIN,
  DEFAULT_BOUNDARY_THRESHOLD,
  DEFAULT_MAX_BOUNDARY_ADJUSTMENT,
  DEFAULT_MAX_ESCALATIONS,
  DEFAULT_MAX_RESCUES,
  DEFAULT_MAX_SEGMENTS_PER_CALL,
  DEFAULT_ON_VERIFY_FAILURE,
  DEFAULT_SEGMENT_CONFIDENCE,
  DEFAULT_SEGMENT_MAX_CHARS,
  DEFAULT_SEGMENT_SCORE_LEVELS,
  DEFAULT_VERIFY_MAX_CHARS,
  DEFAULT_VERIFY_MARGIN,
  DEFAULT_VERIFY_SCORE,
  DEFAULT_VERIFY_SCORE_LEVELS,
  DEFAULT_VERIFY_THRESHOLD,
  inheritedBasicConfig,
  resolveJevConfig,
} from './config.ts'
export type { JevCompactionConfig, JevOnVerifyFailure, JevVerifyCheckConfig, ResolvedJevConfig, ResolvedJevFacts } from './config.ts'

/** Question-id prefix for a segment score question; each appends its span. */
const SEGMENT_ID_PREFIX = 'segment'
/** Question-id prefix for a boundary hazard question; each appends its edge and seq. */
const BOUNDARY_ID_PREFIX = 'boundary'
/** Battery entry name of the overall score question. */
const OVERALL_NAME = 'overall'

/** One step-bounded segment of a candidate span. */
interface Segment {
  /** Inclusive first surface-node seq. */
  startSeq: number
  /** Inclusive last surface-node seq. */
  endSeq: number
  /** Surface node seqs, in order. */
  seqs: readonly number[]
}

/** The subset of a judgment engine this backend consumes. */
interface JudgmentHandle {
  /** Whether the deployment has judgment enabled. */
  readonly enabled: boolean
  /** Answer one ask. */
  ask(input: JudgmentInput): Promise<JudgmentResult>
}

/** One inclusive span of current surface positions. */
interface SubSpan {
  /** Inclusive first surface-node seq. */
  readonly start: number
  /** Inclusive last surface-node seq. */
  readonly end: number
}

/** One selection decision: the sub-spans to compact and the evidence to log. */
interface SelectionPlan {
  /**
   * Rescued sub-spans, tail-most first. Non-empty by construction: a plan exists
   * only past a rescue, and merging one rescue yields at least one span.
   */
  readonly spans: readonly [SubSpan, ...SubSpan[]]
  /** What the boundary judgment moved. */
  readonly boundaryAdjustments: readonly CompactionBoundaryAdjustment[]
  /** Segment facts, in surface order. */
  readonly segments: readonly CompactionSegmentFact[]
  /** Engine that answered the scoring and boundary asks. */
  readonly engine: string
  /** Model that answered the scoring and boundary asks. */
  readonly model: string
  /** Judgment time spent, in milliseconds. */
  readonly latencyMs: number
}

/** One selection failure: the inherited span stands, with the class that failed it. */
interface SelectionFailure {
  /** Which degradation class applied. */
  degraded: CompactionDegradationReason
}

/** One boundary-judgment outcome. */
type BoundaryOutcome =
  | {
    readonly kind: 'ok'
    readonly spans: SubSpan[]
    readonly adjustments: CompactionBoundaryAdjustment[]
    readonly latencyMs: number
  }
  | { readonly kind: 'degraded'; readonly reason: CompactionDegradationReason }

/** One battery check answer; the probability is the answer's own, never defaulted. */
interface VerificationCheckAnswer {
  /** Battery entry name. */
  readonly name: string
  /** Probability the check's binary answer reported. */
  readonly probability: number
}

/**
 * One battery answer set. An answered battery carries everything the verdict and
 * the companion event need, so a reader branches on the discriminant alone.
 */
type VerificationOutcome =
  | {
    readonly kind: 'answered'
    /** Check answers, in configuration order. */
    readonly checks: readonly VerificationCheckAnswer[]
    /** Answers the event records, `overall` last. */
    readonly questions: readonly CompactionVerificationQuestionFact[]
    /** Overall score the battery reported. */
    readonly overall: number
    /** Engine that answered. */
    readonly engine: string
    /** Duration of the battery ask. */
    readonly latencyMs: number
  }
  | {
    readonly kind: 'degraded'
    /** Which degradation class applied. */
    readonly reason: CompactionDegradationReason
    /** No check answers: the battery produced no usable set. */
    readonly checks: readonly VerificationCheckAnswer[]
    /** Nothing to record as answers. */
    readonly questions: readonly CompactionVerificationQuestionFact[]
  }

/** Cap one text head-and-tail, marking the elision. */
function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.ceil(maxChars / 2)
  const tail = maxChars - head
  return `${text.slice(0, head)}\n[… ${text.length - maxChars} characters elided …]\n${text.slice(text.length - tail)}`
}

/** Text of one content block list, joining its text blocks. */
function blocksText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
  }
  return parts.join('\n')
}

/** Text of the messages a region replays. */
function messagesText(messages: readonly Message[]): string {
  const parts: string[] = []
  for (const message of messages) parts.push(blocksText(message.content))
  return parts.filter(text => text.length > 0).join('\n')
}

/**
 * A short readable form of one surface event, for the judgment state. Only the
 * three `SurfaceEventType` members are ever surface nodes, so the switch is total
 * over them and needs no fallback.
 * @param event - the surface event to render.
 * @returns the text that event contributes to a judgment state.
 */
function eventText(event: SurfaceEvent): string {
  switch (event.type) {
    case 'user/message':
      return blocksText(event.data.content)
    case 'assistant/message':
      return blocksText(event.data.message.content)
    case 'tool/result':
      return blocksText(event.data.message.content)
  }
}

/**
 * The surface event one surface seq points at. A surface seq is the log index of
 * its own message-producing event — the surface fold established that — so the
 * lookup is a direct index rather than a scan.
 * @param session - session owning the log.
 * @param seq - current surface seq.
 * @returns the surface event that node holds.
 */
function surfaceEventAt(session: Session, seq: number): SurfaceEvent {
  // oxlint-disable-next-line typescript/no-non-null-assertion -- a surface seq always indexes its own log event.
  return session.events[seq]! as SurfaceEvent
}

/** Whether one seq list is contiguous on the surface. */
function adjacent(session: Session, previousSeq: number, nextSeq: number): boolean {
  const nodes = session.surface.nodes
  const previous = nodes.indexOf(previousSeq)
  return previous >= 0 && nodes[previous + 1] === nextSeq
}

/**
 * `ctx.compaction`: compaction with judgment-backed selection and verification.
 *
 * Composition swaps it for the `compaction-basic` row (disable that row and
 * insert this one); everything the inherited engine owns — the automatic
 * listeners, the durable transaction, retention, shrink validation, and the
 * overflow-recovery machinery — is reused unchanged.
 */
export class JevCompactionEngine extends BasicCompactionEngine {
  /**
   * Composition config schema: every `BasicCompactionConfig` field restated
   * plus this backend's judgment fields, so a forced-compaction overlay names
   * one whole config. Unknown keys and wrong types fail plugin load by name.
   */
  static override Config = z.object({
    thresholdRatio: z.number(),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    maxTokens: z.number().step(1).min(1),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
    maxSummaryOverflowRetries: z.number().step(1).min(0),
    modelPolicies: z.array(z.object({
      provider: z.string().required(),
      model: z.string().required(),
      thresholdRatio: z.number(),
      retainRatio: z.number(),
      retainTokens: z.number().step(1).min(0),
      summarizationProvider: z.string(),
      summarizationModel: z.string(),
      maxTokens: z.number().step(1).min(1),
      compactionRetries: z.number().step(1).min(0),
      maxOverflowRetries: z.number().step(1).min(0),
      maxSummaryOverflowRetries: z.number().step(1).min(0),
    })),
    auto: z.boolean(),
    maxPointers: z.number().step(1).min(0),
    pinSeqs: z.array(z.number().step(1).min(0)),
    tier: z.union(['fast', 'accurate']).default('accurate'),
    segmentScoreInstructions: z.string().required(),
    segmentScoreLevels: z.array(z.string()).default([...DEFAULT_SEGMENT_SCORE_LEVELS]),
    boundaryInstructions: z.string().required(),
    verifyInstructions: z.string().required(),
    verifyChecks: z.array(z.object({
      name: z.string().required(),
      instructions: z.string().required(),
    })).required(),
    verifyScoreLevels: z.array(z.string()).default([...DEFAULT_VERIFY_SCORE_LEVELS]),
    maxSegmentsPerCall: z.number().step(1).min(1).default(DEFAULT_MAX_SEGMENTS_PER_CALL),
    segmentMaxChars: z.number().step(1).min(1).default(DEFAULT_SEGMENT_MAX_CHARS),
    verifyMaxChars: z.number().step(1).min(1).default(DEFAULT_VERIFY_MAX_CHARS),
    rescueScore: z.number().min(0),
    segmentConfidence: z.number().min(0).max(1).default(DEFAULT_SEGMENT_CONFIDENCE),
    maxRescues: z.number().step(1).min(0).default(DEFAULT_MAX_RESCUES),
    boundaryThreshold: z.number().min(0).max(1).default(DEFAULT_BOUNDARY_THRESHOLD),
    boundaryMargin: z.number().min(0).max(1).default(DEFAULT_BOUNDARY_MARGIN),
    maxBoundaryAdjustment: z.number().step(1).min(0).default(DEFAULT_MAX_BOUNDARY_ADJUSTMENT),
    verifyThreshold: z.number().min(0).max(1).default(DEFAULT_VERIFY_THRESHOLD),
    verifyMargin: z.number().min(0).max(1).default(DEFAULT_VERIFY_MARGIN),
    verifyScore: z.number().min(0),
    escalationProvider: z.string(),
    escalationModel: z.string(),
    maxEscalations: z.number().step(1).min(0).default(DEFAULT_MAX_ESCALATIONS),
    onVerifyFailure: z.union(['accept-logged', 'fail-attempt']).default(DEFAULT_ON_VERIFY_FAILURE),
    // The cast is deliberate: this schema is STRICTER than the inherited one and
    // TypeScript's static-side inheritance check refuses a narrower schemastery
    // schema. Runtime validation is this schema (the base's would reject every
    // judgment field); the inherited type only governs how a programmatic
    // caller of the base's statics is typed.
  }) as unknown as z<BasicCompactionConfig>

  /** The raw configuration this instance was composed with. */
  private readonly raw: JevCompactionConfig

  /** Memoized judgment facts, keyed by the raw snapshot's identity. */
  private facts: ResolvedJevFacts | undefined

  /** Rescued sub-spans still queued for the compaction in flight, per session. */
  private readonly queued = new WeakMap<Session, { start: number; end: number }[]>()

  /** The trigger and signal of the automatic attempt in flight, per session. */
  private readonly attempts = new WeakMap<Session, { trigger: CompactionTrigger; signal: AbortSignal }>()

  /**
   * @param ctx - context carrying `llm`, `tokenMeter`, `sessions`, and the optional `judgment`.
   * @param config - composition config, validated by {@link resolveJevConfig} at the first use.
   */
  constructor(ctx: Context, config: JevCompactionConfig) {
    // The base class resolves its own policy and rejects unknown keys by name,
    // so it sees only the inherited fields; the judgment fields stay here.
    super(ctx, inheritedBasicConfig(config))
    this.raw = config
  }

  /** The judgment facts in force; resolution fails loud on a bad config. */
  private jev(): ResolvedJevFacts {
    this.facts ??= resolveJevConfig(this.raw).jev
    return this.facts
  }

  /** The composed judgment engine, or `undefined` when none is mounted. */
  private judgment(): JudgmentHandle | undefined {
    const engine = this.ctx.get('judgment')
    if (engine === undefined) return undefined
    return {
      enabled: judgmentEnabled(engine.settings),
      ask: input => engine.ask(input),
    }
  }

  /**
   * Compact for one trigger, driving every rescued sub-span through the
   * inherited machinery tail-most-first.
   *
   * The inherited engine compacts one selected range per call, so this loop
   * calls it once per rescued sub-span: each iteration re-runs the inherited
   * pressure check, selection, overflow retries, validation, and durable
   * bracket, which is what keeps the retry and rollback semantics identical to
   * compaction-basic. A failed sub-span propagates and abandons the rest, while
   * the sub-spans already committed stay committed.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to judgment and summarization.
   * @returns the last summary compaction result, or `null` when no summary ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const session = agent.session
    this.attempts.set(session, { trigger, signal })
    this.queued.delete(session)
    try {
      let latest: CompactionResult | null = null
      for (;;) {
        const result = await super.compactIfNeeded(agent, trigger, signal)
        if (result === null) return latest
        latest = result
        const remaining = this.queued.get(session)
        if (remaining === undefined || remaining.length === 0) return latest
      }
    } finally {
      this.queued.delete(session)
      this.attempts.delete(session)
    }
  }

  /**
   * Select the next span to compact: a queued rescued sub-span, or the
   * inherited baseline scored into semantic segments.
   *
   * Degradation is decided before any spend: no engine, judgment off, a failed
   * ask, or an unusable answer returns the inherited span with `degraded: true`
   * and a reason on the companion event. `maxRescues: 0` skips scoring
   * entirely rather than asking and discarding.
   * @param session - session supplying authoritative current surface positions.
   * @param measurement - unified pressure and surface measurement for this attempt.
   * @param retainTokens - minimum recent tail budget retained verbatim.
   * @param pinSeqs - surface seqs that must remain unshadowed.
   * @returns the next span to compact, or `null` when nothing is compactable.
   */
  protected override async selectRange(
    session: Session,
    measurement: TokenMeasurement,
    retainTokens: number,
    pinSeqs: readonly number[],
  ): Promise<{ start: number; end: number } | null> {
    const attempt = this.attempts.get(session)
    const trigger = attempt?.trigger ?? 'pressure'
    const signal = attempt?.signal
    const pending = this.queued.get(session)
    if (pending !== undefined && pending.length > 0) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- the length check above guarantees a queued span.
      return pending.shift()!
    }
    const base = await super.selectRange(session, measurement, retainTokens, pinSeqs)
    if (base === null) {
      this.appendSelection(session, { trigger, degraded: false, segments: [], boundaryAdjustments: [] })
      return null
    }
    const facts = this.jev()
    const engine = this.judgment()
    if (engine === undefined || !engine.enabled) {
      this.appendSelection(session, {
        trigger,
        degraded: true,
        reason: engine === undefined ? 'engine-absent' : 'engine-disabled',
        segments: [],
        boundaryAdjustments: [],
      })
      return base
    }
    const segments = this.segmentsOf(session, base)
    if (facts.maxRescues === 0) {
      this.appendSelection(session, {
        trigger,
        degraded: false,
        segments: segments.map(segment => ({
          startSeq: segment.startSeq,
          endSeq: segment.endSeq,
          disposition: 'unscored' as const,
        })),
        boundaryAdjustments: [],
      })
      return base
    }
    const plan = await this.plan(session, segments, facts, engine, signal)
    if ('degraded' in plan) {
      this.appendSelection(session, {
        trigger,
        degraded: true,
        reason: plan.degraded,
        segments: [],
        boundaryAdjustments: [],
      })
      return base
    }
    this.appendSelection(session, {
      trigger,
      degraded: false,
      segments: [...plan.segments],
      boundaryAdjustments: [...plan.boundaryAdjustments],
      engine: plan.engine,
      model: plan.model,
      latencyMs: plan.latencyMs,
    })
    this.queued.set(session, plan.spans.slice(1).map(span => ({ start: span.start, end: span.end })))
    return plan.spans[0]
  }

  /**
   * Score the segments, rescue the load-bearing ones, and judge the sub-span
   * edges; `undefined` means the plan degraded and the inherited span stands.
   */
  private async plan(
    session: Session,
    segments: readonly Segment[],
    facts: ResolvedJevFacts,
    engine: JudgmentHandle,
    signal: AbortSignal | undefined,
  ): Promise<SelectionPlan | SelectionFailure> {
    const scored: CompactionSegmentFact[] = []
    const rescued: Segment[] = []
    let engineName: string | undefined
    let model: string | undefined
    let latencyMs = 0
    for (let offset = 0; offset < segments.length; offset += facts.maxSegmentsPerCall) {
      const chunk = segments.slice(offset, offset + facts.maxSegmentsPerCall)
      const questions = chunk.map(segment => this.segmentQuestion(facts, segment))
      let result: JudgmentResult
      try {
        result = await engine.ask({
          state: this.chunkState(session, chunk, facts.segmentMaxChars),
          questions,
          tier: facts.tier,
          ...signal === undefined ? {} : { signal },
        })
      } catch (error: unknown) {
        const code = (error as { code?: unknown } | null)?.code
        return { degraded: code === 'INVALID_ANSWER' ? 'invalid-answer' : 'engine-unavailable' }
      }
      engineName = result.engine
      model = result.model
      latencyMs += result.latencyMs
      for (const segment of chunk) {
        const answer = this.scoreAnswer(result, segment)
        if (answer === undefined) {
          scored.push({ startSeq: segment.startSeq, endSeq: segment.endSeq, disposition: 'unscored' })
          continue
        }
        const rescuedSegment = answer.score >= facts.rescueScore
          && answer.confidence >= facts.segmentConfidence
          && rescued.length < facts.maxRescues
        scored.push({
          startSeq: segment.startSeq,
          endSeq: segment.endSeq,
          score: answer.score,
          confidence: answer.confidence,
          disposition: rescuedSegment ? 'rescued' : 'dropped',
        })
        if (rescuedSegment) rescued.push(segment)
      }
    }
    if (rescued.length === 0) return { degraded: 'below-confidence' }
    const spans = this.mergeRescued(session, rescued)
    const boundary = await this.judgeBoundaries(session, spans, facts, engine, signal)
    if (boundary.kind === 'degraded') {
      return { degraded: boundary.reason } satisfies SelectionFailure
    }
    const surfaceOrder = [...boundary.spans].reverse()
    const [tailMost, ...earlier] = surfaceOrder
    return {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- mergeRescued returns at least one span
      spans: [tailMost!, ...earlier],
      boundaryAdjustments: boundary.adjustments,
      segments: scored,
      // oxlint-disable-next-line typescript/no-non-null-assertion -- a rescue means at least one ask ran
      engine: engineName!, model: model!,
      latencyMs: latencyMs + boundary.latencyMs,
    }
  }

  /** Partition one span into step-bounded, tool-pairing-balanced segments. */
  private segmentsOf(session: Session, span: { start: number; end: number }): Segment[] {
    const nodes = session.surface.nodes
    const startIdx = nodes.indexOf(span.start)
    const endIdx = nodes.indexOf(span.end)
    const segments: Segment[] = []
    let current: number[] = []
    for (let index = startIdx; index <= endIdx; index += 1) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- index runs from startIdx to endIdx, both real positions on the span.
      const seq = nodes[index]!
      current.push(seq)
      if (toolPairingBalancedAfter(session, seq) || index === endIdx) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- a segment closes only after current received at least one seq.
        const first = current[0]!
        segments.push({ startSeq: first, endSeq: seq, seqs: [...current] })
        current = []
      }
    }
    return segments
  }

  /** Merge rescued segments into contiguous sub-spans, in surface order. */
  private mergeRescued(session: Session, rescued: readonly Segment[]): { start: number; end: number }[] {
    const spans: { start: number; end: number }[] = []
    for (const segment of rescued) {
      const open = spans.at(-1)
      if (open !== undefined && adjacent(session, open.end, segment.startSeq)) {
        open.end = segment.endSeq
      } else {
        spans.push({ start: segment.startSeq, end: segment.endSeq })
      }
    }
    return spans
  }

  /**
   * Judge one hazard question per sub-span edge and move an unsafe edge outward
   * through legal boundaries; `undefined` means the boundary ask degraded.
   */
  private async judgeBoundaries(
    session: Session,
    spans: readonly { start: number; end: number }[],
    facts: ResolvedJevFacts,
    engine: JudgmentHandle,
    signal: AbortSignal | undefined,
  ): Promise<BoundaryOutcome> {
    const adjustments: CompactionBoundaryAdjustment[] = []
    let latencyMs = 0
    const adjusted: { start: number; end: number }[] = []
    for (const span of spans) {
      let start = span.start
      let end = span.end
      for (const edge of ['start', 'end'] as const) {
        const seq = edge === 'start' ? start : end
        let answer
        try {
          answer = await engine.ask({
            state: this.spanState(session, span, facts.segmentMaxChars),
            questions: [this.boundaryQuestion(facts, edge, seq)],
            tier: facts.tier,
            ...signal === undefined ? {} : { signal },
          })
        } catch (error: unknown) {
          // Mirror the scoring and battery catches: an unusable body and an
          // unreachable engine are different classes, and a caller branches on them.
          const code = (error as { code?: unknown } | null)?.code
          return {
            kind: 'degraded',
            reason: code === 'INVALID_ANSWER' ? 'invalid-answer' : 'engine-unavailable',
          }
        }
        latencyMs += answer.latencyMs
        const probability = this.probabilityAnswer(answer, boundaryId(edge, seq))
        if (probability === undefined) return { kind: 'degraded', reason: 'invalid-answer' }
        const unsafe = probability >= facts.boundaryThreshold - facts.boundaryMargin
        if (!unsafe) continue
        const moved = this.moveEdge(session, edge, seq, facts.maxBoundaryAdjustment)
        if (moved === undefined) continue
        if (edge === 'start') start = moved
        else end = moved
        adjustments.push({ edge, fromSeq: seq, toSeq: moved, probability })
      }
      adjusted.push({ start, end })
    }
    return { kind: 'ok', spans: adjusted, adjustments, latencyMs }
  }

  /**
   * Move one edge outward to the nearest legal boundary within the cap, if any.
   * @param session - session supplying the current surface.
   * @param edge - which edge of the sub-span moves.
   * @param seq - that edge's current surface seq, which the span guarantees is on the surface.
   * @param cap - maximum nodes the edge may move.
   * @returns the legal boundary seq the edge moves to, or `undefined` when none is in reach.
   */
  private moveEdge(
    session: Session,
    edge: 'start' | 'end',
    seq: number,
    cap: number,
  ): number | undefined {
    const nodes = session.surface.nodes
    const index = nodes.indexOf(seq)
    for (let step = 1; step <= cap; step += 1) {
      const candidateIndex = edge === 'start' ? index - step : index + step
      const candidate = nodes[candidateIndex]
      if (candidate === undefined) return undefined
      const legal = edge === 'start'
        ? toolPairingBalancedBefore(session, candidate)
        : toolPairingBalancedAfter(session, candidate)
      if (legal) return candidate
    }
    return undefined
  }

  /** The score question one segment answers. */
  private segmentQuestion(facts: ResolvedJevFacts, segment: Segment): JudgmentScoreQuestion {
    return {
      kind: 'score',
      id: segmentId(segment),
      instructions: `${facts.segmentScoreInstructions}\nSegment ${segment.startSeq}..${segment.endSeq} (marked in the state).`,
      levels: [...facts.segmentScoreLevels],
    }
  }

  /** The hazard question one edge answers. */
  private boundaryQuestion(facts: ResolvedJevFacts, edge: 'start' | 'end', seq: number): JudgmentBinaryQuestion {
    return {
      kind: 'binary',
      id: boundaryId(edge, seq),
      instructions: `${facts.boundaryInstructions}\nEdge: ${edge} at seq ${seq}.`,
    }
  }

  /** The state one chunk of segments is scored against. */
  private chunkState(session: Session, chunk: readonly Segment[], maxChars: number): string {
    const parts: string[] = []
    for (const segment of chunk) {
      parts.push(`--- segment ${segment.startSeq}..${segment.endSeq} ---\n${this.segmentText(session, segment, maxChars)}`)
    }
    return parts.join('\n\n')
  }

  /** The state one sub-span's boundary is judged against. */
  private spanState(session: Session, span: { start: number; end: number }, maxChars: number): string {
    const nodes = session.surface.nodes
    const startIdx = nodes.indexOf(span.start)
    const endIdx = nodes.indexOf(span.end)
    const parts: string[] = []
    for (let index = startIdx; index <= endIdx; index += 1) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- index runs between two real positions on the span.
      const seq = nodes[index]!
      const text = eventText(surfaceEventAt(session, seq))
      if (text.length > 0) parts.push(text)
    }
    return capText(parts.join('\n'), maxChars)
  }

  /** One segment's text, capped. */
  private segmentText(session: Session, segment: Segment, maxChars: number): string {
    const parts: string[] = []
    for (const seq of segment.seqs) {
      const text = eventText(surfaceEventAt(session, seq))
      if (text.length > 0) parts.push(text)
    }
    return capText(parts.join('\n'), maxChars)
  }

  /** The score answer for one segment, when the engine returned one. */
  private scoreAnswer(
    result: JudgmentResult,
    segment: Segment,
  ): { score: number; confidence: number } | undefined {
    const id = segmentId(segment)
    const answer = result.answers.find(candidate => candidate.id === id)
    return answer !== undefined && answer.kind === 'score'
      ? { score: answer.score, confidence: answer.confidence }
      : undefined
  }

  /** The probability of one binary answer, when the engine returned one. */
  private probabilityAnswer(result: JudgmentResult, id: JudgmentQuestionId): number | undefined {
    const answer = result.answers.find(candidate => candidate.id === id)
    return answer !== undefined && answer.kind === 'binary' ? answer.probability : undefined
  }

  /**
   * Verify one draft with the configured battery, or report why it degraded.
   * @param draft - the draft summary to verify.
   * @param input - the replayed region the draft condenses.
   * @param facts - resolved judgment facts.
   * @param engine - the composed judgment engine.
   * @param signal - optional cancellation.
   * @returns the battery answers, or the degradation class.
   */
  private async verify(
    draft: SummaryResult,
    input: SummarizationInput,
    facts: ResolvedJevFacts,
    engine: JudgmentHandle,
    signal?: AbortSignal,
  ): Promise<VerificationOutcome> {
    const state = this.verifyState(draft, input, facts.verifyMaxChars)
    const questions: (JudgmentBinaryQuestion | JudgmentScoreQuestion)[] = [
      ...facts.verifyChecks.map(check => ({
        kind: 'binary' as const,
        id: checkId(check.name),
        instructions: check.instructions,
      })),
      {
        kind: 'score' as const,
        id: checkId(OVERALL_NAME),
        instructions: facts.verifyInstructions,
        levels: [...facts.verifyScoreLevels],
      },
    ]
    let result: JudgmentResult
    try {
      result = await engine.ask({
        state,
        questions,
        tier: facts.tier,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      const code = (error as { code?: unknown } | null)?.code
      return {
        kind: 'degraded',
        reason: code === 'INVALID_ANSWER' ? 'invalid-answer' : 'engine-unavailable',
        checks: [],
        questions: [],
      }
    }
    const checks: VerificationCheckAnswer[] = []
    for (const check of facts.verifyChecks) {
      const answer = result.answers.find(candidate => candidate.id === checkId(check.name))
      if (answer === undefined || answer.kind !== 'binary') {
        return { kind: 'degraded', reason: 'invalid-answer', checks: [], questions: [] }
      }
      checks.push({ name: check.name, probability: answer.probability })
    }
    const scoreAnswer = result.answers.find(candidate => candidate.id === checkId(OVERALL_NAME))
    if (scoreAnswer === undefined || scoreAnswer.kind !== 'score') {
      return { kind: 'degraded', reason: 'invalid-answer', checks: [], questions: [] }
    }
    return {
      kind: 'answered',
      checks,
      questions: [
        ...checks,
        { name: OVERALL_NAME, score: scoreAnswer.score, confidence: scoreAnswer.confidence },
      ],
      overall: scoreAnswer.score,
      engine: result.engine,
      latencyMs: result.latencyMs,
    }
  }

  /** The state one verification reads: the draft plus the capped original region. */
  private verifyState(draft: SummaryResult, input: SummarizationInput, maxChars: number): string {
    const draftText = blocksText(draft.summary)
    const regionText = messagesText(input.messages)
    const budget = Math.max(1, maxChars - draftText.length)
    return `--- draft ---\n${draftText}\n--- original region (capped) ---\n${capText(regionText, budget)}`
  }

  /**
   * What one battery answer set concludes.
   * @param checks - the battery's check answers, in configuration order.
   * @param overall - the overall score the battery reported.
   * @param facts - resolved judgment facts.
   * @returns `accepted` when every check and the overall score clear their floors.
   */
  private batteryVerdict(
    checks: readonly VerificationCheckAnswer[],
    overall: number,
    facts: ResolvedJevFacts,
  ): CompactionVerificationVerdict {
    const checksPass = checks.every(check => check.probability >= facts.verifyThreshold)
    return checksPass && overall >= facts.verifyScore ? 'accepted' : 'escalated'
  }

  /** Produce the escalation draft, or the conversation target's when none is configured. */
  private async escalate(
    input: SummarizationInput,
    agent: Agent,
    facts: ResolvedJevFacts,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    if (facts.escalation === undefined) return super.summarize(input, agent, signal)
    return summarizeWithLlm(this.ctx, {
      ...this.config,
      summarizationProvider: facts.escalation.provider,
      summarizationModel: facts.escalation.model,
    }, input, agent, signal)
  }

  /** The compaction lifecycle the live transaction opened. */
  private compactionIdOf(session: Session): CompactionVerificationEvent['compactionId'] | undefined {
    let id: CompactionVerificationEvent['compactionId'] | undefined
    for (const event of session.events) {
      if (event.type === 'compaction/start') id = event.data.compactionId
      if (event.type === 'compaction/end') id = undefined
    }
    return id
  }

  /** Append one selection event. */
  private appendSelection(session: Session, event: CompactionSelectionEvent): void {
    session.append('compaction/selection', event)
  }

  /** Append one verification event; a missing live compaction is not logged. */
  private appendVerification(
    agent: Agent,
    event: Omit<CompactionVerificationEvent, 'compactionId' | 'reason'> & {
      compactionId: CompactionVerificationEvent['compactionId'] | undefined
      reason?: CompactionDegradationReason | undefined
    },
  ): void {
    const { reason, compactionId, ...rest } = event
    if (compactionId === undefined) return
    agent.session.append('compaction/verification', {
      ...rest,
      compactionId,
      ...reason === undefined ? {} : { reason },
    })
  }

  /**
   * Verify one draft and escalate at most `maxEscalations` times.
   * @param input - replayed conversation prefix to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns the accepted (or best-scoring) summary with its call facts.
   */
  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const facts = this.jev()
    const engine = this.judgment()
    const compactionId = this.compactionIdOf(agent.session)
    if (engine === undefined || !engine.enabled) {
      this.appendVerification(agent, {
        compactionId,
        attempt: 1,
        provider: this.config.summarizationProvider,
        model: this.config.summarizationModel,
        questions: [],
        verdict: 'accepted',
        degraded: true,
        reason: engine === undefined ? 'engine-absent' : 'engine-disabled',
      })
      return super.summarize(input, agent, signal)
    }
    let draft = await super.summarize(input, agent, signal)
    let best = draft
    let bestScore = -1
    let attempt = 1
    for (;;) {
      const outcome = await this.verify(draft, input, facts, engine, signal)
      if (outcome.kind === 'degraded') {
        this.appendVerification(agent, {
          compactionId,
          attempt,
          provider: draft.provider,
          model: draft.model,
          questions: [],
          verdict: 'accepted',
          degraded: true,
          reason: outcome.reason,
        })
        return draft
      }
      const overall = outcome.overall
      if (overall > bestScore) {
        bestScore = overall
        best = draft
      }
      const verdict = this.batteryVerdict(outcome.checks, overall, facts)
      const bandOnly = outcome.checks.every(check =>
        check.probability >= facts.verifyThreshold - facts.verifyMargin)
      if (verdict === 'accepted') {
        this.appendVerification(agent, {
          compactionId,
          attempt,
          provider: draft.provider,
          model: draft.model,
          questions: [...outcome.questions],
          verdict: 'accepted',
          degraded: false,
          engine: outcome.engine,
          latencyMs: outcome.latencyMs,
        })
        return draft
      }
      if (attempt <= facts.maxEscalations && !(bandOnly && facts.onVerifyFailure === 'accept-logged')) {
        this.appendVerification(agent, {
          compactionId,
          attempt,
          provider: draft.provider,
          model: draft.model,
          questions: [...outcome.questions],
          verdict: 'escalated',
          degraded: false,
          engine: outcome.engine,
          latencyMs: outcome.latencyMs,
        })
        draft = await this.escalate(input, agent, facts, signal)
        attempt += 1
        continue
      }
      // Every answered battery sets `best`, so the better draft is always known here.
      const keep = best
      if (facts.onVerifyFailure === 'fail-attempt') {
        throw new Error(
          'compaction-jev: the summary failed verification and onVerifyFailure is "fail-attempt"'
          + ` (attempt ${attempt}, overall score ${overall})`,
        )
      }
      this.appendVerification(agent, {
        compactionId,
        attempt,
        provider: keep.provider,
        model: keep.model,
        questions: [...outcome.questions],
        verdict: 'accepted-below-threshold',
        degraded: false,
        engine: outcome.engine,
        latencyMs: outcome.latencyMs,
      })
      return keep
    }
  }
}

/** The judgment id one segment's score question carries. */
function segmentId(segment: Segment): JudgmentQuestionId {
  return judgmentQuestionId(`${SEGMENT_ID_PREFIX}:${segment.startSeq}:${segment.endSeq}`)
}

/** The judgment id one boundary question carries. */
function boundaryId(edge: 'start' | 'end', seq: number): JudgmentQuestionId {
  return judgmentQuestionId(`${BOUNDARY_ID_PREFIX}:${edge}:${seq}`)
}

/** The judgment id one battery entry carries. */
function checkId(name: string): JudgmentQuestionId {
  return judgmentQuestionId(name)
}

export default JevCompactionEngine
