/**
 * Semantic selection: the segment partition, per-segment scoring and rescue
 * boundaries, the rescue budget, chunking, sub-span merging and tail-most-first
 * order, sub-span abandonment, and the boundary judgment with its outward moves.
 *
 * Both entry points are used: \`compactIfNeeded\` for the automatic 'pressure'
 * trigger where the surrounding transaction matters, and the protected
 * \`selectRange\` through {@link TestJevEngine} where the decision alone is the
 * subject.
 *
 * TEST DOUBLES: from ./harness.ts — {@link ContextAdapter}, {@link ScriptedJudgment},
 * {@link ScriptedSummarizer}, {@link TestJevEngine}. The session, the token meter,
 * the region transaction, and the tool-pairing fold are real.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@shres-code/cordis'
import type { Session } from '@shres-code/shres-code-session'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@shres-code/shres-code-compaction'
import { selectCompactableRange } from '@shres-code/shres-code-compaction-basic/src/region.ts'
import type { CompactionSelectionEvent } from '../src/index.ts'
import type { JevCompactionConfig } from '../src/index.ts'
import {
  boundaryQuestion,
  compactIfNeeded,
  SIGNAL,
  conversation,
  createContext,
  jevOverrides,
  openToolCallConversation,
  ScriptedJudgment,
  segmentQuestion,
  selectionEvents,
  summaryEvents,
  TestJevEngine,
  toolConversation,
} from './harness.ts'

/** Retained-tail budget every selection case selects against. */
const RETAIN = 100

interface Bench {
  readonly ctx: Context
  readonly judgment: ScriptedJudgment
  readonly engine: TestJevEngine
  readonly config: JevCompactionConfig
}

/** One engine over a fresh context, with the required judgment texts supplied. */
function bench(overrides: Partial<JevCompactionConfig> = {}, ctx: Context = createContext()): Bench {
  const config = jevOverrides({ retainTokens: RETAIN, ...overrides })
  return { ctx, judgment: new ScriptedJudgment(ctx), engine: new TestJevEngine(ctx, config), config }
}

/**
 * One history whose surface is far above the default threshold, so a pressure
 * attempt always admits, and whose whole span is compactable without a retained
 * tail competing for the queued sub-spans.
 */
function longConversation(): Session {
  return conversation(4, 'x'.repeat(600))
}

/** The inherited selection over one session, which every semantic span starts from. */
function baseSpan(
  bench: Bench,
  session: Parameters<typeof compactIfNeeded>[1],
  retain: number = RETAIN,
): { start: number; end: number } {
  const base = selectCompactableRange(session, bench.ctx.tokenMeter.measure(session), retain)
  if (base === null) throw new Error('fixture: the session has no compactable base span')
  return base
}

/** The surface nodes one span covers, in order. */
function spanNodes(session: Parameters<typeof compactIfNeeded>[1], span: { start: number; end: number }): number[] {
  const nodes = session.surface.nodes
  return nodes.slice(nodes.indexOf(span.start), nodes.indexOf(span.end) + 1)
}

/**
 * The span's segments under the documented rule — each closes at the first
 * tool-pairing-balanced cut after its start — used to target scripted answers at
 * a specific segment. The partition itself is asserted by
 * {@link expectPartition}, not by this helper.
 */
function segmentsOf(
  session: Session,
  span: { start: number; end: number },
): Array<{ startSeq: number; endSeq: number }> {
  const nodes = spanNodes(session, span)
  const segments: Array<{ startSeq: number; endSeq: number }> = []
  let open: number | undefined
  for (const [index, seq] of nodes.entries()) {
    open ??= seq
    if (toolPairingBalancedAfter(session, seq) || index === nodes.length - 1) {
      segments.push({ startSeq: open, endSeq: seq })
      open = undefined
    }
  }
  return segments
}

/** One selection call against the current surface. */
function select(bench: Bench, session: Parameters<typeof compactIfNeeded>[1]): Promise<{ start: number; end: number } | null> {
  return bench.engine.selectRange(session, bench.ctx.tokenMeter.measure(session), RETAIN, [])
}

/** The last recorded selection decision of one session. */
function selection(session: Parameters<typeof compactIfNeeded>[1]): CompactionSelectionEvent {
  const events = selectionEvents(session)
  const last = events.at(-1)
  if (last === undefined) throw new Error('fixture: no compaction/selection event was recorded')
  return last
}

/** Assert the selection event's segments tile one span under the step-boundary rule. */
function expectPartition(
  session: Parameters<typeof compactIfNeeded>[1],
  event: CompactionSelectionEvent,
  span: { start: number; end: number },
): void {
  const covered = spanNodes(session, span)
  const segments = event.segments
  expect(segments).not.toHaveLength(0)
  expect(segments[0]?.startSeq).toBe(span.start)
  expect(segments.at(-1)?.endSeq).toBe(span.end)

  for (const [index, segment] of segments.entries()) {
    // Contiguous, non-overlapping, in surface order.
    if (index > 0) {
      const previous = segments[index - 1]
      if (previous === undefined) throw new Error('fixture: missing previous segment')
      expect(covered.indexOf(segment.startSeq)).toBe(covered.indexOf(previous.endSeq) + 1)
    }
    // Every edge is a tool-pairing-balanced cut.
    expect(toolPairingBalancedBefore(session, segment.startSeq)).toBe(true)
    expect(toolPairingBalancedAfter(session, segment.endSeq)).toBe(true)
    // The segment is maximal: no cut strictly inside it is balanced.
    for (const seq of spanNodes(session, { start: segment.startSeq, end: segment.endSeq }).slice(0, -1)) {
      expect(toolPairingBalancedAfter(session, seq)).toBe(false)
    }
  }
  // The partition covers the span exactly once.
  expect(segments.flatMap(segment => spanNodes(session, { start: segment.startSeq, end: segment.endSeq })))
    .toEqual(covered)
}

describe('semantic selection: the segment partition', () => {
  it('partitions the inherited span into step-bounded, tool-pairing-balanced segments', async () => {
    const under = bench({ maxRescues: 0 })
    const session = toolConversation()
    const base = baseSpan(under, session)

    await select(under, session)

    expectPartition(session, selection(session), base)
    expect(selection(session).trigger).toBe('pressure')
    expect(selection(session).degraded).toBe(false)
    expect(selection(session).boundaryAdjustments).toEqual([])
    // Nine surface nodes in three tool turns: six step-bounded segments exist,
    // of which the retained tail leaves the head-most five in the span.
    expect(selection(session).segments).toHaveLength(5)
  })

  it('partitions a message-only span one segment per step', async () => {
    const under = bench({ maxRescues: 0 })
    const session = conversation(4)
    const base = baseSpan(under, session)

    await select(under, session)

    expectPartition(session, selection(session), base)
    expect(selection(session).segments.every(segment => segment.startSeq === segment.endSeq)).toBe(true)
  })

  it('records the trigger the automatic attempt ran under', async () => {
    const under = bench({ maxRescues: 0, retainTokens: 10, thresholdRatio: 0.2 })
    const session = conversation(4, 'x'.repeat(600))

    await compactIfNeeded(under.engine, session, 'context-overflow')

    expect(selection(session).trigger).toBe('context-overflow')
  })

  it('records no selection when the inherited selection declines', async () => {
    const under = bench({ maxRescues: 0 })
    const session = conversation(1)

    expect(await select(under, session)).toBeNull()
    expect(selection(session)).toMatchObject({ degraded: false, segments: [], boundaryAdjustments: [] })
  })
})

describe('semantic selection: chunking at maxSegmentsPerCall', () => {
  it('asks once per chunk with its own state and questions', async () => {
    const whole = bench({ maxRescues: 64, maxSegmentsPerCall: 64 })
    whole.judgment.defaultScore = { score: 5, confidence: 1 }
    const reference = toolConversation()
    await select(whole, reference)
    const segments = selection(reference).segments
    expect(segments.length).toBeGreaterThan(2)

    const chunked = bench({ maxRescues: 64, maxSegmentsPerCall: 2 })
    chunked.judgment.defaultScore = { score: 5, confidence: 1 }
    const session = toolConversation()
    await select(chunked, session)

    const scoreAsks = chunked.judgment.asksOfKind('score')
    expect(scoreAsks).toHaveLength(Math.ceil(segments.length / 2))
    const asked = scoreAsks.map(input => input.questions.map(question => question.id))
    for (const [index, ids] of asked.entries()) {
      const expected = segments.slice(index * 2, index * 2 + 2)
        .map(segment => segmentQuestion(segment.startSeq, segment.endSeq))
      expect(ids).toEqual(expected)
    }
    // Each ask's state carries exactly its own chunk's segment markers.
    for (const [index, input] of scoreAsks.entries()) {
      const markers = input.state.match(/--- segment \d+\.\.\d+ ---/g) ?? []
      expect(markers).toEqual(segments.slice(index * 2, index * 2 + 2)
        .map(segment => `--- segment ${segment.startSeq}..${segment.endSeq} ---`))
    }
    expect(scoreAsks[0]?.tier).toBe('accurate')
    expect(scoreAsks[0]?.questions[0]?.kind).toBe('score')
  })

  it('sends one ask when the whole span fits in one chunk', async () => {
    const under = bench({ maxRescues: 64, maxSegmentsPerCall: 64 })
    under.judgment.defaultScore = { score: 5, confidence: 1 }
    const session = toolConversation()
    await select(under, session)

    expect(under.judgment.asksOfKind('score')).toHaveLength(1)
    expect(under.judgment.asks[0]?.questions).toHaveLength(selection(session).segments.length)
  })

  it('honors the configured tier on every ask', async () => {
    const under = bench({ maxRescues: 64, tier: 'fast' })
    under.judgment.defaultScore = { score: 5, confidence: 1 }
    await select(under, toolConversation())

    expect(under.judgment.asks).not.toHaveLength(0)
    expect(under.judgment.asks.every(input => input.tier === 'fast')).toBe(true)
    expect(under.judgment.asks.every(input => input.consumer === 'compaction-jev')).toBe(true)
  })
})

describe('semantic selection: scoring and the rescue boundaries', () => {
  it('rescues a segment at exactly the score and confidence floors', async () => {
    const under = bench({ maxRescues: 8, rescueScore: 3, segmentConfidence: 0.6 })
    const session = conversation(4)
    const base = baseSpan(under, session)
    const nodes = spanNodes(session, base)
    const first = nodes[0]
    const second = nodes[1]
    if (first === undefined || second === undefined) throw new Error('fixture: the span is too short')
    under.judgment.scores.set(segmentQuestion(first, first), { score: 3, confidence: 0.6 })
    under.judgment.scores.set(segmentQuestion(second, second), { score: 4, confidence: 1 })

    await select(under, session)

    const facts = selection(session).segments
    expect(facts[0]).toMatchObject({ startSeq: first, endSeq: first, score: 3, confidence: 0.6, disposition: 'rescued' })
    expect(facts[1]).toMatchObject({ startSeq: second, endSeq: second, score: 4, confidence: 1, disposition: 'rescued' })
  })

  it('drops a segment one step below the score floor and one below the confidence floor', async () => {
    const under = bench({ maxRescues: 8, rescueScore: 3, segmentConfidence: 0.6 })
    const session = conversation(4)
    const base = baseSpan(under, session)
    const nodes = spanNodes(session, base)
    const first = nodes[0]
    const second = nodes[1]
    if (first === undefined || second === undefined) throw new Error('fixture: the span is too short')
    const third = nodes[2]
    if (third === undefined) throw new Error('fixture: the span is too short')
    under.judgment.scores.set(segmentQuestion(first, first), { score: 2.99, confidence: 1 })
    under.judgment.scores.set(segmentQuestion(second, second), { score: 5, confidence: 0.59 })
    under.judgment.scores.set(segmentQuestion(third, third), { score: 5, confidence: 1 })

    expect(await select(under, session)).toEqual({ start: third, end: third })

    const facts = selection(session).segments
    expect(facts[0]).toMatchObject({ score: 2.99, disposition: 'dropped' })
    expect(facts[1]).toMatchObject({ score: 5, confidence: 0.59, disposition: 'dropped' })
    expect(facts[2]).toMatchObject({ score: 5, confidence: 1, disposition: 'rescued' })
  })

  it('treats an unanswered score question as unscored', async () => {
    const under = bench({ maxRescues: 8, rescueScore: 3 })
    const session = conversation(4)
    const base = baseSpan(under, session)
    const first = spanNodes(session, base)[0]
    if (first === undefined) throw new Error('fixture: the span is too short')
    under.judgment.defaultScore = { score: 5, confidence: 1 }
    under.judgment.omitted.add(segmentQuestion(first, first))

    await select(under, session)

    expect(selection(session).segments[0]).toMatchObject({ startSeq: first, disposition: 'unscored' })
    expect(selection(session).segments[0]).not.toHaveProperty('score')
    expect(selection(session).segments[1]?.disposition).toBe('rescued')
  })

  it('reports the engine, model, and accumulated latency the asks produced', async () => {
    const under = bench({ maxRescues: 64, rescueScore: 3, maxSegmentsPerCall: 64 })
    under.judgment.defaultScore = { score: 5, confidence: 1 }
    const session = conversation(4)
    await select(under, session)

    expect(selection(session)).toMatchObject({
      engine: 'scripted-judgment',
      model: 'scripted-1',
      latencyMs: under.judgment.asks.length * 3,
    })
    // One score ask for the chunk plus one hazard ask per sub-span edge.
    expect(under.judgment.asks).toHaveLength(3)
  })

  it('degrades to the inherited span when every score is below confidence', async () => {
    const under = bench({ maxRescues: 8, rescueScore: 3, segmentConfidence: 0.6 })
    under.judgment.defaultScore = { score: 5, confidence: 0.1 }
    const session = conversation(4)
    const base = baseSpan(under, session)

    expect(await select(under, session)).toEqual(base)
    expect(selection(session)).toMatchObject({ degraded: true, reason: 'below-confidence', segments: [], boundaryAdjustments: [] })
  })
})

describe('semantic selection: the attempt loop', () => {
  it('returns the committed sub-spans when the reduced surface clears the pressure', async () => {
    const WINDOW = 2_000
    const ctx = createContext(WINDOW)
    const session = longConversation()
    const priced = ctx.tokenMeter.measure(session)
    const inherited = selectCompactableRange(session, priced, 0)
    if (inherited === null) throw new Error('fixture: the session has no compactable span')
    const segments = segmentsOf(session, inherited)
    const head = segments[0]
    // The head-most segment is skipped so the tail run stays non-contiguous with
    // it and the two become separate sub-spans.
    const tail = segments.slice(2)
    if (head === undefined || tail.length === 0) throw new Error('fixture: the span is too short')
    // The tail run merges into one sub-span whose reduction alone clears the
    // threshold the head-most sub-span would have to cover otherwise.
    const tailSeqs = spanNodes(session, { start: tail[0]?.startSeq ?? 0, end: tail.at(-1)?.endSeq ?? 0 })
    const tailTokens = tailSeqs
      .reduce((total, seq) => total + (priced.nodes[session.surface.nodes.indexOf(seq)]?.tokens ?? 0), 0)
    const total = priced.surfaceTokens + priced.headerTokens
    const under = bench({
      thresholdRatio: (total - tailTokens / 2) / WINDOW,
      retainTokens: 0,
      maxPointers: 0,
      maxRescues: 64,
      rescueScore: 3,
    }, ctx)
    // Only the head segment and the tail run are load-bearing; the segment
    // between them is dropped, which is what keeps the two runs apart.
    under.judgment.defaultScore = { score: 0, confidence: 1 }
    for (const segment of [head, ...tail]) {
      under.judgment.scores.set(segmentQuestion(segment.startSeq, segment.endSeq), { score: 5, confidence: 1 })
    }

    await compactIfNeeded(under.engine, session)

    // The tail-most sub-span's own compaction cleared the pressure, so the
    // queued head-most one was abandoned rather than driven.
    const summaries = summaryEvents(session)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.shadowedSeqs).toEqual(tailSeqs)
    expect(selectionEvents(session)[0]?.trigger).toBe('pressure')
  })

  it('carries the turn signal into every judgment ask of the attempt', async () => {
    const under = bench({ maxRescues: 64, maxPointers: 0, retainTokens: 0 })
    under.judgment.defaultScore = { score: 5, confidence: 1 }
    const session = conversation(4, 'x'.repeat(600))

    // The overflow trigger bypasses the threshold, so one forced reduction
    // carries every selection ask of the attempt.
    await compactIfNeeded(under.engine, session, 'context-overflow')

    expect(under.judgment.asks.some(input => input.questions[0]?.kind === 'score')).toBe(true)
    expect(under.judgment.asks.some(input => input.questions[0]?.kind === 'binary')).toBe(true)
    expect(under.judgment.asks.every(input => input.signal === SIGNAL)).toBe(true)
  })

  it('degrades when the boundary ask itself fails', async () => {
    // One score ask, so the second ask is the first hazard question.
    const under = bench({ maxRescues: 8, rescueScore: 3, maxSegmentsPerCall: 64 })
    const session = conversation(4)
    const base = baseSpan(under, session)
    const target = spanNodes(session, base)[0]
    if (target === undefined) throw new Error('fixture: the span is too short')
    under.judgment.scores.set(segmentQuestion(target, target), { score: 5, confidence: 1 })
    // The score ask answers; the first boundary ask is the one that fails.
    under.judgment.failure = Object.assign(new Error('the engine refused'), { code: 'UNAVAILABLE' })
    under.judgment.failingAsks.add(2)

    expect(await select(under, session)).toEqual(base)
    expect(selection(session)).toMatchObject({ degraded: true, reason: 'engine-unavailable' })
  })

  it('degrades when a boundary answer cannot be used', async () => {
    const under = bench({ maxRescues: 8, rescueScore: 3 })
    const session = conversation(4)
    const base = baseSpan(under, session)
    const target = spanNodes(session, base)[0]
    if (target === undefined) throw new Error('fixture: the span is too short')
    under.judgment.scores.set(segmentQuestion(target, target), { score: 5, confidence: 1 })
    under.judgment.omitted.add(boundaryQuestion('start', target))

    expect(await select(under, session)).toEqual(base)
    expect(selection(session)).toMatchObject({ degraded: true, reason: 'invalid-answer' })
  })
})

describe('semantic selection: the rescue budget', () => {
  it('caps rescues at maxRescues in surface order', async () => {
    const under = bench({ maxRescues: 1, rescueScore: 3 })
    under.judgment.defaultScore = { score: 4, confidence: 0.9 }
    const session = conversation(4)
    const base = baseSpan(under, session)

    const span = await select(under, session)

    const facts = selection(session).segments
    expect(facts.map(fact => fact.disposition)).toEqual(['rescued', ...facts.slice(1).map(() => 'dropped')])
    expect(span).toEqual({ start: base.start, end: base.start })
  })

  it('merges contiguous rescued segments and keeps non-contiguous ones apart', async () => {
    const merged = bench({ maxRescues: 64, rescueScore: 3 })
    merged.judgment.defaultScore = { score: 4, confidence: 0.9 }
    const mergedSession = conversation(4)
    const mergedBase = baseSpan(merged, mergedSession)

    // Every segment is rescued: they tile the span, so they merge into one sub-span.
    expect(await select(merged, mergedSession)).toEqual(mergedBase)

    const split = bench({ maxRescues: 2, rescueScore: 3 })
    const splitSession = conversation(4)
    const splitBase = baseSpan(split, splitSession)
    const splitNodes = spanNodes(splitSession, splitBase)
    const head = splitNodes[0]
    const away = splitNodes[3]
    if (head === undefined || away === undefined) throw new Error('fixture: the span is too short')
    split.judgment.scores.set(segmentQuestion(head, head), { score: 5, confidence: 1 })
    split.judgment.scores.set(segmentQuestion(away, away), { score: 5, confidence: 1 })

    expect(await select(split, splitSession)).toEqual({ start: away, end: away })
    // The head-most sub-span stays queued for the next selection of this attempt,
    // and draining the queue re-decides nothing.
    expect(await select(split, splitSession)).toEqual({ start: head, end: head })
    expect(selectionEvents(splitSession)).toHaveLength(1)
    expect(splitBase.start).toBe(head)
  })

  it('caps rescues and keeps non-contiguous sub-spans apart in one decision', async () => {
    const under = bench({ maxRescues: 2, rescueScore: 3 })
    const session = conversation(4)
    const base = baseSpan(under, session)
    const nodes = spanNodes(session, base)
    const head = nodes[0]
    const away = nodes[3]
    const tail = nodes.at(-1)
    if (head === undefined || away === undefined || tail === undefined) throw new Error('fixture: the span is too short')
    for (const seq of [head, away, tail]) {
      under.judgment.scores.set(segmentQuestion(seq, seq), { score: 5, confidence: 1 })
    }

    const first = await select(under, session)

    // Surface order rescues the head-most two; the third is refused by the budget.
    expect(selection(session).segments.filter(fact => fact.disposition === 'rescued')).toHaveLength(2)
    expect(first).toEqual({ start: away, end: away })
    expect(await select(under, session)).toEqual({ start: head, end: head })
  })

  it('queues no sub-span when the plan degrades', async () => {
    const under = bench({ maxRescues: 8, rescueScore: 3 })
    const session = conversation(4)
    const base = baseSpan(under, session)

    // No answer clears the gate, so each selection re-decides from the surface.
    expect(await select(under, session)).toEqual(base)
    expect(await select(under, session)).toEqual(base)

    const events = selectionEvents(session)
    expect(events).toHaveLength(2)
    expect(events.every(event => event.degraded && event.reason === 'below-confidence')).toBe(true)
  })

  it('queues no sub-span when scoring is skipped', async () => {
    const under = bench({ maxRescues: 0 })
    const session = conversation(4)
    const base = baseSpan(under, session)

    expect(await select(under, session)).toEqual(base)
    expect(await select(under, session)).toEqual(base)

    const events = selectionEvents(session)
    expect(events).toHaveLength(2)
    // The skip is not a degradation: both decisions record unscored facts and no ask ran.
    expect(events.every(event => !event.degraded)).toBe(true)
    expect(events.every(event => event.reason === undefined)).toBe(true)
    expect(under.judgment.asks).toHaveLength(0)
  })

  it('skips scoring entirely when maxRescues is 0 and records unscored segments', async () => {
    const under = bench({ maxRescues: 0 })
    const session = conversation(4)
    const base = baseSpan(under, session)

    expect(await select(under, session)).toEqual(base)

    expect(under.judgment.asks).toHaveLength(0)
    const event = selection(session)
    expect(event.segments).not.toHaveLength(0)
    expect(event.segments.every(fact => fact.disposition === 'unscored')).toBe(true)
    expect(event.segments.every(fact => fact.score === undefined && fact.confidence === undefined)).toBe(true)
    expect(event.degraded).toBe(false)
    expect(event).not.toHaveProperty('engine')
    expect(event).not.toHaveProperty('latencyMs')
  })
})

describe('semantic selection: sub-span order and abandonment', () => {
  it('compacts sub-spans tail-most-first', async () => {
    const under = bench({ maxRescues: 2, rescueScore: 3 })
    const session = longConversation()
    const base = baseSpan(under, session, 0)
    const nodes = spanNodes(session, base)
    const head = nodes[0]
    const away = nodes[2]
    const tail = nodes.at(-1)
    if (head === undefined || away === undefined || tail === undefined) throw new Error('fixture: the span is too short')
    under.judgment.scores.set(segmentQuestion(head, head), { score: 5, confidence: 1 })
    under.judgment.scores.set(segmentQuestion(away, away), { score: 5, confidence: 1 })

    // The overflow trigger bypasses the threshold, so every queued sub-span is
    // driven through its own durable transaction in one attempt.
    await compactIfNeeded(under.engine, session, 'context-overflow')

    const summaries = summaryEvents(session)
    expect(summaries).toHaveLength(2)
    expect(summaries[0]?.shadowedSeqs).toEqual([away])
    expect(summaries[1]?.shadowedSeqs).toEqual([head])
    expect(tail).toBeGreaterThan(away)
    expect(selectionEvents(session)[0]?.trigger).toBe('context-overflow')
  })

  it('abandons the remaining sub-spans when one fails, keeping the committed ones', async () => {
    const under = bench({ maxRescues: 2, rescueScore: 3 })
    const session = longConversation()
    const base = baseSpan(under, session)
    const nodes = spanNodes(session, base)
    const head = nodes[0]
    const away = nodes[2]
    if (head === undefined || away === undefined) throw new Error('fixture: the span is too short')
    under.judgment.scores.set(segmentQuestion(head, head), { score: 5, confidence: 1 })
    under.judgment.scores.set(segmentQuestion(away, away), { score: 5, confidence: 1 })
    under.engine.summarizer.failingCalls.add(2)

    // The pressure driver: the retry that carries the queued sub-span is the one
    // whose summarization fails, and the failure abandons the rest.
    await expect(compactIfNeeded(under.engine, session)).rejects.toThrow('scripted summarization failure')

    const summaries = summaryEvents(session)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.shadowedSeqs).toEqual([away])
    // The tail-most sub-span is committed; the head-most one failed and closed with an error.
    const ends = session.events.filter(event => event.type === 'compaction/end')
    expect(ends).toHaveLength(2)
    expect(ends[0]?.data).not.toHaveProperty('error')
    expect(ends[1]?.data).toMatchObject({ error: 'scripted summarization failure' })
  })

  it('keeps every sub-span edge tool-pairing balanced after an outward move', async () => {
    const under = bench({ maxRescues: 2, rescueScore: 3, maxBoundaryAdjustment: 2 })
    const session = toolConversation()
    const base = baseSpan(under, session)
    const segments = segmentsOf(session, base)
    const headMost = segments[2]
    const tailMost = segments[4]
    if (headMost === undefined || tailMost === undefined) throw new Error('fixture: the span is too short')
    for (const segment of [headMost, tailMost]) {
      under.judgment.scores.set(segmentQuestion(segment.startSeq, segment.endSeq), { score: 5, confidence: 1 })
    }
    // A hazard on every edge: each one moves outward, and the one-step candidate
    // is unbalanced, so the move lands on the two-step legal boundary.
    under.judgment.defaultProbability = 0.9

    const first = await select(under, session)
    const second = await select(under, session)

    const tailSpan = { start: 12, end: 22 }
    const headSpan = { start: 4, end: 14 }
    expect(first).toEqual(tailSpan)
    expect(second).toEqual(headSpan)
    // One decision judges both sub-spans' edges, in surface order.
    expect(selectionEvents(session)[0]?.boundaryAdjustments).toEqual([
      { edge: 'start', fromSeq: headMost.startSeq, toSeq: headSpan.start, probability: 0.9 },
      { edge: 'end', fromSeq: headMost.endSeq, toSeq: headSpan.end, probability: 0.9 },
      { edge: 'start', fromSeq: tailMost.startSeq, toSeq: tailSpan.start, probability: 0.9 },
      { edge: 'end', fromSeq: tailMost.endSeq, toSeq: tailSpan.end, probability: 0.9 },
    ])
    for (const span of [tailSpan, headSpan]) {
      expect(toolPairingBalancedBefore(session, span.start)).toBe(true)
      expect(toolPairingBalancedAfter(session, span.end)).toBe(true)
    }
  })
})

describe('semantic selection: boundary judgment', () => {
  /** One tool conversation whose span start sits two nodes from a legal outward boundary. */
  function boundaryBench(cap = 2): Bench {
    return bench({ maxRescues: 8, rescueScore: 3, maxBoundaryAdjustment: cap })
  }

  it('treats a probability at exactly the threshold as unsafe', async () => {
    const under = boundaryBench()
    const session = toolConversation()
    const base = baseSpan(under, session)
    const nodes = spanNodes(session, base)
    const target = nodes[3]
    if (target === undefined) throw new Error('fixture: the span is too short')
    under.judgment.scores.set(segmentQuestion(target, target), { score: 5, confidence: 1 })
    under.judgment.probabilities.set(boundaryQuestion('start', target), 0.4)

    await select(under, session)

    expect(selection(session).boundaryAdjustments).toEqual([
      { edge: 'start', fromSeq: target, toSeq: nodes[1], probability: 0.4 },
    ])
  })

  it('treats a probability at exactly the band floor as unsafe', async () => {
    const under = boundaryBench()
    const session = toolConversation()
    const base = baseSpan(under, session)
    const nodes = spanNodes(session, base)
    const target = nodes[3]
    if (target === undefined) throw new Error('fixture: the span is too short')
    under.judgment.scores.set(segmentQuestion(target, target), { score: 5, confidence: 1 })
    under.judgment.probabilities.set(boundaryQuestion('start', target), 0.25)

    await select(under, session)

    expect(selection(session).boundaryAdjustments).toEqual([
      { edge: 'start', fromSeq: target, toSeq: nodes[1], probability: 0.25 },
    ])
  })

  it('treats a probability just below the band as safe', async () => {
    const under = boundaryBench()
    const session = toolConversation()
    const base = baseSpan(under, session)
    const target = spanNodes(session, base)[3]
    if (target === undefined) throw new Error('fixture: the span is too short')
    under.judgment.scores.set(segmentQuestion(target, target), { score: 5, confidence: 1 })
    under.judgment.probabilities.set(boundaryQuestion('start', target), 0.24)

    const span = await select(under, session)

    expect(selection(session).boundaryAdjustments).toEqual([])
    expect(span).toEqual({ start: target, end: target })
  })

  it('moves an unsafe edge outward to the nearest legal boundary within the cap', async () => {
    const under = bench({ maxRescues: 8, rescueScore: 3, maxBoundaryAdjustment: 2 })
    const session = toolConversation()
    const base = baseSpan(under, session)
    const nodes = spanNodes(session, base)
    const target = nodes[3]
    const illegal = nodes[2]
    const legal = nodes[1]
    if (target === undefined || illegal === undefined || legal === undefined) throw new Error('fixture: the span is too short')
    // The one-step candidate is not a legal boundary; the two-step one is.
    expect(toolPairingBalancedBefore(session, illegal)).toBe(false)
    expect(toolPairingBalancedBefore(session, legal)).toBe(true)
    under.judgment.scores.set(segmentQuestion(target, target), { score: 5, confidence: 1 })
    under.judgment.probabilities.set(boundaryQuestion('start', target), 0.9)

    const span = await select(under, session)

    expect(selection(session).boundaryAdjustments).toEqual([
      { edge: 'start', fromSeq: target, toSeq: legal, probability: 0.9 },
    ])
    expect(span).toEqual({ start: legal, end: target })
  })

  it('moves an unsafe end edge outward as well', async () => {
    const under = bench({ maxRescues: 8, rescueScore: 3, maxBoundaryAdjustment: 2 })
    const session = conversation(4)
    const base = baseSpan(under, session)
    const nodes = spanNodes(session, base)
    const target = nodes[1]
    const legal = nodes[2]
    if (target === undefined || legal === undefined) throw new Error('fixture: the span is too short')
    under.judgment.scores.set(segmentQuestion(target, target), { score: 5, confidence: 1 })
    under.judgment.probabilities.set(boundaryQuestion('end', target), 0.75)

    const span = await select(under, session)

    expect(selection(session).boundaryAdjustments).toEqual([
      { edge: 'end', fromSeq: target, toSeq: legal, probability: 0.75 },
    ])
    expect(span).toEqual({ start: target, end: legal })
  })

  it('leaves the span unchanged when no legal boundary sits within the cap', async () => {
    const under = bench({ maxRescues: 8, rescueScore: 3, maxBoundaryAdjustment: 1 })
    const session = conversation(4)
    const base = baseSpan(under, session)
    const target = base.start
    // The span starts at the surface head, so an outward start move has nowhere to go.
    expect(session.surface.nodes[0]).toBe(target)
    under.judgment.scores.set(segmentQuestion(target, target), { score: 5, confidence: 1 })
    under.judgment.probabilities.set(boundaryQuestion('start', target), 0.9)

    const span = await select(under, session)

    expect(selection(session).boundaryAdjustments).toEqual([])
    expect(span).toEqual({ start: target, end: target })
  })

  it('leaves an edge with no legal candidate within the cap unchanged', async () => {
    const under = bench({ maxRescues: 8, rescueScore: 3, maxBoundaryAdjustment: 1 })
    const session = openToolCallConversation()
    const base = baseSpan(under, session)
    const target = base.start
    // The only outward end candidate holds an unanswered tool call, so it is not
    // a legal boundary and the one-step cap cannot reach another one.
    const candidate = session.surface.nodes[1]
    if (candidate === undefined) throw new Error('fixture: the session is too short')
    expect(toolPairingBalancedAfter(session, candidate)).toBe(false)
    under.judgment.scores.set(segmentQuestion(target, target), { score: 5, confidence: 1 })
    under.judgment.probabilities.set(boundaryQuestion('end', target), 0.9)

    const span = await select(under, session)

    expect(selection(session).boundaryAdjustments).toEqual([])
    expect(span).toEqual({ start: target, end: target })
  })

  it('asks one hazard question per sub-span edge and records the latency', async () => {
    const under = bench({ maxRescues: 8, rescueScore: 3, maxSegmentsPerCall: 64 })
    const session = conversation(4)
    const base = baseSpan(under, session)
    const target = spanNodes(session, base)[0]
    if (target === undefined) throw new Error('fixture: the span is too short')
    under.judgment.scores.set(segmentQuestion(target, target), { score: 5, confidence: 1 })

    await select(under, session)

    const boundaryAsks = under.judgment.asksOfKind('binary')
    expect(boundaryAsks).toHaveLength(2)
    expect(boundaryAsks.map(input => input.questions.map(question => question.id))).toEqual([
      [boundaryQuestion('start', target)],
      [boundaryQuestion('end', target)],
    ])
    expect(selection(session).latencyMs).toBe(9)
  })

  it('degrades when the boundary ask fails', async () => {
    const under = bench({ maxRescues: 8, rescueScore: 3 })
    const session = conversation(4)
    const base = baseSpan(under, session)
    const target = spanNodes(session, base)[0]
    if (target === undefined) throw new Error('fixture: the span is too short')
    under.judgment.scores.set(segmentQuestion(target, target), { score: 5, confidence: 1 })
    under.judgment.omitted.add(boundaryQuestion('start', target))

    expect(await select(under, session)).toEqual(base)
    expect(selection(session).degraded).toBe(true)
  })
})
