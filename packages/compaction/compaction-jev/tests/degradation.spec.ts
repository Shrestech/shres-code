/**
 * The twin-run diff: for every degradation class, one Jev-backed run and one
 * plain compaction-basic run over an identical session must land the same
 * shadowed range, the same shadowed seqs, the same shadowed token count, and the
 * same summary — while the companion selection event records \`degraded: true\`
 * with the class.
 *
 * The engine here runs its REAL inherited summarizer (no override), so the
 * summary equality is a statement about the machinery both arms share and not
 * about a shared stub.
 *
 * TEST DOUBLES: from ./harness.ts — {@link ContextAdapter} (the adapter both
 * arms' summarizer routes through), {@link ScriptedJudgment} (the scripted
 * judgment provider), {@link MemorySettings} (the real settings provider, for the
 * deployment toggle), and the two engine doubles. The sessions are real and are
 * rebuilt identically for each arm.
 */

import { describe, expect, it } from 'vitest'
import BasicCompactionEngine from '@shres-code/shres-code-compaction-basic'
import type { Context } from '@shres-code/cordis'
import { JUDGMENT_SETTINGS_NAMESPACE, JudgmentError } from '@shres-code/shres-code-judgment'
import { isReplacementSurfaceEvent } from '@shres-code/shres-code-session'
import type { Session } from '@shres-code/shres-code-session'
import type { CompactionDegradationReason } from '../src/index.ts'
import type { JevCompactionConfig } from '../src/index.ts'
import {
  compactIfNeeded,
  ContextAdapter,
  conversation,
  conversationAdapter,
  createContext,
  InheritedSummarizerJevEngine,
  jevOverrides,
  MemorySettings,
  MODEL,
  ScriptedJudgment,
  selectionEvents,
  summaryEvents,
  verificationEvents,
} from './harness.ts'

/** The one battery check every case configures, used to spot a battery ask. */
const CHECK = 'constraints'

/** One degradation class under test. */
interface Case {
  /** Diagnostic label. */
  readonly name: string
  /** Class the companion selection event must record. */
  readonly reason: CompactionDegradationReason
  /** Mount a scripted judgment engine at all. */
  readonly mountEngine: boolean
  /** Turn judgment off through the real settings service. */
  readonly disabled?: boolean
  /** Failure every judgment ask rejects with. */
  readonly failure?: Error
  /** Answer every score below the confidence floor and no battery question. */
  readonly belowConfidence?: boolean
  /** Extra scripting for this case, applied after the fields above. */
  readonly configure?: (judgment: ScriptedJudgment) => void
}

const CASES: readonly Case[] = [
  { name: 'engine absent', reason: 'engine-absent', mountEngine: false },
  {
    name: 'engine composed and disabled',
    reason: 'engine-disabled',
    mountEngine: true,
    disabled: true,
  },
  {
    name: 'engine unavailable',
    reason: 'engine-unavailable',
    mountEngine: true,
    failure: new JudgmentError('UNAVAILABLE', 'the engine refused the ask'),
  },
  {
    name: 'invalid answer',
    reason: 'invalid-answer',
    mountEngine: true,
    failure: new JudgmentError('INVALID_ANSWER', 'the engine answered nothing usable'),
  },
  {
    name: 'answers below confidence',
    reason: 'below-confidence',
    mountEngine: true,
    belowConfidence: true,
  },
]

interface Arm {
  /** The shared result fields both arms must agree on. */
  readonly result: { shadowedRange: { start: number; end: number }; shadowedSeqs: number[]; shadowedTokenCount: number }
  /** The durable summary content the run landed. */
  readonly summary: string
  /** The session the arm ran over. */
  readonly session: Session
  /** The companion selection events the arm recorded. */
  readonly selections: ReturnType<typeof selectionEvents>
  /** The companion verification events the arm recorded. */
  readonly verifications: ReturnType<typeof verificationEvents>
  /** The judgment provider, when the arm mounted one. */
  readonly judgment: ScriptedJudgment | undefined
  /** The context the arm ran in. */
  readonly ctx: Context
}

/** Compose the case's judgment layer and drive one automatic compaction attempt. */
async function arm(under: Case, config: Partial<JevCompactionConfig> = {}): Promise<Arm> {
  const ctx = createContext()
  let judgment: ScriptedJudgment | undefined
  if (under.mountEngine) {
    if (under.disabled === true) await ctx.plugin(MemorySettings)
    // Mounted through the plugin registry, exactly as a provider is, so the
    // Definition's settings section is installed before the toggle is written.
    await ctx.plugin(ScriptedJudgment)
    judgment = ctx.judgment as ScriptedJudgment
    if (under.disabled === true) await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { enabled: false })
    if (under.failure !== undefined) judgment.failure = under.failure
    if (under.belowConfidence === true) {
      judgment.defaultScore = { score: 5, confidence: 0.1 }
      // No battery answer at all, so verification degrades instead of escalating.
      judgment.omitted.add('overall')
    }
    under.configure?.(judgment)
  }
  const engine = new InheritedSummarizerJevEngine(ctx, jevOverrides({
    retainTokens: 100,
    maxRescues: 2,
    rescueScore: 3,
    ...config,
  }))
  const session = conversation(4, 'x'.repeat(600))
  const result = await compactIfNeeded(engine, session)
  if (result === null) throw new Error(`${under.name}: the arm did not compact`)
  return {
    result,
    summary: landedSummary(session),
    session,
    selections: selectionEvents(session),
    verifications: verificationEvents(session),
    judgment,
    ctx,
  }
}

/** The twin: the same session and retention under the inherited engine alone. */
async function twin(under: Case): Promise<Arm> {
  const ctx = createContext()
  const engine = new BasicCompactionEngine(ctx, { auto: false, retainTokens: 100 })
  const session = conversation(4, 'x'.repeat(600))
  const result = await compactIfNeeded(engine, session)
  if (result === null) throw new Error(`${under.name}: the twin did not compact`)
  return {
    result,
    summary: landedSummary(session),
    session,
    selections: [],
    verifications: [],
    judgment: undefined,
    ctx,
  }
}

/** The exact summary text the run landed on the surface. */
function landedSummary(session: Session): string {
  return JSON.stringify(summaryEvents(session).at(-1)?.summary)
}

/** How many of each durable bracket event one session landed. */
function bracketCounts(session: Session): Record<string, number> {
  const types = session.events.map(event => event.type)
  return {
    start: types.filter(type => type === 'compaction/start').length,
    summary: types.filter(type => type === 'compaction/summary').length,
    end: types.filter(type => type === 'compaction/end').length,
    replacement: session.events.filter(event =>
      event.type === 'user/message' && isReplacementSurfaceEvent(event)).length,
  }
}

/** Whether one judgment ask was a verification battery ask rather than a selection ask. */
function isBatteryAsk(ask: { questions: readonly { id: string }[] }): boolean {
  return ask.questions.some(question => question.id === CHECK)
}

describe('degradation: the twin-run diff', () => {
  it('lands the identical durable outcome as the compaction-basic twin', async () => {
    for (const under of CASES) {
      const jev = await arm(under)
      const basic = await twin(under)
      const label = `${under.name}: `

      expect(basic.session.surface.nodes.length, `${label}surface`).toBe(jev.session.surface.nodes.length)
      expect(jev.result.shadowedRange, `${label}range`).toEqual(basic.result.shadowedRange)
      expect(jev.result.shadowedSeqs, `${label}seqs`).toEqual(basic.result.shadowedSeqs)
      expect(jev.result.shadowedTokenCount, `${label}tokens`).toBe(basic.result.shadowedTokenCount)
      expect(jev.summary, `${label}summary`).toBe(basic.summary)
      // The same durable bracket: one open, one summary, one close, one replacement.
      expect(bracketCounts(jev.session), `${label}bracket`).toEqual(bracketCounts(basic.session))
    }
  })

  it('records the degradation class on the companion selection event', async () => {
    for (const under of CASES) {
      const jev = await arm(under)
      const selection = jev.selections[0]

      expect(selection, `${under.name}: selection`).toBeDefined()
      expect(selection?.degraded, `${under.name}: degraded`).toBe(true)
      expect(selection?.reason, `${under.name}: reason`).toBe(under.reason)
      expect(selection?.segments, `${under.name}: segments`).toEqual([])
      expect(selection?.boundaryAdjustments, `${under.name}: adjustments`).toEqual([])
    }
  })

  it('pins the selection degradation reason matrix', async () => {
    const refused = new JudgmentError('UNAVAILABLE', 'the engine refused the ask')
    const unusable = new JudgmentError('INVALID_ANSWER', 'the engine answered nothing usable')
    /** One score ask per attempt, so the second ask is the first hazard question. */
    const oneChunk = { maxSegmentsPerCall: 64 }
    const rescuing = (judgment: ScriptedJudgment): void => {
      judgment.defaultScore = { score: 5, confidence: 1 }
    }
    const cases: Array<[string, Case, Partial<JevCompactionConfig>]> = [
      ['engine absent', { name: 'absent', reason: 'engine-absent', mountEngine: false }, oneChunk],
      ['judgment disabled', { name: 'disabled', reason: 'engine-disabled', mountEngine: true, disabled: true }, oneChunk],
      [
        'segment-scoring ask refused',
        {
          name: 'score refused',
          reason: 'engine-unavailable',
          mountEngine: true,
          configure: (judgment) => { judgment.failure = refused },
        },
        oneChunk,
      ],
      [
        'segment-scoring ask unusable',
        {
          name: 'score unusable',
          reason: 'invalid-answer',
          mountEngine: true,
          configure: (judgment) => { judgment.failure = unusable },
        },
        oneChunk,
      ],
      [
        'no score answer at all',
        { name: 'no scores', reason: 'below-confidence', mountEngine: true, configure: () => {} },
        oneChunk,
      ],
      [
        'every score below the gate',
        {
          name: 'low scores',
          reason: 'below-confidence',
          mountEngine: true,
          configure: (judgment) => { judgment.defaultScore = { score: 0, confidence: 1 } },
        },
        oneChunk,
      ],
      [
        'boundary ask refused',
        {
          name: 'boundary refused',
          reason: 'engine-unavailable',
          mountEngine: true,
          configure: (judgment) => {
            judgment.failure = refused
            judgment.failingAsks.add(2)
            rescuing(judgment)
          },
        },
        oneChunk,
      ],
      [
        'boundary ask unusable',
        {
          name: 'boundary unusable',
          reason: 'invalid-answer',
          mountEngine: true,
          configure: (judgment) => {
            judgment.failure = unusable
            judgment.failingAsks.add(2)
            rescuing(judgment)
          },
        },
        oneChunk,
      ],
    ]

    for (const [label, under, config] of cases) {
      const jev = await arm(under, config)
      expect(jev.selections, `${label}: selection count`).toHaveLength(1)
      expect(jev.selections[0]?.degraded, label).toBe(true)
      expect(jev.selections[0]?.reason, label).toBe(under.reason)
      // A failed plan never publishes partial segment facts.
      expect(jev.selections[0]?.segments, `${label}: segments`).toEqual([])
      expect(jev.selections[0]?.boundaryAdjustments, `${label}: adjustments`).toEqual([])
    }
  })

  it('records an INVALID_ANSWER-coded boundary ask as invalid-answer', async () => {
    const jev = await arm({
      name: 'boundary unusable',
      reason: 'invalid-answer',
      mountEngine: true,
      configure: (judgment) => {
        judgment.failure = new JudgmentError('INVALID_ANSWER', 'the engine answered nothing usable')
        judgment.failingAsks.add(2)
        judgment.defaultScore = { score: 5, confidence: 1 }
      },
    }, { maxSegmentsPerCall: 64 })

    // The boundary catch mirrors the scoring and battery catches.
    expect(jev.selections[0]?.reason).toBe('invalid-answer')
    expect(jev.selections[0]).toMatchObject({ degraded: true, segments: [], boundaryAdjustments: [] })
  })

  it('keeps below-confidence for the one case it describes', async () => {
    // Scoring ran, every answer was usable, and none met the rescue gate.
    const jev = await arm({
      name: 'low scores',
      reason: 'below-confidence',
      mountEngine: true,
      configure: (judgment) => { judgment.defaultScore = { score: 3, confidence: 0.59 } },
    })

    expect(jev.selections[0]).toMatchObject({ degraded: true, reason: 'below-confidence' })
  })

  it('costs no judgment call at all when no engine is composed', async () => {
    const absent = requireCase(0)
    const jev = await arm(absent)

    expect(jev.ctx.get('judgment')).toBeUndefined()
    expect(jev.judgment).toBeUndefined()
    expect(jev.verifications.every(event => event.degraded)).toBe(true)
    expect(jev.verifications[0]).toMatchObject({
      reason: 'engine-absent',
      verdict: 'accepted',
      questions: [],
      attempt: 1,
    })
  })

  it('costs no judgment call at all when the deployment disabled judgment', async () => {
    const disabled = requireCase(1)
    const jev = await arm(disabled)

    expect(jev.ctx.get('judgment')).toBeDefined()
    expect(jev.ctx.settings.get(JUDGMENT_SETTINGS_NAMESPACE)).toEqual({ enabled: false })
    expect(jev.judgment?.asks).toHaveLength(0)
    expect(jev.verifications[0]).toMatchObject({ reason: 'engine-disabled', verdict: 'accepted', questions: [] })
  })

  it('records no verification verdict from a battery once the selection degraded', async () => {
    for (const under of CASES) {
      const jev = await arm(under)

      expect(jev.verifications, `${under.name}: verification`).not.toHaveLength(0)
      expect(jev.verifications.every(event => event.degraded), `${under.name}: verdicts`).toBe(true)
      expect(jev.verifications.every(event => event.questions.length === 0), `${under.name}: answers`).toBe(true)
      expect(jev.verifications.every(event => event.verdict === 'accepted'), `${under.name}: accepted`).toBe(true)
    }
  })

  it('never reaches a battery ask when the engine cannot be consulted at all', async () => {
    // The selection already degraded before any spend, so the verification that
    // follows has nothing to ask either.
    for (const index of [0, 1]) {
      const jev = await arm(requireCase(index))
      expect(jev.judgment?.asks ?? [], `case ${index}: asks`).toEqual([])
    }
  })

  it('does not degrade when the judgment answers well', async () => {
    const ctx = createContext()
    await ctx.plugin(ScriptedJudgment)
    const judgment = ctx.judgment as ScriptedJudgment
    // Every segment clears the rescue floor, every check clears the verify
    // threshold, the overall score clears its floor, and no edge is a hazard.
    judgment.defaultScore = { score: 5, confidence: 0.9 }
    judgment.probabilities.set(CHECK, 0.9)
    const engine = new InheritedSummarizerJevEngine(ctx, jevOverrides({ retainTokens: 100, maxRescues: 64, rescueScore: 3 }))
    const session = conversation(4, 'x'.repeat(600))

    await compactIfNeeded(engine, session)

    const selection = selectionEvents(session)[0]
    expect(selection).toMatchObject({ degraded: false })
    expect(selection).not.toHaveProperty('reason')
    expect(selection?.segments.every(fact => fact.disposition === 'rescued')).toBe(true)
    expect(verificationEvents(session)).toHaveLength(1)
    expect(verificationEvents(session)[0]).toMatchObject({
      verdict: 'accepted',
      degraded: false,
      questions: [
        { name: CHECK, probability: 0.9 },
        { name: 'overall', score: 5, confidence: 0.9 },
      ],
    })
    expect(conversationAdapter(ctx).calls).toHaveLength(1)
  })

  it('routes the shared summarizer call the same way on both arms', async () => {
    const under = requireCase(0)
    const jev = await arm(under)
    const basic = await twin(under)

    expect(conversationAdapter(jev.ctx)).toBeInstanceOf(ContextAdapter)
    expect(conversationAdapter(jev.ctx).calls).toHaveLength(1)
    expect(conversationAdapter(basic.ctx).calls).toHaveLength(1)
    expect(conversationAdapter(jev.ctx).lastOptions).toMatchObject({ purpose: 'compaction', provider: MODEL })
    expect(conversationAdapter(jev.ctx).text).toBe(conversationAdapter(basic.ctx).text)
  })

  it('classifies a failed selection ask by the ask failure code', async () => {
    const jev = await arm(requireCase(2))

    // The ask's own code decides the class, and the draft still reaches the surface.
    expect(jev.selections[0]?.reason).toBe('engine-unavailable')
    expect(jev.judgment?.asks.filter(isBatteryAsk)).not.toHaveLength(0)
    expect(summaryEvents(jev.session)).toHaveLength(1)
  })

  it('classifies an unusable selection answer as an invalid answer', async () => {
    const jev = await arm(requireCase(3))

    expect(jev.selections[0]?.reason).toBe('invalid-answer')
    expect(summaryEvents(jev.session)).toHaveLength(1)
  })
})

/** One case by index, with a loud fixture failure instead of a silent undefined. */
function requireCase(index: number): Case {
  const under = CASES[index]
  if (under === undefined) throw new Error(`fixture: no degradation case at index ${index}`)
  return under
}
