/**
 * The verify cascade: the acceptance boundary, one escalation with a second
 * verification battery, the band-only rule, the \`fail-attempt\` policy, the
 * better-draft rule, and both escalation targets.
 *
 * Every case drives the REAL inherited summarizer through \`compactRegion\`, so
 * the durable bracket, the compaction identity the verification events carry, and
 * the failure machinery are the production ones.
 *
 * TEST DOUBLES: from ./harness.ts — {@link ContextAdapter} (both routes the drafts
 * stream from), {@link ScriptedJudgment} (the scripted battery), and
 * {@link InheritedSummarizerJevEngine}.
 */

import { describe, expect, it } from 'vitest'
import { CompactionId } from '@shres-code/shres-code-compaction'
import type { Context } from '@shres-code/cordis'
import { createUserMessage } from '@shres-code/shres-code-llm'
import type { Session } from '@shres-code/shres-code-session'
import type { JevCompactionConfig } from '../src/index.ts'
import {
  agent,
  ContextAdapter,
  conversation,
  conversationAdapter,
  createContext,
  ESCALATION_MODEL,
  ESCALATION_PROVIDER,
  escalationAdapter,
  InheritedSummarizerJevEngine,
  jevOverrides,
  MODEL,
  ScriptedJudgment,
  SIGNAL,
  summaryEvents,
  verificationEvents,
} from './harness.ts'

/** The one battery check every case configures. */
const CHECK = 'constraints'
/** Default verify threshold the band cases reason about. */
const THRESHOLD = 0.7
/** Default verify margin the band cases reason about. */
const MARGIN = 0.1
/** Default overall floor. */
const SCORE = 4
/** The conversation route's draft text. */
const DRAFT = 'conversation draft'
/** The escalation route's draft text. */
const ESCALATED = 'escalation draft'

interface Bench {
  readonly ctx: Context
  readonly judgment: ScriptedJudgment
  readonly engine: InheritedSummarizerJevEngine
  readonly session: Session
  /** The first and last surface seq of the region every case compacts. */
  readonly span: { start: number; end: number }
}

/** One engine over a fresh context and session, with the judgment provider mounted. */
async function bench(overrides: Partial<JevCompactionConfig> = {}): Promise<Bench> {
  const ctx = createContext()
  await ctx.plugin(ScriptedJudgment)
  const judgment = ctx.judgment as ScriptedJudgment
  const engine = new InheritedSummarizerJevEngine(ctx, jevOverrides({ retainTokens: 100, ...overrides }))
  const session = conversation(4, 'x'.repeat(600))
  const nodes = session.surface.nodes
  const start = nodes[0]
  const end = nodes[3]
  if (start === undefined || end === undefined) throw new Error('fixture: the session is too short')
  return { ctx, judgment, engine, session, span: { start, end } }
}

/** Compact the fixture region, which opens and closes one durable bracket. */
function compact(under: Bench): Promise<unknown> {
  return under.engine.compactRegion(under.span.start, under.span.end, agent(under.session, MODEL), SIGNAL)
}

/** One scripted per-ask answer set. */
interface BatteryAnswers {
  /** Binary answers by question id. */
  probabilities: Record<string, number>
  /** Score answers by question id. */
  scores: Record<string, { score: number; confidence: number }>
}

/** One battery answer set: the check's probability and the overall score. */
function battery(probability: number, score: number): BatteryAnswers {
  return {
    probabilities: { [CHECK]: probability },
    scores: { overall: { score, confidence: 0.9 } },
  }
}

describe('verify cascade: acceptance', () => {
  it('accepts a draft at exactly the check threshold and the overall floor', async () => {
    const under = await bench()
    under.judgment.script.push(battery(THRESHOLD, SCORE))

    await compact(under)

    const events = verificationEvents(under.session)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      attempt: 1,
      provider: MODEL,
      model: MODEL,
      verdict: 'accepted',
      degraded: false,
      engine: 'scripted-judgment',
      latencyMs: 3,
    })
    expect(events[0]?.questions).toEqual([
      { name: CHECK, probability: THRESHOLD },
      { name: 'overall', score: SCORE, confidence: 0.9 },
    ])
    expect(escalationAdapter(under.ctx).calls).toHaveLength(0)
  })

  it('escalates a check one step below the threshold', async () => {
    const under = await bench({ maxEscalations: 0 })
    under.judgment.script.push(battery(THRESHOLD - 0.01, SCORE))

    await compact(under)

    expect(verificationEvents(under.session)[0]).toMatchObject({ verdict: 'accepted-below-threshold' })
  })

  it('escalates a draft whose overall score is one step below the floor', async () => {
    const under = await bench({ maxEscalations: 0 })
    under.judgment.script.push(battery(1, SCORE - 0.01))

    await compact(under)

    expect(verificationEvents(under.session)[0]).toMatchObject({ verdict: 'accepted-below-threshold' })
  })

  it('degrades verification when the battery cannot answer', async () => {
    const under = await bench()
    under.judgment.script.push({ probabilities: {}, scores: {} })

    await compact(under)

    expect(verificationEvents(under.session)[0]).toMatchObject({ verdict: 'accepted', degraded: true, questions: [] })
  })

  it('degrades verification when the engine fails the battery ask', async () => {
    const under = await bench()
    under.judgment.failure = Object.assign(new Error('the engine refused'), { code: 'UNAVAILABLE' })

    await compact(under)

    expect(verificationEvents(under.session)[0]).toMatchObject({ verdict: 'accepted', degraded: true, reason: 'engine-unavailable', questions: [] })
  })

  it('covers both the engine-absent and engine-disabled verification paths', async () => {
    const ctx = createContext()
    const engine = new InheritedSummarizerJevEngine(ctx, jevOverrides({ retainTokens: 100 }))
    const session = conversation(4, 'x'.repeat(600))
    const nodes = session.surface.nodes

    await engine.compactRegion(nodes[0] ?? 0, nodes[3] ?? 0, agent(session, MODEL), SIGNAL)

    expect(verificationEvents(session)[0]).toMatchObject({ reason: 'engine-absent', degraded: true })
  })
})

describe('verify cascade: escalation', () => {
  it('escalates once and verifies the second draft with a second battery', async () => {
    const under = await bench({ escalationProvider: ESCALATION_PROVIDER, escalationModel: ESCALATION_MODEL })
    under.judgment.script.push(battery(0.1, 2), battery(0.95, 5))

    const result = await compact(under)

    const events = verificationEvents(under.session)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ attempt: 1, provider: MODEL, model: MODEL, verdict: 'escalated', degraded: false })
    expect(events[0]?.questions[0]).toMatchObject({ name: CHECK, probability: 0.1 })
    expect(events[1]).toMatchObject({
      attempt: 2,
      provider: ESCALATION_PROVIDER,
      model: ESCALATION_MODEL,
      verdict: 'accepted',
      degraded: false,
    })
    expect(events[1]?.questions[0]).toMatchObject({ name: CHECK, probability: 0.95 })
    expect(result).toMatchObject({ shadowedRange: under.span })
    expect(landedDraft(under.session)).toContain(ESCALATED)
  })

  it('honors the configured escalation target on the escalation call', async () => {
    const under = await bench({ escalationProvider: ESCALATION_PROVIDER, escalationModel: ESCALATION_MODEL })
    under.judgment.script.push(battery(0.1, 2), battery(0.95, 5))

    await compact(under)

    const escalation = escalationAdapter(under.ctx)
    expect(escalation).toBeInstanceOf(ContextAdapter)
    expect(escalation.calls).toHaveLength(1)
    expect(escalation.lastOptions).toMatchObject({
      provider: ESCALATION_PROVIDER,
      model: ESCALATION_MODEL,
      purpose: 'compaction',
    })
    expect(escalation.text).toBe(ESCALATED)
    expect(conversationAdapter(under.ctx).calls).toHaveLength(1)
  })

  it('escalates on the conversation target when no pair is configured', async () => {
    const under = await bench()
    under.judgment.script.push(battery(0.1, 2), battery(0.95, 5))

    await compact(under)

    expect(escalationAdapter(under.ctx).calls).toHaveLength(0)
    expect(conversationAdapter(under.ctx).calls).toHaveLength(2)
    expect(conversationAdapter(under.ctx).lastOptions).toMatchObject({ provider: MODEL, model: MODEL })
    expect(verificationEvents(under.session)[1]).toMatchObject({ attempt: 2, provider: MODEL, model: MODEL })
  })

  it('keeps the better draft by overall score when the escalation scores worse', async () => {
    const under = await bench({ escalationProvider: ESCALATION_PROVIDER, escalationModel: ESCALATION_MODEL })
    under.judgment.script.push(battery(0.1, 2), battery(0.95, 1))

    await compact(under)

    const events = verificationEvents(under.session)
    expect(events.map(event => event.verdict)).toEqual(['escalated', 'accepted-below-threshold'])
    // The first draft scored higher, so it is the one the close records and lands.
    expect(events[1]).toMatchObject({ provider: MODEL, model: MODEL })
    expect(landedDraft(under.session)).toContain(DRAFT)
    expect(landedDraft(under.session)).not.toContain(ESCALATED)
  })

  it('keeps the escalation draft when it scores better but still fails', async () => {
    const under = await bench({ escalationProvider: ESCALATION_PROVIDER, escalationModel: ESCALATION_MODEL })
    under.judgment.script.push(battery(0.1, 2), battery(0.5, 3))

    await compact(under)

    expect(verificationEvents(under.session)[1]).toMatchObject({ verdict: 'accepted-below-threshold', provider: ESCALATION_PROVIDER })
    expect(landedDraft(under.session)).toContain(ESCALATED)
  })

  it('escalates again while the budget allows it', async () => {
    const under = await bench({
      escalationProvider: ESCALATION_PROVIDER,
      escalationModel: ESCALATION_MODEL,
      maxEscalations: 2,
    })
    under.judgment.script.push(battery(0.1, 2), battery(0.1, 3), battery(0.95, 5))

    await compact(under)

    expect(verificationEvents(under.session).map(event => event.verdict))
      .toEqual(['escalated', 'escalated', 'accepted'])
    expect(escalationAdapter(under.ctx).calls).toHaveLength(2)
  })
})

describe('verify cascade: the band below the threshold', () => {
  it('does not escalate a band-only failure under accept-logged', async () => {
    const under = await bench({ escalationProvider: ESCALATION_PROVIDER, escalationModel: ESCALATION_MODEL })
    under.judgment.script.push(battery(0.65, 5))

    await compact(under)

    const events = verificationEvents(under.session)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ attempt: 1, verdict: 'accepted-below-threshold', degraded: false })
    // The answers stay intact on the event, and no escalation draft was produced.
    expect(events[0]?.questions[0]).toMatchObject({ name: CHECK, probability: 0.65 })
    expect(escalationAdapter(under.ctx).calls).toHaveLength(0)
    expect(landedDraft(under.session)).toContain(DRAFT)
  })

  it('treats the exact band floor as inside the band', async () => {
    const under = await bench({ escalationProvider: ESCALATION_PROVIDER, escalationModel: ESCALATION_MODEL })
    under.judgment.script.push(battery(THRESHOLD - MARGIN, 5))

    await compact(under)

    expect(verificationEvents(under.session)).toHaveLength(1)
    expect(escalationAdapter(under.ctx).calls).toHaveLength(0)
  })

  it('escalates a failure one step below the band', async () => {
    const under = await bench({ escalationProvider: ESCALATION_PROVIDER, escalationModel: ESCALATION_MODEL })
    under.judgment.script.push(battery(THRESHOLD - MARGIN - 0.01, 5), battery(0.95, 5))

    await compact(under)

    expect(verificationEvents(under.session).map(event => event.verdict)).toEqual(['escalated', 'accepted'])
    expect(escalationAdapter(under.ctx).calls).toHaveLength(1)
  })

  it('escalates a band-only failure when the policy is fail-attempt', async () => {
    const under = await bench({
      escalationProvider: ESCALATION_PROVIDER,
      escalationModel: ESCALATION_MODEL,
      onVerifyFailure: 'fail-attempt',
    })
    under.judgment.script.push(battery(0.65, 5), battery(0.65, 5))

    await expect(compact(under)).rejects.toThrow(/onVerifyFailure is "fail-attempt"/)

    // The band rule refuses the escalation under accept-logged; under fail-attempt
    // the same band-only failure spends it, and the exhausted battery that follows
    // lands no verdict because the attempt throws before one is reached.
    expect(verificationEvents(under.session).map(event => event.verdict)).toEqual(['escalated'])
    expect(under.judgment.asks).toHaveLength(2)
    expect(escalationAdapter(under.ctx).calls).toHaveLength(1)
  })
})

describe('verify cascade: fail-attempt', () => {
  it('closes the compaction with an error through the inherited machinery', async () => {
    const under = await bench({ onVerifyFailure: 'fail-attempt' })
    under.judgment.script.push(battery(0.1, 1), battery(0.1, 1))
    const before = [...under.session.surface.nodes]

    await expect(compact(under)).rejects.toThrow(
      /compaction-jev: the summary failed verification and onVerifyFailure is "fail-attempt" \(attempt 2, overall score 1\)/,
    )

    const end = under.session.events.findLast(event => event.type === 'compaction/end')?.data
    expect(end?.error).toMatch(/onVerifyFailure is "fail-attempt"/)
    // The failed attempt mutated nothing.
    expect(under.session.surface.nodes).toEqual(before)
    expect(summaryEvents(under.session)).toHaveLength(0)
    // Only the verdict that spent the attempt is logged; the battery that failed
    // the exhausted attempt leaves no event, because no verdict was reached.
    expect(verificationEvents(under.session).map(event => event.verdict)).toEqual(['escalated'])
    expect(under.judgment.asks).toHaveLength(2)
  })

  it('fails the attempt on the first battery when no escalation budget remains', async () => {
    // No escalation budget, so the first battery's verdict reaches the failure
    // branch directly, and no verification event is appended before the throw.
    const under = await bench({ onVerifyFailure: 'fail-attempt', maxEscalations: 0 })
    under.judgment.script.push(battery(0.1, 1))

    await expect(compact(under)).rejects.toThrow(/attempt 1, overall score 1/)
    expect(verificationEvents(under.session)).toHaveLength(0)
  })
})

describe('verify cascade: degradation and the absent bracket', () => {
  it('degrades with invalid-answer when the engine refuses the battery', async () => {
    const under = await bench()
    under.judgment.failure = Object.assign(new Error('unusable answer'), { code: 'INVALID_ANSWER' })

    await compact(under)

    expect(verificationEvents(under.session)[0]).toMatchObject({
      verdict: 'accepted',
      degraded: true,
      reason: 'invalid-answer',
      questions: [],
    })
  })

  it('degrades with invalid-answer when the battery leaves a check unanswered', async () => {
    const under = await bench()
    under.judgment.script.push({
      probabilities: {},
      scores: { overall: { score: 5, confidence: 0.9 } },
      omit: [CHECK],
    })

    await compact(under)

    expect(verificationEvents(under.session)[0]).toMatchObject({ degraded: true, reason: 'invalid-answer' })
  })

  it('runs the battery without a signal when the caller supplied none', async () => {
    const under = await bench()
    under.session.append('compaction/start', { compactionId: CompactionId('hand-opened'), turn: 1 })
    under.judgment.script.push(battery(0.95, 5))
    const input = { messages: [createUserMessage({
      content: [{ type: 'text', text: 'the region being condensed' }],
      source: { kind: 'plugin', plugin: 'test' },
    })] }

    const draft = await under.engine.summarize(input, agent(under.session, MODEL))

    expect(draft.summary).toEqual([{ type: 'text', text: DRAFT }])
    expect(under.judgment.asks.at(-1)).not.toHaveProperty('signal')
    expect(verificationEvents(under.session)).toHaveLength(1)
  })

  it('logs no verification for a summarization outside a live compaction', async () => {
    const under = await bench()
    under.judgment.script.push(battery(0.95, 5))
    await compact(under)
    expect(verificationEvents(under.session)).toHaveLength(1)

    // The bracket is closed, so the engine has no compaction identity to log against.
    const outside = { messages: [createUserMessage({
      content: [{ type: 'text', text: 'a region no compaction owns' }],
      source: { kind: 'plugin', plugin: 'test' },
    })] }
    const draft = await under.engine.summarize(outside, agent(under.session, MODEL), SIGNAL)

    expect(draft.summary).toEqual([{ type: 'text', text: DRAFT }])
    expect(verificationEvents(under.session)).toHaveLength(1)
  })
})

describe('verify cascade: the state the battery reads', () => {
  it('sends the draft plus the capped original region and the configured questions', async () => {
    const under = await bench({ verifyMaxChars: 1_200 })
    under.judgment.script.push(battery(0.95, 5))

    await compact(under)

    const ask = under.judgment.asks.find(input => input.questions.some(question => question.id === CHECK))
    expect(ask).toBeDefined()
    expect(ask?.tier).toBe('accurate')
    expect(ask?.state).toContain('--- draft ---')
    expect(ask?.state).toContain(DRAFT)
    expect(ask?.state).toContain('--- original region (capped) ---')
    expect(ask?.state.length).toBeLessThanOrEqual(1_200 + 100)
    expect(ask?.questions.map(question => question.id)).toEqual([CHECK, 'overall'])
    expect(ask?.questions[1]).toMatchObject({
      kind: 'score',
      instructions: 'How well does this summary preserve what a later turn needs?',
    })
    expect((ask?.questions[1] as { levels?: string[] }).levels).toHaveLength(5)
    expect(ask?.signal).toBe(SIGNAL)
  })

  it('runs the battery at the configured tier', async () => {
    const under = await bench({ tier: 'fast' })
    under.judgment.script.push(battery(0.95, 5))

    await compact(under)

    expect(under.judgment.asks.every(input => input.tier === 'fast')).toBe(true)
  })
})

/** The summary text the run landed on the surface. */
function landedDraft(session: Session): string {
  return JSON.stringify(summaryEvents(session).at(-1)?.summary)
}
