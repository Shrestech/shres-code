/**
 * The seeded decision core of the bench-random engine, free of Cordis types
 * so the draws are unit-testable without a mounted context.
 *
 * Each consult draws `u = hash(seed, sessionId, turn, step)`: a stateless
 * hash of the session identity and the consult's turn and step, so the draw
 * replays from the log alone and a rerun can never drift from the recorded
 * sequence. `u < entryRate` selects the downgrade candidate, otherwise the
 * current route; the answered probabilities are exactly 1 and confidence 1,
 * so the draw is the only decision variable and the consumer's thresholds
 * cannot reshape the matched rate. Non-choice questions are answered
 * neutrally — a score ask returns the lowest level, a binary ask returns 0 —
 * so a difficulty gate can never block the entry the draw selected.
 *
 * @module
 */

import type { ResolvedBenchRandomConfig } from './config.ts'

/** Option key the model router reserves for keeping the current route. */
export const KEEP_CURRENT_OPTION = 'keep-current'

/** Confidence the engine reports on every choice answer. */
export const ANSWER_CONFIDENCE = 1

/** Probability mass the engine puts on the selected option of a choice question. */
export const SELECTED_PROBABILITY = 1

/** One answer produced for one question, mirroring the judgment seam's answer vocabulary. */
export type BenchRandomAnswer =
  | { kind: 'choice'; id: string; option: string; probabilities: Record<string, number>; confidence: number }
  | { kind: 'score'; id: string; score: number; probabilities: Record<string, number>; confidence: number }
  | { kind: 'binary'; id: string; probability: number }

/** Minimal structural view of one asked question, keyed like the judgment seam's. */
export interface BenchRandomQuestion {
  kind: string
  id: string
  options?: readonly { option: string }[]
  levels?: readonly string[]
}

/** The session facts one consult is keyed on; the caller supplies the ask's correlation. */
export interface BenchRandomCorrelation {
  /** Session the consult belongs to. */
  sessionId: string
  /** The consumer-defined consult key, unique within the session. */
  consultKey: string
}

/**
 * The stateless draw for one consult: FNV-1a over the correlation facts mixed
 * with the seed, normalized to [0, 1). The same (seed, sessionId, consultKey)
 * always yields the same u, and every input is reconstructable from the log.
 * @param seed - the configured 32-bit seed.
 * @param correlation - the session facts the consult is keyed on.
 * @returns the uniform draw in [0, 1).
 */
export function hashDraw(seed: number, correlation: BenchRandomCorrelation): number {
  let hash = 0x811c9dc5 ^ (seed >>> 0)
  const parts = [correlation.sessionId, correlation.consultKey]
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      hash ^= part.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
  }
  return (hash >>> 0) / 0x1_0000_0000
}

/**
 * Answer one consult's questions from its draw.
 * @param config - the validated entry rate.
 * @param correlation - the session facts the draw is keyed on.
 * @param questions - the asked questions, in order.
 * @returns the answers and the draw the consult consumed.
 */
export function consult(
  config: ResolvedBenchRandomConfig,
  correlation: BenchRandomCorrelation,
  questions: readonly BenchRandomQuestion[],
): { answers: BenchRandomAnswer[]; draw: number } {
  const draw = hashDraw(config.seed, correlation)
  const choice = questions.find(question => question.kind === 'choice')
  if (choice === undefined) {
    return { answers: questions.map(question => neutral(question)), draw }
  }
  const downgrade = draw < config.entryRate
  const options = (choice.options ?? []).map(option => option.option)
  const selected = downgrade
    ? options.find(option => option !== KEEP_CURRENT_OPTION) ?? options[0]
    : options.find(option => option === KEEP_CURRENT_OPTION) ?? options[options.length - 1]
  if (selected === undefined) {
    throw new Error('bench-random consult received a choice question with no options')
  }
  const probabilities: Record<string, number> = {}
  for (const option of options) probabilities[option] = option === selected ? SELECTED_PROBABILITY : 0
  const byId = new Map<string, BenchRandomAnswer>([[
    choice.id,
    { kind: 'choice', id: choice.id, option: selected, probabilities, confidence: ANSWER_CONFIDENCE },
  ]])
  return { answers: questions.map(question => byId.get(question.id) ?? neutral(question)), draw }
}

function neutral(question: BenchRandomQuestion): BenchRandomAnswer {
  if (question.kind === 'score') {
    return { kind: 'score', id: question.id, score: 0, probabilities: { '0': 1 }, confidence: 1 }
  }
  if (question.kind === 'binary') {
    return { kind: 'binary', id: question.id, probability: 0 }
  }
  throw new Error(`bench-random consult received an unsupported question kind ${question.kind}`)
}
