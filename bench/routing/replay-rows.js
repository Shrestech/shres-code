/**
 * Pure replay labeller of the routing measurement's offline judge replay: it
 * turns one arm-C session log into pinned labelled-scores rows, one per
 * replayed cold-point entry consult, with the §4 label. The consult half
 * (eligibility, answered, winner, confidence, margin, pCheap, difficulty,
 * fit) waits on the router's replayConsultInput handoff; until a row passes
 * through that half it carries `eligible: false, answered: false` and null
 * consult fields, so a premature metric run reads zero eligible rows instead
 * of a fabricated denominator. No model is called and no calibration data is
 * read: the log is a fixture the caller names.
 *
 * Label (prereg §4): a cold point is cheap-sufficient when C passed the task
 * and C's trajectory from that cold point reached the next cold point without
 * a worker-escalation trigger — through the end of the log for the last cold
 * point. The ALL-vs-ELIGIBLE denominators of `computeReplayMetrics` are
 * preserved downstream: this module only labels; it never decides eligibility.
 *
 * @module bench/routing/replay-rows
 */
import { validateReplayRow } from '../analysis/replay-metrics.js'

/** Default session-log event names counted as worker-escalation triggers. */
export const ESCALATION_EVENT_NAMES = ['worker-escalation']

/**
 * The cold-point decisions of one session log, in log order: every
 * `model-routing/decision` that carries a non-null `coldPoint` marks one
 * replayed cold point, identified by its turn and step.
 * @param {readonly { seq?: number, event?: string, data?: Record<string, unknown> }[]} entries - parsed session-log entries.
 * @returns {{ coldPointId: string, seq: number }[]} the cold points in log order.
 */
export function extractColdPoints(entries) {
  const coldPoints = []
  for (const entry of entries) {
    if (entry.event !== 'model-routing/decision') continue
    const coldPoint = entry.data?.coldPoint
    if (coldPoint === null || coldPoint === undefined) continue
    const seq = entry.seq ?? 0
    const step = entry.data?.step
    const turn = entry.data?.turn
    coldPoints.push({
      coldPointId: turn === undefined || step === undefined ? `seq:${seq}` : `turn:${turn}/step:${step}`,
      seq,
    })
  }
  return coldPoints
}

/**
 * The seqs of one log's worker-escalation triggers, ascending.
 * @param {readonly { seq?: number, event?: string }[]} entries - parsed session-log entries.
 * @param {readonly string[]} [eventNames] - event names counted as triggers; defaults to the worker-escalation family.
 * @returns {number[]} ascending seqs.
 */
export function extractEscalationSeqs(entries, eventNames = ESCALATION_EVENT_NAMES) {
  const names = new Set(eventNames)
  return entries
    .filter(entry => entry.event !== undefined && names.has(entry.event))
    .map(entry => entry.seq ?? 0)
    .sort((a, b) => a - b)
}

/**
 * Label one arm-C log into pinned labelled-scores rows. Rows come back in log
 * order with the consult fields unset (`eligible: false, answered: false`,
 * every consult value null) — the consult half of the replay fills them.
 * @param {object} input
 * @param {string} input.task - the task id the log belongs to.
 * @param {'routine' | 'moderate' | 'hard'} input.stratum - the task's preregistered stratum.
 * @param {readonly { seq?: number, event?: string, data?: Record<string, unknown> }[]} input.entries - parsed session-log entries of the arm-C trial.
 * @param {boolean} input.taskPassed - whether C's final verifier passed.
 * @param {readonly string[]} [input.escalationEventNames] - event names counted as worker-escalation triggers.
 * @returns {{ rows: import('../analysis/replay-metrics.js').ReplayRow[], coldPoints: number, escalations: number }} the labelled rows and the raw counts.
 * @throws {TypeError} when the log marks no cold point.
 */
export function labelReplayRows({ task, stratum, entries, taskPassed, escalationEventNames }) {
  const coldPoints = extractColdPoints(entries)
  if (coldPoints.length === 0) throw new TypeError(`task ${JSON.stringify(task)}: the log marks no cold point, so there is nothing to label`)
  const escalations = extractEscalationSeqs(entries, escalationEventNames)
  const lastSeq = entries.reduce((max, entry) => Math.max(max, entry.seq ?? 0), 0)
  const rows = coldPoints.map((coldPoint, index) => {
    const windowEnd = index + 1 < coldPoints.length ? coldPoints[index + 1].seq : lastSeq + 1
    const escaped = escalations.some(seq => seq > coldPoint.seq && seq < windowEnd)
    return validateReplayRow({
      task, stratum, coldPointId: coldPoint.coldPointId,
      eligible: false, answered: false, truncated: null, headTokens: null,
      winner: null, confidence: null, margin: null, pCheap: null, difficultyScore: null,
      cheapSufficient: taskPassed && !escaped,
    }, `cold point ${coldPoint.coldPointId}`)
  })
  return { rows, coldPoints: coldPoints.length, escalations: escalations.length }
}

/**
 * Parse a session-log JSONL document into entries, skipping blank lines and
 * keeping the raw objects; malformed lines throw with their line number.
 * @param {string} text - the JSONL document.
 * @returns {Record<string, unknown>[]} the parsed entries.
 */
export function parseLog(text) {
  return text.split('\n').flatMap((line, index) => {
    if (line.trim() === '') return []
    try {
      return [JSON.parse(line)]
    } catch (error) {
      throw new SyntaxError(`session log line ${index + 1} is not valid JSON (${error.message})`)
    }
  })
}
