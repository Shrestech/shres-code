/**
 * Wire mapping and response validation for the local Shield judgment gateway.
 *
 * The gateway speaks the typed-judgment vocabulary directly. Validation still
 * lives here because the HTTP body is untyped and a wrong answer could change
 * a routing or compaction decision.
 *
 * @module @shres-code/shres-code-judgment-shield/wire
 */

import { JudgmentError } from '@shres-code/shres-code-judgment'
import type {
  JudgmentAnswer,
  JudgmentFittingResult,
  JudgmentQuestion,
  JudgmentScoreQuestion,
} from '@shres-code/shres-code-judgment'
import { DISTRIBUTION_TOLERANCE } from './config.ts'

/** Engine identity reported by the owned local gateway. */
export const SHIELD_ENGINE = 'shield'

/** One question sent to the local gateway. */
export type ShieldWireQuestion =
  | {
    kind: 'binary'
    id: string
    instructions: string
    criteria?: { yes?: string; no?: string }
  }
  | {
    kind: 'choice'
    id: string
    instructions: string
    options: Array<{ option: string; description?: string }>
  }
  | {
    kind: 'score'
    id: string
    instructions: string
    levels: string[]
  }

/** One request sent to `/v1/judgments`. */
export interface ShieldWireRequest {
  /** State after the provider's one redactor consultation. */
  state: string
  /** Exact artifact selected from the configured tier map. */
  model: string
  /** Typed questions in their original order. */
  questions: ShieldWireQuestion[]
}

/** One request sent to `/v1/judgments/fitted`. */
export interface ShieldFittedWireRequest {
  /** Ordered states after one redactor consultation per candidate. */
  states: string[]
  /** Exact artifact selected from the configured tier map. */
  model: string
  /** Typed questions in their original order. */
  questions: ShieldWireQuestion[]
}

/** Token limits reported by the pinned gateway artifact. */
export interface ShieldWireTokenLimits {
  /** Maximum complete state-plus-question sequence length. */
  maxSequenceTokens: number
  /** Maximum question and option head length. */
  maxHeadTokens: number
  /** Maximum padded batch token count. */
  maxBatchTokens: number
  /** SHA-256 of the model and tokenizer manifest. */
  manifestSha256: string
}

/** Fit facts returned by `/v1/judgments/fitted`, without the selected state text. */
export interface ShieldWireTokenFit {
  /** Index in the request's ordered `states` array. */
  selectedIndex: number
  /** Tokens in the selected state. */
  stateTokens: number
  /** Complete token count for each question sequence. */
  sequenceTokens: number[]
  /** Padded batch token count. */
  paddedTokens: number
  /** Limits applied by the gateway. */
  limits: ShieldWireTokenLimits
}

/** Validated response fields used to construct a judgment result. */
export interface ReadShieldWireResponse {
  /** Gateway identity, always `shield`. */
  engine: typeof SHIELD_ENGINE
  /** Exact artifact identity returned by the gateway. */
  model: string
  /** Gateway-reported ask latency in milliseconds. */
  latencyMs: number
  /** One validated answer per asked question, in ask order. */
  answers: JudgmentAnswer[]
}

/**
 * Map one typed ask to the provider-neutral local wire vocabulary.
 *
 * @param state - redacted state text.
 * @param model - pinned artifact id.
 * @param questions - typed questions in ask order.
 * @returns a JSON-serializable request body.
 */
export function toWireRequest(
  state: string,
  model: string,
  questions: readonly JudgmentQuestion[],
): ShieldWireRequest {
  return {
    state,
    model,
    questions: questions.map(toWireQuestion),
  }
}

/**
 * Map ordered state alternatives to the fitted judgment wire vocabulary.
 *
 * @param states - redacted state alternatives in preference order.
 * @param model - pinned artifact id.
 * @param questions - typed questions in ask order.
 * @returns a JSON-serializable fitted request body.
 */
export function toFittedWireRequest(
  states: readonly string[],
  model: string,
  questions: readonly JudgmentQuestion[],
): ShieldFittedWireRequest {
  return {
    states: [...states],
    model,
    questions: questions.map(toWireQuestion),
  }
}

/**
 * Validate one gateway response against the request that produced it.
 *
 * Choice and score distributions must contain exactly one finite probability
 * in the inclusive range [0, 1] for every requested key and sum to one within
 * the four-decimal rounding tolerance. A choice must select an argmax option;
 * ties and the same rounding tolerance are accepted. A score must equal the
 * probability-weighted level index within a level-count-scaled tolerance.
 *
 * @param body - parsed response JSON.
 * @param questions - questions sent with the request.
 * @param requestedModel - model id selected for the ask.
 * @returns the validated response fields.
 * @throws JudgmentError with `INVALID_ANSWER` for any mismatch.
 */
export function readWireResponse(
  body: unknown,
  questions: readonly JudgmentQuestion[],
  requestedModel: string,
): ReadShieldWireResponse {
  if (!isRecord(body)) throw invalid('body is not a JSON object')
  if (body.engine !== SHIELD_ENGINE) throw invalid(`engine is not "${SHIELD_ENGINE}"`)
  const model = body.model
  if (typeof model !== 'string' || model.length === 0) throw invalid('has no model id')
  if (model !== requestedModel) {
    throw invalid(`reports model "${model}" instead of requested "${requestedModel}"`)
  }
  const latencyMs = body.latencyMs
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs < 0) {
    throw invalid('has no non-negative latencyMs')
  }
  const rawAnswers = body.answers
  if (!Array.isArray(rawAnswers) || rawAnswers.length !== questions.length) {
    throw invalid(`has ${Array.isArray(rawAnswers) ? rawAnswers.length : 'no'} answers for ${questions.length} questions`)
  }
  const byId = new Map<string, JudgmentQuestion>(questions.map(question => [question.id, question]))
  const answersById = new Map<string, Record<string, unknown>>()
  const seen = new Set<string>()
  for (const rawAnswer of rawAnswers) {
    if (!isRecord(rawAnswer) || typeof rawAnswer.id !== 'string') {
      throw invalid('contains an answer with no question id')
    }
    if (seen.has(rawAnswer.id)) throw invalid(`contains duplicate answer id "${rawAnswer.id}"`)
    seen.add(rawAnswer.id)
    const question = byId.get(rawAnswer.id)
    if (question === undefined) throw invalid(`answers unasked question "${rawAnswer.id}"`)
    answersById.set(rawAnswer.id, rawAnswer)
  }
  const answers = questions.map((question) => {
    const rawAnswer = answersById.get(question.id)
    /* v8 ignore next -- the complete unique id set was checked immediately above. */
    if (!isRecord(rawAnswer)) throw invalid(`has no answer for question "${question.id}"`)
    return readAnswer(question, rawAnswer)
  })
  return { engine: SHIELD_ENGINE, model, latencyMs, answers }
}

/**
 * Validate one fitted gateway response and reconstruct the selected state.
 *
 * The fitted response reuses the ordinary nested result so answer validation
 * stays in one place. Its fit record deliberately omits state text; the caller
 * supplies the exact redacted outbound states so the returned fit cannot drift
 * from what the gateway measured.
 *
 * @param body - parsed fitted response JSON.
 * @param states - exact redacted states sent in the request.
 * @param questions - questions sent with the request.
 * @param requestedModel - model id selected for the ask.
 * @returns the validated fitting result with the selected state restored.
 * @throws JudgmentError with `INVALID_ANSWER` for any mismatch.
 */
export function readFittedWireResponse(
  body: unknown,
  states: readonly string[],
  questions: readonly JudgmentQuestion[],
  requestedModel: string,
): JudgmentFittingResult {
  if (!isRecord(body)) throw invalid('fitted body is not a JSON object')
  if (body.kind === 'unfit') return readUnfitResponse(body, requestedModel)
  if (body.kind !== 'answered') throw invalid('fitted response has no answered or unfit kind')
  const fit = readTokenFit(body.fit, states.length, questions.length)
  const result = readNestedResult(body.result, questions, requestedModel)
  const state = states[fit.selectedIndex]
  /* v8 ignore next -- readTokenFit bounds the selected index against states. */
  if (state === undefined) throw invalid('fitted selectedIndex has no state')
  return {
    kind: 'answered',
    fit: { ...fit, state },
    result,
  }
}

/** Validate the fitted response's explicit capacity rejection. */
function readUnfitResponse(
  body: Record<string, unknown>,
  requestedModel: string,
): Extract<JudgmentFittingResult, { kind: 'unfit' }> {
  if (body.engine !== SHIELD_ENGINE) throw invalid(`unfit engine is not "${SHIELD_ENGINE}"`)
  const model = body.model
  if (typeof model !== 'string' || model.length === 0) throw invalid('unfit response has no model id')
  if (model !== requestedModel) {
    throw invalid(`unfit response reports model "${model}" instead of requested "${requestedModel}"`)
  }
  const reason = body.reason
  if (reason !== 'state' && reason !== 'head' && reason !== 'option' && reason !== 'batch') {
    throw invalid('unfit response has an invalid capacity reason')
  }
  return {
    kind: 'unfit',
    engine: SHIELD_ENGINE,
    model,
    limits: readTokenLimits(body.limits),
    reason,
  }
}

/** Validate fit metadata and its relationships to the request dimensions. */
function readTokenFit(value: unknown, stateCount: number, questionCount: number): ShieldWireTokenFit {
  if (!isRecord(value)) throw invalid('fitted response has no fit object')
  const selectedIndex = tokenCount(value.selectedIndex, 'selectedIndex')
  if (selectedIndex >= stateCount) throw invalid('fitted selectedIndex is outside the states array')
  const stateTokens = tokenCount(value.stateTokens, 'stateTokens')
  const sequenceValue = value.sequenceTokens
  if (!Array.isArray(sequenceValue) || sequenceValue.length !== questionCount) {
    throw invalid(`fitted sequenceTokens has length ${Array.isArray(sequenceValue) ? sequenceValue.length : 'none'}, expected ${questionCount}`)
  }
  const sequenceTokens = sequenceValue.map((tokenCountValue, index) =>
    positiveTokenCount(tokenCountValue, `sequenceTokens[${index}]`))
  const paddedTokens = tokenCount(value.paddedTokens, 'paddedTokens')
  const limits = readTokenLimits(value.limits)
  const expectedPadded = sequenceTokens.length === 0
    ? 0
    : Math.max(...sequenceTokens) * sequenceTokens.length
  if (paddedTokens !== expectedPadded) {
    throw invalid(`fitted paddedTokens is ${paddedTokens}, expected ${expectedPadded}`)
  }
  if (stateTokens > limits.maxSequenceTokens
    || sequenceTokens.some(tokens => tokens > limits.maxSequenceTokens)) {
    throw invalid('fitted token counts exceed maxSequenceTokens')
  }
  if (sequenceTokens.some(tokens => tokens < stateTokens)) {
    throw invalid('fitted sequenceTokens must include stateTokens')
  }
  if (paddedTokens > limits.maxBatchTokens) throw invalid('fitted paddedTokens exceeds maxBatchTokens')
  return { selectedIndex, stateTokens, sequenceTokens, paddedTokens, limits }
}

/** Validate a complete tokenizer limit record. */
function readTokenLimits(value: unknown): ShieldWireTokenLimits {
  if (!isRecord(value)) throw invalid('fitted response has no token limits')
  return {
    maxSequenceTokens: tokenLimit(value.maxSequenceTokens, 'maxSequenceTokens'),
    maxHeadTokens: tokenLimit(value.maxHeadTokens, 'maxHeadTokens'),
    maxBatchTokens: tokenLimit(value.maxBatchTokens, 'maxBatchTokens'),
    manifestSha256: manifestHash(value.manifestSha256),
  }
}

/** Validate one non-negative safe integer token count. */
function tokenCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalid(`fitted ${field} must be a non-negative safe integer`)
  }
  return value as number
}

/** Validate one positive safe integer token limit. */
function tokenLimit(value: unknown, field: string): number {
  return positiveTokenCount(value, `limits.${field}`)
}

/** Validate one complete question sequence token count. */
function positiveTokenCount(value: unknown, field: string): number {
  const count = tokenCount(value, field)
  if (count === 0) throw invalid(`fitted ${field} must be positive`)
  return count
}

/** Validate the manifest hash used to identify tokenizer/model configuration. */
function manifestHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw invalid('fitted limits manifestSha256 must be a 64-character hexadecimal hash')
  }
  return value
}

/** Validate and reuse the ordinary answer envelope nested in a fitted result. */
function readNestedResult(
  value: unknown,
  questions: readonly JudgmentQuestion[],
  requestedModel: string,
): ReadShieldWireResponse {
  return readWireResponse(value, questions, requestedModel)
}

/** Map one typed question without adding provider prose. */
function toWireQuestion(question: JudgmentQuestion): ShieldWireQuestion {
  switch (question.kind) {
    case 'binary': {
      const criteria = question.criteria
      return {
        kind: 'binary',
        id: question.id,
        instructions: question.instructions,
        ...criteria === undefined ? {} : {
          criteria: {
            ...criteria.yes === undefined ? {} : { yes: criteria.yes },
            ...criteria.no === undefined ? {} : { no: criteria.no },
          },
        },
      }
    }
    case 'choice':
      return {
        kind: 'choice',
        id: question.id,
        instructions: question.instructions,
        options: question.options.map(option => ({
          option: option.option,
          ...option.description === undefined ? {} : { description: option.description },
        })),
      }
    case 'score':
      return {
        kind: 'score',
        id: question.id,
        instructions: question.instructions,
        levels: [...question.levels],
      }
  }
  /* v8 ignore next -- JudgmentQuestion is a closed union at this seam. */
  return assertNever(question)
}

/** Validate one answer and align it with its typed question. */
function readAnswer(question: JudgmentQuestion, answer: Record<string, unknown>): JudgmentAnswer {
  switch (question.kind) {
    case 'binary': {
      if (answer.kind !== 'binary') {
        throw invalid(`question "${question.id}" has answer kind ${describe(answer.kind)}, expected binary`)
      }
      return {
        kind: 'binary',
        id: question.id,
        probability: boundedNumber(answer.probability, question.id, 'probability'),
      }
    }
    case 'choice': {
      if (answer.kind !== 'choice') {
        throw invalid(`question "${question.id}" has answer kind ${describe(answer.kind)}, expected choice`)
      }
      const option = answer.option
      if (typeof option !== 'string' || !question.options.some(entry => entry.option === option)) {
        throw invalid(`question "${question.id}" selects an unasked option`)
      }
      const probabilities = readDistribution(
        answer.probabilities,
        question.options.map(entry => entry.option),
        question.id,
      )
      const selected = probabilities[option]
      /* v8 ignore next -- complete distribution validation supplies every requested option. */
      if (selected === undefined) throw invalid(`question "${question.id}" has no probability for its selected option`)
      const highest = Math.max(...Object.values(probabilities))
      if (selected + DISTRIBUTION_TOLERANCE < highest) {
        throw invalid(`question "${question.id}" selects an option below the distribution argmax`)
      }
      return {
        kind: 'choice',
        id: question.id,
        option,
        probabilities,
        confidence: boundedNumber(answer.confidence, question.id, 'confidence'),
      }
    }
    case 'score': {
      if (answer.kind !== 'score') {
        throw invalid(`question "${question.id}" has answer kind ${describe(answer.kind)}, expected score`)
      }
      const keys = question.levels.map((_level, index) => String(index))
      const probabilities = readDistribution(answer.probabilities, keys, question.id)
      const expected = weightedScore(probabilities, question)
      const score = finiteNumber(answer.score, question.id, 'score')
      if (score < 0 || score > question.levels.length - 1) {
        throw invalid(`question "${question.id}" score is outside its level range`)
      }
      const tolerance = Math.max(DISTRIBUTION_TOLERANCE, question.levels.length * DISTRIBUTION_TOLERANCE)
      if (Math.abs(score - expected) > tolerance) {
        throw invalid(`question "${question.id}" score does not match its probability expectation`)
      }
      return {
        kind: 'score',
        id: question.id,
        score,
        probabilities,
        confidence: boundedNumber(answer.confidence, question.id, 'confidence'),
      }
    }
  }
  /* v8 ignore next -- JudgmentQuestion is a closed union at this seam. */
  return assertNever(question)
}

/** Read a complete probability distribution with the requested keys only. */
function readDistribution(
  value: unknown,
  keys: readonly string[],
  id: string,
): Record<string, number> {
  if (!isRecord(value)) throw invalid(`question "${id}" has no probabilities object`)
  const expected = new Set(keys)
  const actual = Object.keys(value)
  if (actual.length !== keys.length || actual.some(key => !expected.has(key))) {
    throw invalid(`question "${id}" does not provide exactly one probability per requested key`)
  }
  const probabilities = Object.fromEntries(keys.map(key => [
    key,
    boundedNumber(value[key], id, `probability "${key}"`),
  ]))
  const sum = Object.values(probabilities).reduce((total, probability) => total + probability, 0)
  if (Math.abs(sum - 1) > DISTRIBUTION_TOLERANCE) {
    throw invalid(`question "${id}" probabilities sum to ${sum}, outside the normalization tolerance`)
  }
  return probabilities
}

/** Calculate a score from its zero-based level distribution. */
function weightedScore(probabilities: Readonly<Record<string, number>>, question: JudgmentScoreQuestion): number {
  return question.levels.reduce((total, _level, index) => {
    /* v8 ignore next -- complete distribution validation supplies every level key. */
    return total + index * (probabilities[String(index)] ?? 0)
  }, 0)
}

/** Read a finite number constrained to the probability/confidence range. */
function boundedNumber(value: unknown, id: string, field: string): number {
  const number = finiteNumber(value, id, field)
  if (number < 0 || number > 1) throw invalid(`question "${id}" has ${field} outside [0, 1]`)
  return number
}

/** Read a finite numeric field. */
function finiteNumber(value: unknown, id: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`question "${id}" has a non-finite ${field}`)
  }
  return value
}

/** Format an answer discriminant for a useful diagnostic. */
function describe(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : 'no kind'
}

/** Construct the stable provider failure for one unusable response. */
function invalid(detail: string): JudgmentError {
  return new JudgmentError('INVALID_ANSWER', `judgment-shield response ${detail}`)
}

/** Whether a value is a JSON object rather than null or an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keep closed question switches exhaustive if the seam adds a new kind. */
/* v8 ignore next 2 -- the typed seam's question union is closed. */
function assertNever(value: never): never {
  throw new Error(`unsupported judgment kind: ${String(value)}`)
}
