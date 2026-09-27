import { describe, expect, it } from 'vitest'
import { consult, hashDraw, ANSWER_CONFIDENCE, KEEP_CURRENT_OPTION, SELECTED_PROBABILITY } from '../src/engine.ts'

const CONFIG = { entryRate: 0.3, seed: 20261016 }
const ROUTE_OPTIONS = [{ option: 'flash' }, { option: KEEP_CURRENT_OPTION }]
const CHOICE_QUESTIONS = [{ kind: 'choice', id: 'route', options: ROUTE_OPTIONS }]
const corr = (sessionId: string, consultKey: string) => ({ sessionId, consultKey })

describe('hashDraw', () => {
  it('is deterministic for the same correlation', () => {
    expect(hashDraw(7, corr('session-1', 'turn:3/step:0'))).toBe(hashDraw(7, corr('session-1', 'turn:3/step:0')))
  })

  it('differs across seeds, sessions, and consult keys', () => {
    const values = [
      hashDraw(7, corr('session-1', 'turn:0/step:0')),
      hashDraw(8, corr('session-1', 'turn:0/step:0')),
      hashDraw(7, corr('session-2', 'turn:0/step:0')),
      hashDraw(7, corr('session-1', 'turn:1/step:0')),
      hashDraw(7, corr('session-1', 'turn:0/step:1')),
    ]
    expect(new Set(values).size).toBe(values.length)
  })

  it('two sessions at the same coordinates draw independently', () => {
    expect(hashDraw(7, corr('session-a', 'turn:2/step:0')))
      .not.toBe(hashDraw(7, corr('session-b', 'turn:2/step:0')))
  })

  it('stays in [0, 1) over a wide sweep', () => {
    for (let i = 0; i < 5000; i += 1) {
      const u = hashDraw(i, corr(`session-${i}`, `turn:${i % 8}/step:${i % 3}`))
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThan(1)
    }
  })
})

describe('consult', () => {
  it('selects the candidate at the entry rate over 10k keys within the binomial CI', () => {
    let downgrades = 0
    const consults = 10_000
    for (let i = 0; i < consults; i += 1) {
      const { answers } = consult(CONFIG, corr(`session-${i}`, 'turn:0/step:0'), CHOICE_QUESTIONS)
      const first = answers[0]
      if (first?.kind === 'choice' && first.option === 'flash') downgrades += 1
    }
    const observed = downgrades / consults
    const se = Math.sqrt(0.3 * 0.7 / consults)
    expect(Math.abs(observed - 0.3)).toBeLessThanOrEqual(1.96 * se)
  })

  it('answers probability 1 with confidence 1 on the selected option', () => {
    const { answers } = consult({ entryRate: 1, seed: 3 }, corr('s', 'turn:0/step:0'), CHOICE_QUESTIONS)
    expect(answers[0]).toEqual({
      kind: 'choice',
      id: 'route',
      option: 'flash',
      probabilities: { flash: SELECTED_PROBABILITY, [KEEP_CURRENT_OPTION]: 0 },
      confidence: ANSWER_CONFIDENCE,
    })
  })

  it('keeps the current route when the draw exceeds the rate', () => {
    const { answers } = consult({ entryRate: 0, seed: 3 }, corr('s', 'turn:0/step:0'), CHOICE_QUESTIONS)
    const first = answers[0]
    expect(first?.kind).toBe('choice')
    if (first?.kind === 'choice') {
      expect(first.option).toBe(KEEP_CURRENT_OPTION)
      expect(first.probabilities[KEEP_CURRENT_OPTION]).toBe(1)
    }
  })

  it('replays identically for the same correlation without prior state', () => {
    const a = consult(CONFIG, corr('s', 'turn:2/step:1'), CHOICE_QUESTIONS)
    const b = consult(CONFIG, corr('s', 'turn:2/step:1'), CHOICE_QUESTIONS)
    expect(a).toEqual(b)
  })

  it('answers neutral questions', () => {
    const { answers } = consult(CONFIG, corr('s', 'turn:0/step:0'), [
      { kind: 'score', id: 'difficulty', levels: ['easy', 'hard'] },
      { kind: 'binary', id: 'flag' },
    ])
    expect(answers[0]).toEqual({ kind: 'score', id: 'difficulty', score: 0, probabilities: { '0': 1 }, confidence: 1 })
    expect(answers[1]).toEqual({ kind: 'binary', id: 'flag', probability: 0 })
  })

  it('answers choice and neutral questions in one consult', () => {
    const { answers } = consult(CONFIG, corr('s', 'turn:0/step:0'), [
      { kind: 'score', id: 'difficulty', levels: ['easy', 'hard'] },
      { kind: 'choice', id: 'route', options: ROUTE_OPTIONS },
    ])
    expect(answers).toHaveLength(2)
    expect(answers[0]?.kind).toBe('score')
    expect(answers[1]?.kind).toBe('choice')
  })

  it('refuses a choice question with no options', () => {
    expect(() => consult(CONFIG, corr('s', 'turn:0/step:0'), [{ kind: 'choice', id: 'route' }])).toThrow(/no options/)
  })

  it('keeps the only option when a downgrade draw meets an all-keep-current list', () => {
    const { answers } = consult({ entryRate: 1, seed: 3 }, corr('s', 'turn:0/step:0'), [
      { kind: 'choice', id: 'route', options: [{ option: KEEP_CURRENT_OPTION }] },
    ])
    const first = answers[0]
    expect(first?.kind).toBe('choice')
    if (first?.kind === 'choice') expect(first.option).toBe(KEEP_CURRENT_OPTION)
  })

  it('selects the last option when a keep draw meets a list without keep-current', () => {
    const { answers } = consult({ entryRate: 0, seed: 3 }, corr('s', 'turn:0/step:0'), [
      { kind: 'choice', id: 'route', options: [{ option: 'a' }, { option: 'b' }] },
    ])
    const first = answers[0]
    expect(first?.kind).toBe('choice')
    if (first?.kind === 'choice') expect(first.option).toBe('b')
  })

  it('refuses an unsupported question kind', () => {
    expect(() => consult(CONFIG, corr('s', 'turn:0/step:0'), [{ kind: 'trinary', id: 'x' }])).toThrow(/unsupported question kind/)
  })
})
