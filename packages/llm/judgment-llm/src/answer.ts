/**
 * The model-facing request of one LLM judgment ask and the strict reading of
 * its answer. The judge answers through one tool call whose parameter schema
 * names every question and every option, so a route that validates tool
 * arguments against the schema constrains the answer before it is read.
 *
 * @module @shres-code/shres-code-judgment-llm/answer
 */

import { JudgmentError } from '@shres-code/shres-code-judgment'
import type {
  JudgmentAnswer,
  JudgmentBinaryQuestion,
  JudgmentChoiceQuestion,
  JudgmentQuestion,
  JudgmentScoreQuestion,
} from '@shres-code/shres-code-judgment'
import type { ToolSchema } from '@shres-code/shres-code-llm'

/** Name of the one tool the judge answers through. */
export const ANSWER_TOOL_NAME = 'judgment_answer'

/** System prompt of every judge request. */
export const JUDGE_SYSTEM_PROMPT = [
  'You are a judge. Read the state and answer every question by calling the judgment_answer tool exactly once.',
  'For a choice question, give each listed option the probability, from 0 to 1, that it is the correct answer.',
  'For a score question, give each listed level the probability, from 0 to 1, that it is the correct level.',
  'For a yes/no question, give the probability, from 0 to 1, that the answer is yes.',
  'The probabilities for one choice or score question should add up to 1.',
  'Do not answer in text.',
].join('\n')

/**
 * Build the user message text of one judge request: the state, then each
 * question with the keys its answer must use.
 * @param state - the redacted state.
 * @param questions - the asked questions, in ask order.
 * @returns the message text.
 */
export function renderJudgeMessage(state: string, questions: readonly JudgmentQuestion[]): string {
  const lines = ['State:', '<state>', state, '</state>', '', 'Questions:']
  questions.forEach((question, index) => {
    lines.push(`${index + 1}. Answer key ${JSON.stringify(question.id)} (${kindLabel(question)}): ${question.instructions}`)
    switch (question.kind) {
      case 'choice':
        lines.push('   Options:')
        for (const option of question.options) {
          lines.push(`   - ${JSON.stringify(option.option)}${option.description === undefined ? '' : `: ${option.description}`}`)
        }
        break
      case 'score':
        lines.push('   Levels:')
        question.levels.forEach((level, levelIndex) => { lines.push(`   - ${JSON.stringify(String(levelIndex))}: ${level}`) })
        break
      case 'binary':
        if (question.criteria?.yes !== undefined) lines.push(`   Yes means: ${question.criteria.yes}`)
        if (question.criteria?.no !== undefined) lines.push(`   No means: ${question.criteria.no}`)
        break
    }
  })
  return lines.join('\n')
}

/** The label a question's kind carries in the rendered message. */
function kindLabel(question: JudgmentQuestion): string {
  switch (question.kind) {
    case 'choice': return 'choice'
    case 'score': return 'score'
    case 'binary': return 'yes/no'
  }
}

/**
 * Build the answer tool whose parameter schema names every question and
 * every option or level the answer must cover.
 * @param questions - the asked questions.
 * @returns the tool schema the judge request carries.
 */
export function answerTool(questions: readonly JudgmentQuestion[]): ToolSchema {
  const properties: Record<string, unknown> = {}
  for (const question of questions) properties[question.id] = questionSchema(question)
  return {
    name: ANSWER_TOOL_NAME,
    description: 'Report the probabilities for every question.',
    parameters: {
      type: 'object',
      properties: {
        answers: {
          type: 'object',
          properties,
          required: questions.map(question => String(question.id)),
          additionalProperties: false,
        },
      },
      required: ['answers'],
      additionalProperties: false,
    },
  }
}

/** One probability value in the answer schema. */
const PROBABILITY = { type: 'number', minimum: 0, maximum: 1 }

/** The schema of one question's answer. */
function questionSchema(question: JudgmentQuestion): Record<string, unknown> {
  switch (question.kind) {
    case 'binary':
      return { ...PROBABILITY, description: 'Probability that the answer is yes.' }
    case 'choice':
    case 'score': {
      const keys = distributionKeys(question)
      return {
        type: 'object',
        description: question.kind === 'choice' ? 'Probability per option.' : 'Probability per level.',
        properties: Object.fromEntries(keys.map(key => [key, PROBABILITY])),
        required: keys,
        additionalProperties: false,
      }
    }
  }
}

/** The keys a choice or score answer is read under: option names, or level indexes as decimal strings. */
function distributionKeys(question: JudgmentChoiceQuestion | JudgmentScoreQuestion): string[] {
  return question.kind === 'choice'
    ? question.options.map(option => option.option)
    : question.levels.map((_level, index) => String(index))
}

/**
 * Read the judge's answer and return one validated answer per question.
 *
 * Every question must be answered, every option or level must carry a number
 * from 0 to 1, and nothing unasked may appear. A choice or score distribution
 * is normalised by dividing each value by the distribution's sum, which must
 * be above zero. Confidence is `1 − H(p) / ln(n)` over the normalised
 * distribution, where `H` is Shannon entropy and `n` the number of options
 * or levels: 0 for a uniform distribution, 1 when one key holds all the
 * probability, and 1 for a single-key question. A choice's `option` is the
 * highest-probability key, the earliest listed on a tie; a score is the
 * probability-weighted level index.
 * @param argumentsJson - the raw arguments of the judge's one tool call.
 * @param questions - the asked questions, in ask order.
 * @returns the answers, in ask order.
 * @throws JudgmentError code `INVALID_ANSWER` for malformed JSON, a missing or
 *   unasked question or key, or a value outside 0 to 1.
 */
export function readAnswers(argumentsJson: string, questions: readonly JudgmentQuestion[]): JudgmentAnswer[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch (cause: unknown) {
    throw invalid('the judge returned arguments that are not valid JSON', cause)
  }
  if (!isRecord(parsed) || !isRecord(parsed.answers)) throw invalid('the judge returned no "answers" object')
  const answers = parsed.answers
  const asked = new Set(questions.map(question => String(question.id)))
  for (const key of Object.keys(answers)) {
    if (!asked.has(key)) throw invalid(`the judge answered an unasked question "${key}"`)
  }
  return questions.map((question) => {
    if (!Object.hasOwn(answers, question.id)) throw invalid(`the judge did not answer question "${question.id}"`)
    const value = answers[question.id]
    return question.kind === 'binary' ? binaryAnswer(question, value) : distributionAnswer(question, value)
  })
}

/** Read one yes/no answer. */
function binaryAnswer(question: JudgmentBinaryQuestion, value: unknown): JudgmentAnswer {
  return { kind: 'binary', id: question.id, probability: probability(value, question.id, 'yes') }
}

/** Read, validate, and normalise one choice or score distribution. */
function distributionAnswer(question: JudgmentChoiceQuestion | JudgmentScoreQuestion, value: unknown): JudgmentAnswer {
  if (!isRecord(value)) throw invalid(`the judge's answer to "${question.id}" is not an object of probabilities`)
  const keys = distributionKeys(question)
  const expected = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw invalid(`the judge's answer to "${question.id}" names "${key}", which was not offered`)
  }
  const raw = keys.map((key) => {
    if (!Object.hasOwn(value, key)) throw invalid(`the judge's answer to "${question.id}" omits "${key}"`)
    return { key, p: probability(value[key], question.id, key) }
  })
  const sum = raw.reduce((total, entry) => total + entry.p, 0)
  // Also rejects a question with no options or levels, so `normalised` is never empty below.
  if (sum <= 0) throw invalid(`the judge's probabilities for "${question.id}" sum to 0`)
  const normalised = raw.map(entry => ({ key: entry.key, p: entry.p / sum }))
  const probabilities = Object.fromEntries(normalised.map(entry => [entry.key, entry.p]))
  const confidence = concentration(normalised.map(entry => entry.p))
  if (question.kind === 'choice') {
    // Strictly greater keeps the earliest listed option on a tie.
    const best = normalised.reduce((top, entry) => (entry.p > top.p ? entry : top))
    return { kind: 'choice', id: question.id, option: best.key, probabilities, confidence }
  }
  const score = normalised.reduce((total, entry, index) => total + entry.p * index, 0)
  return { kind: 'score', id: question.id, score, probabilities, confidence }
}

/** `1 − H(p) / ln(n)` for a normalised distribution, clamped against rounding. */
function concentration(distribution: readonly number[]): number {
  if (distribution.length <= 1) return 1
  const entropy = distribution.reduce((total, p) => (p > 0 ? total - p * Math.log(p) : total), 0)
  return Math.min(1, Math.max(0, 1 - entropy / Math.log(distribution.length)))
}

/** Read one probability, rejecting anything but a finite number from 0 to 1. */
function probability(value: unknown, questionId: string, key: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalid(`the judge's probability for "${questionId}" / "${key}" is not a number from 0 to 1`)
  }
  return value
}

/** An `INVALID_ANSWER` failure. */
function invalid(message: string, cause?: unknown): JudgmentError {
  return new JudgmentError('INVALID_ANSWER', `judgment-llm: ${message}`, cause === undefined ? undefined : { cause })
}

/** Whether a parsed JSON value is a plain object, not an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
