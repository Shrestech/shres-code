import { describe, expect, it } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import JudgmentService, { judgmentConsumerId, judgmentEngineId, judgmentQuestionId, JudgmentError } from '../src/index.ts'
import type { JudgmentInput, JudgmentResult } from '../src/index.ts'

/** Minimal engine proving the seam's registration form and answer contract. */
class RecordingJudgment extends JudgmentService {
  readonly asks: JudgmentInput[] = []

  override ask(input: JudgmentInput): Promise<JudgmentResult> {
    this.asks.push(input)
    return Promise.resolve({ answers: [], engine: 'recording', model: 'recording-1', latencyMs: 0 })
  }
}

/** Minimal egress hook proving the optional service key a deployment fills. */
class StubRedactor extends Service {
  constructor(ctx: Context) {
    super(ctx, 'judgmentRedactor')
  }

  /**
   * Replace one state's secret text.
   * @param state - the state an engine is about to receive.
   * @returns the state with secrets replaced.
   */
  redactState(state: string): string {
    return state.replaceAll('secret', '[redacted]')
  }
}

const BINARY = {
  kind: 'binary',
  id: judgmentQuestionId('is_urgent'),
  instructions: 'Does this convey urgency?',
} as const

describe('judgmentQuestionId', () => {
  it('brands a non-empty id', () => {
    expect(judgmentQuestionId('difficulty')).toBe('difficulty')
  })

  it('rejects an empty id', () => {
    expect(() => judgmentQuestionId('')).toThrow(TypeError)
  })
})

describe('JudgmentError', () => {
  it('carries the stable code, its own name, and the original failure', () => {
    const cause = new Error('socket closed')
    const error = new JudgmentError('UNAVAILABLE', 'the judgment engine could not be reached', { cause })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('JudgmentError')
    expect(error.code).toBe('UNAVAILABLE')
    expect(error.message).toBe('the judgment engine could not be reached')
    expect(error.cause).toBe(cause)
    expect(error).not.toHaveProperty('engineId')
  })

  it('carries the routed engine id when a dispatcher sets it', () => {
    const error = new JudgmentError('UNAVAILABLE', 'laya is starting', { engineId: judgmentEngineId('laya') })
    expect(error.engineId).toBe('laya')
    expect(error.cause).toBeUndefined()
    expect(error).not.toHaveProperty('refusedBeforeDispatch')
    const refused = new JudgmentError('UNAVAILABLE', 'laya is unconfigured', { engineId: judgmentEngineId('laya'), refusedBeforeDispatch: true })
    expect(refused.refusedBeforeDispatch).toBe(true)
  })
})

describe('the judgment seam through a provider', () => {
  it('mounts as ctx.judgment and answers an ask through the service', async () => {
    const ctx = new Context()
    await ctx.plugin(RecordingJudgment)

    expect(ctx.judgment).toBeInstanceOf(RecordingJudgment)
    const result = await ctx.judgment.ask({ state: 'payments are failing', questions: [BINARY], tier: 'fast' })
    expect(result).toEqual({ answers: [], engine: 'recording', model: 'recording-1', latencyMs: 0 })
    expect((ctx.judgment as RecordingJudgment).asks[0]?.questions[0]).toEqual(BINARY)
  })

  it('answers every consumer with its own fitting and selects no engine by default', async () => {
    const ctx = new Context()
    await ctx.plugin(RecordingJudgment)
    const consumer = judgmentConsumerId('model-router')
    expect(ctx.judgment.fittingFor(consumer)).toBeUndefined()
    expect(ctx.judgment.selectedEngine(consumer)).toBeUndefined()
    const fitting = { ask: () => Promise.reject(new Error('unused')) }
    Object.defineProperty(ctx.judgment, 'fitting', { value: fitting })
    expect(ctx.judgment.fittingFor(consumer)).toBe(fitting)
    expect(ctx.judgment.fittingFor()).toBe(fitting)
  })

  it('exposes ctx.judgmentRedactor only while a deployment mounts one', async () => {
    const ctx = new Context()
    await ctx.plugin(RecordingJudgment)
    expect(ctx.get('judgmentRedactor')).toBeUndefined()

    await ctx.plugin(StubRedactor)
    expect(await ctx.judgmentRedactor?.redactState('keep secret in')).toBe('keep [redacted] in')
  })

  it('withdraws the service when its plugin fiber disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(RecordingJudgment)
    expect(ctx.get('judgment')).toBeInstanceOf(RecordingJudgment)
    await ctx.fiber.dispose()
    expect(ctx.get('judgment')).toBeUndefined()
  })
})
