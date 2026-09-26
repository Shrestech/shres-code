/**
 * Fitted-judge stage for prepared replay rows. One fitted ask per eligible
 * row; unanswered rows keep null score fields. Prepare-only paths never call
 * this module.
 * @module
 */
import { JudgmentError, judgmentEnabled } from '../../packages/llm/judgment/lib/index.js'
import {
  DIFFICULTY_QUESTION_ID,
  KEEP_CURRENT_OPTION_ID,
  MODEL_ROUTER_JUDGMENT_CONSUMER,
  ROUTE_QUESTION_ID,
  routeMargin,
  routingCalibration,
} from '../../packages/llm/model-router/lib/index.js'
import { UsageError } from '../runner/run.js'
import { validateReplayRow } from '../analysis/replay-metrics.js'

function unanswered(row) {
  return {
    ...row,
    answered: false,
    truncated: null,
    headTokens: null,
    winner: null,
    confidence: null,
    margin: null,
    pCheap: null,
    difficultyScore: null,
  }
}

function finiteUnit(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function routeAnswerValid(route, questions) {
  if (route === undefined || route.kind !== 'choice' || route.id !== ROUTE_QUESTION_ID) return false
  const question = questions.find(entry => entry.id === ROUTE_QUESTION_ID)
  const options = (question?.options ?? []).map(entry => entry.option ?? entry.id ?? entry)
  if (!options.includes(KEEP_CURRENT_OPTION_ID)) return false
  if (route.probabilities === undefined || typeof route.probabilities !== 'object') return false
  for (const option of options) {
    if (!finiteUnit(route.probabilities[option])) return false
  }
  return typeof route.option === 'string' && options.includes(route.option)
}

function scoreAnswerValid(score) {
  return score !== undefined && score.kind === 'score' && score.id === DIFFICULTY_QUESTION_ID && typeof score.score === 'number'
}

function mapAnswered(row, fit, result, questions) {
  const answers = result.answers ?? []
  const route = answers.find(entry => entry.id === ROUTE_QUESTION_ID)
  const score = answers.find(entry => entry.id === DIFFICULTY_QUESTION_ID)
  if (!routeAnswerValid(route, questions) || !scoreAnswerValid(score)) return { row: unanswered(row), outcome: 'invalid-answer' }
  const p = route.probabilities
  const sequenceTokens = fit.sequenceTokens ?? []
  const maxSeq = sequenceTokens.length === 0 ? fit.stateTokens : Math.max(...sequenceTokens)
  return {
    row: {
      ...row,
      answered: true,
      truncated: fit.selectedIndex > 0,
      headTokens: maxSeq - fit.stateTokens,
      winner: route.option,
      confidence: route.confidence,
      margin: routeMargin(p),
      pCheap: 1 - p[KEEP_CURRENT_OPTION_ID],
      difficultyScore: score.score,
    },
    outcome: 'answered',
  }
}

function preflight({ engine, config }) {
  if (engine === undefined) throw new UsageError('calibration replay requires a judgment engine')
  if (!judgmentEnabled(engine.settings)) throw new UsageError('calibration replay requires judgment to be enabled')
  const fitting = engine.fittingFor(MODEL_ROUTER_JUDGMENT_CONSUMER)
  if (fitting === undefined) {
    throw new UsageError('calibration replay requires a fitting judgment engine; the selected engine has none')
  }
  if (config.difficultyInstructions === undefined) {
    throw new UsageError('calibration replay requires the R composition to ask the difficulty question (difficultyInstructions); the answered-row schema requires difficultyScore')
  }
  const engineId = engine.selectedEngine?.(MODEL_ROUTER_JUDGMENT_CONSUMER)
  const registry = engine.ctx?.get?.('judgmentEngines')
  const descriptor = engineId === undefined ? undefined : registry?.get?.(engineId)?.descriptor
  const point = engineId === undefined ? undefined : config.operatingPoints?.[engineId]
  if (routingCalibration(descriptor?.calibration, point).kind === 'refused') {
    throw new UsageError('calibration replay requires a non-refused routing calibration')
  }
  return fitting
}

/**
 * Judge prepared replay rows with one fitted ask per eligible consult.
 * @param {object} input
 * @returns {Promise<{ rows: object[], asks: object[] }>}
 */
export async function judgeReplayRows({ rows, consults, engine, config, sessionId, signal }) {
  const fitting = preflight({ engine, config })
  const asks = []
  const judged = []
  for (const row of rows) {
    if (row.eligible !== true) {
      judged.push(unanswered(row))
      continue
    }
    const consult = consults.find(entry => entry.turn === row.turn && entry.step === row.step)
    if (consult === undefined || consult.result?.kind !== 'ask') {
      throw new TypeError('eligible row ' + String(row.turn) + '/' + String(row.step) + ' has no ask consult')
    }
    const deadline = AbortSignal.timeout(config.judgmentDeadlineMs)
    const askSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    const correlation = { sessionId, consultKey: 'turn:' + String(row.turn) + '/step:' + String(row.step) }
    const started = Date.now()
    let outcome = 'error:UNAVAILABLE'
    let next = unanswered(row)
    try {
      const fitted = await fitting.ask({
        states: consult.result.states,
        questions: consult.result.questions,
        tier: config.tier,
        signal: askSignal,
        consumer: MODEL_ROUTER_JUDGMENT_CONSUMER,
        correlation,
      })
      if (deadline.aborted) {
        outcome = 'deadline'
      } else if (fitted.kind === 'unfit') {
        outcome = 'unfit:' + String(fitted.reason)
      } else if (fitted.kind === 'answered') {
        const mapped = mapAnswered(row, fitted.fit, fitted.result, consult.result.questions)
        next = mapped.row
        outcome = mapped.outcome
      } else {
        outcome = 'invalid-answer'
      }
    } catch (error) {
      if (error instanceof JudgmentError && error.code === 'ABORTED' && signal?.aborted) throw error
      if (deadline.aborted) outcome = 'deadline'
      else if (error instanceof JudgmentError) outcome = 'error:' + error.code
      else throw error
    }
    asks.push({ turn: row.turn, step: row.step, outcome, latencyMs: Date.now() - started })
    judged.push(next)
  }
  for (const [index, row] of judged.entries()) validateReplayRow(row, 'judge ' + String(index))
  return { rows: judged, asks }
}
