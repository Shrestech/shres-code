import { describe, expect, it } from 'vitest'
import { JudgmentError, judgmentQuestionId } from '@shres-code/shres-code-judgment'
import type { JudgmentAnswer, JudgmentQuestion } from '@shres-code/shres-code-judgment'
import { answerTool, JUDGE_SYSTEM_PROMPT, readAnswers, renderJudgeMessage } from '../src/answer.ts'

const ROUTE: JudgmentQuestion = {
  kind: 'choice',
  id: judgmentQuestionId('route'),
  instructions: 'Which route should handle this turn?',
  options: [{ option: 'keep-current', description: 'the strong model' }, { option: 'flash' }],
}
const DIFFICULTY: JudgmentQuestion = {
  kind: 'score',
  id: judgmentQuestionId('difficulty'),
  instructions: 'How hard is this turn?',
  levels: ['routine', 'moderate', 'hard'],
}
const URGENT: JudgmentQuestion = {
  kind: 'binary',
  id: judgmentQuestionId('urgent'),
  instructions: 'Is this urgent?',
  criteria: { yes: 'the user is blocked', no: 'nothing waits on it' },
}
const QUESTIONS = [ROUTE, DIFFICULTY, URGENT]

/** Read one answer object built as the judge's tool arguments. */
function read(answers: unknown, questions: readonly JudgmentQuestion[] = QUESTIONS): JudgmentAnswer[] {
  return readAnswers(JSON.stringify({ answers }), questions)
}

/** The INVALID_ANSWER failure one read throws. */
function invalid(read: () => unknown): JudgmentError {
  try {
    read()
  } catch (error: unknown) {
    if (error instanceof JudgmentError) {
      expect(error.code).toBe('INVALID_ANSWER')
      return error
    }
    throw error
  }
  throw new Error('the answer was accepted')
}

describe('model-facing request', () => {
  it('pins the judge system prompt verbatim', () => {
    expect(JUDGE_SYSTEM_PROMPT).toBe([
      'You are a judge. Read the state and answer every question by calling the judgment_answer tool exactly once.',
      'For a choice question, give each listed option the probability, from 0 to 1, that it is the correct answer.',
      'For a score question, give each listed level the probability, from 0 to 1, that it is the correct level.',
      'For a yes/no question, give the probability, from 0 to 1, that the answer is yes.',
      'The probabilities for one choice or score question should add up to 1.',
      'Do not answer in text.',
    ].join('\n'))
  })

  it('pins the rendered state and questions verbatim', () => {
    const bare: JudgmentQuestion = { kind: 'binary', id: judgmentQuestionId('bare'), instructions: 'Is it done?' }
    expect(renderJudgeMessage('fix the typo — naïve', [...QUESTIONS, bare])).toBe([
      'State:',
      '<state>',
      'fix the typo — naïve',
      '</state>',
      '',
      'Questions:',
      '1. Answer key "route" (choice): Which route should handle this turn?',
      '   Options:',
      '   - "keep-current": the strong model',
      '   - "flash"',
      '2. Answer key "difficulty" (score): How hard is this turn?',
      '   Levels:',
      '   - "0": routine',
      '   - "1": moderate',
      '   - "2": hard',
      '3. Answer key "urgent" (yes/no): Is this urgent?',
      '   Yes means: the user is blocked',
      '   No means: nothing waits on it',
      '4. Answer key "bare" (yes/no): Is it done?',
    ].join('\n'))
  })

  it('names every question and every option or level in the answer schema', () => {
    const probability = { type: 'number', minimum: 0, maximum: 1 }
    expect(answerTool(QUESTIONS)).toEqual({
      name: 'judgment_answer',
      description: 'Report the probabilities for every question.',
      parameters: {
        type: 'object',
        properties: {
          answers: {
            type: 'object',
            properties: {
              route: {
                type: 'object',
                description: 'Probability per option.',
                properties: { 'keep-current': probability, flash: probability },
                required: ['keep-current', 'flash'],
                additionalProperties: false,
              },
              difficulty: {
                type: 'object',
                description: 'Probability per level.',
                properties: { 0: probability, 1: probability, 2: probability },
                required: ['0', '1', '2'],
                additionalProperties: false,
              },
              urgent: { ...probability, description: 'Probability that the answer is yes.' },
            },
            required: ['route', 'difficulty', 'urgent'],
            additionalProperties: false,
          },
        },
        required: ['answers'],
        additionalProperties: false,
      },
    })
  })
})

describe('reading the answer', () => {
  it('returns one validated answer per question in ask order', () => {
    const answers = read({
      urgent: 0.25,
      difficulty: { 0: 0.5, 1: 0.5, 2: 0 },
      route: { 'keep-current': 0.2, flash: 0.8 },
    })
    const [route, difficulty, urgent] = answers as [
      Extract<JudgmentAnswer, { kind: 'choice' }>,
      Extract<JudgmentAnswer, { kind: 'score' }>,
      JudgmentAnswer,
    ]
    expect(answers).toHaveLength(3)
    expect(route).toMatchObject({ kind: 'choice', id: 'route', option: 'flash', probabilities: { 'keep-current': 0.2, flash: 0.8 } })
    // 1 - H(0.2, 0.8) / ln 2
    expect(route.confidence).toBeCloseTo(1 - (-(0.2 * Math.log(0.2)) - 0.8 * Math.log(0.8)) / Math.log(2), 12)
    expect(difficulty).toMatchObject({ kind: 'score', id: 'difficulty', score: 0.5, probabilities: { 0: 0.5, 1: 0.5, 2: 0 } })
    // 1 - ln 2 / ln 3
    expect(difficulty.confidence).toBeCloseTo(1 - Math.log(2) / Math.log(3), 12)
    expect(urgent).toEqual({ kind: 'binary', id: 'urgent', probability: 0.25 })
  })

  it('normalises a distribution by its sum and measures its concentration', () => {
    const [route, difficulty] = read({
      route: { 'keep-current': 0.3, flash: 0.3 },
      difficulty: { 0: 0, 1: 0, 2: 0.4 },
      urgent: 1,
    }) as [Extract<JudgmentAnswer, { kind: 'choice' }>, Extract<JudgmentAnswer, { kind: 'score' }>]
    expect(route.probabilities).toEqual({ 'keep-current': 0.5, flash: 0.5 })
    expect(route.confidence).toBe(0)
    // A tie picks the earliest listed option.
    expect(route.option).toBe('keep-current')
    expect(difficulty.probabilities).toEqual({ 0: 0, 1: 0, 2: 1 })
    expect(difficulty.confidence).toBe(1)
    expect(difficulty.score).toBe(2)
  })

  it('gives a single-option question full confidence', () => {
    const single: JudgmentQuestion = { kind: 'choice', id: judgmentQuestionId('only'), instructions: 'Pick', options: [{ option: 'one' }] }
    expect(read({ only: { one: 0.4 } }, [single])).toEqual([
      { kind: 'choice', id: 'only', option: 'one', probabilities: { one: 1 }, confidence: 1 },
    ])
  })

  it.each([
    ['malformed JSON', () => readAnswers('{"answers": {', QUESTIONS), 'arguments that are not valid JSON'],
    ['no answers object', () => readAnswers('{"route": {}}', QUESTIONS), 'no "answers" object'],
    ['an answers array', () => readAnswers('{"answers": []}', QUESTIONS), 'no "answers" object'],
    ['a missing question', () => read({ route: { 'keep-current': 1, flash: 0 }, urgent: 0 }), 'did not answer question "difficulty"'],
    ['an unasked question', () => read({ route: { 'keep-current': 1, flash: 0 }, difficulty: { 0: 1, 1: 0, 2: 0 }, urgent: 0, extra: 1 }), 'unasked question "extra"'],
    ['a missing option', () => read({ route: { flash: 1 }, difficulty: { 0: 1, 1: 0, 2: 0 }, urgent: 0 }), 'answer to "route" omits "keep-current"'],
    ['an unoffered option', () => read({ route: { 'keep-current': 0.5, flash: 0.4, other: 0.1 }, difficulty: { 0: 1, 1: 0, 2: 0 }, urgent: 0 }), 'names "other", which was not offered'],
    ['a distribution that is not an object', () => read({ route: 0.5, difficulty: { 0: 1, 1: 0, 2: 0 }, urgent: 0 }), 'answer to "route" is not an object of probabilities'],
    ['a probability above 1', () => read({ route: { 'keep-current': 1.2, flash: 0 }, difficulty: { 0: 1, 1: 0, 2: 0 }, urgent: 0 }), 'probability for "route" / "keep-current" is not a number from 0 to 1'],
    ['a negative probability', () => read({ route: { 'keep-current': 1, flash: 0 }, difficulty: { 0: -0.1, 1: 0, 2: 0 }, urgent: 0 }), 'probability for "difficulty" / "0" is not a number from 0 to 1'],
    ['a probability given as a string', () => read({ route: { 'keep-current': '0.5', flash: 0.5 }, difficulty: { 0: 1, 1: 0, 2: 0 }, urgent: 0 }), 'probability for "route" / "keep-current"'],
    ['a binary probability out of range', () => read({ route: { 'keep-current': 1, flash: 0 }, difficulty: { 0: 1, 1: 0, 2: 0 }, urgent: 2 }), 'probability for "urgent" / "yes"'],
    ['a distribution summing to 0', () => read({ route: { 'keep-current': 0, flash: 0 }, difficulty: { 0: 1, 1: 0, 2: 0 }, urgent: 0 }), 'probabilities for "route" sum to 0'],
  ])('rejects %s as INVALID_ANSWER', (_case, reading, message) => {
    expect(invalid(reading).message).toContain(message)
  })

  it('keeps the JSON parse failure as the cause', () => {
    expect(invalid(() => readAnswers('not json', QUESTIONS)).cause).toBeInstanceOf(SyntaxError)
  })
})
