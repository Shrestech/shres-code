/**
 * Wire vocabulary, request mapping, and response validation for the vendor's
 * `systemone` endpoint.
 *
 * The response body is the only untyped input this provider reads, so every
 * field an answer depends on is judged here against the question that produced
 * it; a violation is a `JudgmentError` with code `INVALID_ANSWER` rather than a
 * value a consumer could act on.
 *
 * @module @shres-code/shres-code-judgment-typesafe/wire
 */

import { JudgmentError } from '@shres-code/shres-code-judgment'
import type { JudgmentAnswer, JudgmentQuestion } from '@shres-code/shres-code-judgment'

/** What a `noul` answer's two outcomes mean; both sides are optional. */
export interface WireNoulCriteria {
  /** What a probability near 1 means. */
  true?: string
  /** What a probability near 0 means. */
  false?: string
}

/** One question in the vendor's own vocabulary. */
export type WireQuestion =
  | { type: 'noul'; instructions: string; criteria?: WireNoulCriteria }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] }

/** Request body of one `POST {endpoint}/v1/systemone` ask. */
export interface WireRequest {
  /** State text every question is evaluated against, after redaction. */
  state: string
  /** Model id the ask's tier resolved to. */
  model: string
  /** Questions keyed by the id their answer carries. */
  questions: Record<string, WireQuestion>
}

/** One ask's validated response. */
export interface ReadWireResponse {
  /** Model id the vendor reported, which is the versioned id an alias resolved to. */
  model: string
  /** One mapped answer per asked question, in the order the questions were asked. */
  answers: JudgmentAnswer[]
}

/**
 * Map one ask into the vendor's request body.
 * @param state - the state text to send, after any redaction.
 * @param model - the model id the ask's tier resolved to.
 * @param questions - the consumer's questions, in ask order.
 * @returns the request body with one wire question per asked id.
 */
export function toWireRequest(
  state: string,
  model: string,
  questions: readonly JudgmentQuestion[],
): WireRequest {
  const mapped: Record<string, WireQuestion> = {}
  for (const question of questions) mapped[question.id] = toWireQuestion(question)
  return { state, model, questions: mapped }
}

/**
 * Validate one `systemone` response against the questions that produced it.
 *
 * The body must be an object with a non-empty `model` and an `answers` object,
 * and per asked question id the answer must exist, be an object, carry the
 * `type` of that question kind, and hold finite numbers. `usage` and `legend`
 * are carried by the vendor but not consumed, so their absence never fails an
 * ask.
 * @param body - the parsed JSON response.
 * @param questions - the questions this ask sent, in ask order.
 * @returns the answering model id and one mapped answer per question, in ask order.
 * @throws JudgmentError code `INVALID_ANSWER` for a body, answer, discriminant,
 *   option, or number the mapping cannot use.
 */
export function readWireResponse(body: unknown, questions: readonly JudgmentQuestion[]): ReadWireResponse {
  if (!isRecord(body)) throw invalid('body is not a JSON object')
  const model = body.model
  if (typeof model !== 'string' || model.length === 0) throw invalid('has no model id')
  const raw = body.answers
  if (!isRecord(raw)) throw invalid('has no answers object')
  const answers: JudgmentAnswer[] = []
  for (const question of questions) {
    const answer = raw[question.id]
    if (!isRecord(answer)) throw invalid(`has no answer for question "${question.id}"`)
    answers.push(readAnswer(question, answer))
  }
  return { model, answers }
}

/** Map one typed question into the vendor's vocabulary. */
function toWireQuestion(question: JudgmentQuestion): WireQuestion {
  switch (question.kind) {
    case 'binary': {
      const criteria = question.criteria
      if (criteria === undefined) return { type: 'noul', instructions: question.instructions }
      const mapped: WireNoulCriteria = {
        ...criteria.yes === undefined ? {} : { true: criteria.yes },
        ...criteria.no === undefined ? {} : { false: criteria.no },
      }
      return Object.keys(mapped).length === 0
        ? { type: 'noul', instructions: question.instructions }
        : { type: 'noul', instructions: question.instructions, criteria: mapped }
    }
    case 'choice':
      return {
        type: 'choice',
        instructions: question.instructions,
        criteria: Object.fromEntries(
          question.options.map(option => [option.option, option.description ?? null]),
        ),
      }
    case 'score':
      return { type: 'score', instructions: question.instructions, criteria: [...question.levels] }
  }
}

/** Map one question's wire answer, rejecting anything the question cannot explain. */
function readAnswer(question: JudgmentQuestion, answer: Record<string, unknown>): JudgmentAnswer {
  switch (question.kind) {
    case 'binary':
      if (answer.type !== 'noul') {
        throw invalid(`answers question "${question.id}" with type "${discriminant(answer)}" instead of "noul"`)
      }
      return { kind: 'binary', id: question.id, probability: finiteNumber(answer.noul, question, 'noul') }
    case 'choice': {
      if (answer.type !== 'choice') {
        throw invalid(`answers question "${question.id}" with type "${discriminant(answer)}" instead of "choice"`)
      }
      const option = answer.choice
      if (typeof option !== 'string') throw invalid(`answers question "${question.id}" with no option`)
      if (!question.options.some(entry => entry.option === option)) {
        throw invalid(`answers question "${question.id}" with option "${option}", which it was not asked`)
      }
      return {
        kind: 'choice',
        id: question.id,
        option,
        probabilities: probabilityMap(answer.probabilities, question),
        confidence: finiteNumber(answer.confidence, question, 'confidence'),
      }
    }
    case 'score':
      if (answer.type !== 'score') {
        throw invalid(`answers question "${question.id}" with type "${discriminant(answer)}" instead of "score"`)
      }
      return {
        kind: 'score',
        id: question.id,
        score: finiteNumber(answer.score, question, 'score'),
        probabilities: probabilityMap(answer.probabilities, question),
        confidence: finiteNumber(answer.confidence, question, 'confidence'),
      }
  }
}

/** Read one finite number field, or reject the response. */
function finiteNumber(value: unknown, question: JudgmentQuestion, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`answers question "${question.id}" with a non-finite ${field}`)
  }
  return value
}

/**
 * Read one answer's probability map.
 *
 * Keys are carried through verbatim — an option key for a choice question, the
 * zero-based level index as a decimal string for a score question — because the
 * vendor's structural invariants do not hold (probabilities can sum past 1), so
 * this provider reports the distribution it received instead of repairing it.
 */
function probabilityMap(value: unknown, question: JudgmentQuestion): Record<string, number> {
  if (!isRecord(value)) throw invalid(`answers question "${question.id}" with no probabilities object`)
  const probabilities: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw invalid(`answers question "${question.id}" with a non-finite probability for "${key}"`)
    }
    probabilities[key] = entry
  }
  return probabilities
}

/** Name the discriminant a mismatched answer carried, for the diagnostic. */
function discriminant(answer: Record<string, unknown>): string {
  const type = answer.type
  return typeof type === 'string' ? type : 'no type'
}

/** Reject one unusable provider response. */
function invalid(detail: string): JudgmentError {
  return new JudgmentError('INVALID_ANSWER', `TypeSafe judgment response ${detail}`)
}

/** Whether a parsed JSON value is a plain object, not an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
