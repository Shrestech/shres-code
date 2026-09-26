/**
 * Offline trajectory labels over caller-supplied cold points and decoded events.
 * No cold points are inferred and no model or calibration runs. Arm C remains
 * always-cheap; progress-signal verdicts are computed without route effects.
 * A half-open window fires if a prefix within it has a fired verdict whose
 * evidence is in that window. Earlier run state carries forward, but a standing
 * verdict with only earlier evidence does not count. Every prefix is checked
 * so a later success cannot erase a transient failure. Unresolved labels are
 * retained, and consult fields remain empty for the replay input producer.
 * @module
 */
import { foldEscalationTriggers } from '../../packages/team/progress-signals/lib/index.js'
import { LABELLER_METHOD_FIELDS, parseReplayMethod } from './replay-method.js'

/** Detect new trigger evidence in a half-open window, preserving whole-log runs. */
function windowFired(events, start, end, triggerTable) {
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event.seq < start) continue
    if (event.seq >= end) break
    const verdicts = foldEscalationTriggers(events.slice(0, index + 1), triggerTable, -1)
    if (verdicts.some(v => v.fired && v.triggerSeq >= start && v.triggerSeq < end)) return true
  }
  return false
}

/**
 * Label every supplied cold point, preserving unresolved rows and method identity.
 * @param {object} input
 * @param {object[]} input.events - ordered decoded logical session events.
 * @param {{ turn: number, step: number, stepStartSeq: number }[]} input.coldPoints - ordered cold-point boundaries supplied by the replay frontend.
 * @param {boolean} input.taskPassed - final verifier result for the source trial.
 * @param {'S' | 'C'} input.arm - source arm.
 * @param {object} input.method - explicit replay method; absent label inputs refuse.
 * @returns {{ rows: object[], coldPoints: number }} rows with empty consult fields and explicit labels.
 */
export function labelColdPoints({ events, coldPoints, taskPassed, arm, method: inputMethod }) {
  const { method, methodSha256 } = parseReplayMethod(inputMethod, { require: LABELLER_METHOD_FIELDS })
  if (arm !== 'S' && arm !== 'C') throw new TypeError('label source arm must be S or C')
  if (typeof taskPassed !== 'boolean') throw new TypeError('taskPassed must be a boolean')
  if (!Array.isArray(coldPoints)) throw new TypeError('coldPoints must be an ordered array')
  for (const [index, point] of coldPoints.entries()) {
    for (const key of ['turn', 'step', 'stepStartSeq']) {
      if (!Number.isSafeInteger(point[key]) || point[key] < 0) throw new TypeError('cold point carries invalid ' + key)
    }
    if (index > 0 && point.stepStartSeq <= coldPoints[index - 1].stepStartSeq) throw new TypeError('coldPoints must have strictly increasing stepStartSeq')
  }
  const rows = coldPoints.map((point, index) => {
    const last = index + 1 === coldPoints.length
    let label
    if (method.labelSources[arm] !== 'c-trajectory') {
      label = { status: 'unlabelled', reason: 'no-label-source-for-arm' }
    } else if (last && method.finalWindow === 'unlabelled') {
      label = { status: 'unlabelled', reason: 'final-window-unlabelled' }
    } else {
      const end = last ? Infinity : coldPoints[index + 1].stepStartSeq
      label = {
        status: 'labelled', source: 'c-trajectory', triggerTableId: method.triggerTableId,
        cheapSufficient: taskPassed && !windowFired(events, point.stepStartSeq, end, method.triggerTable),
      }
    }
    return {
      arm, methodSha256, coldPointId: 'turn:' + point.turn + '/step:' + point.step,
      turn: point.turn, step: point.step, stepStartSeq: point.stepStartSeq, label,
      eligible: false, answered: false, truncated: null, headTokens: null,
      winner: null, confidence: null, margin: null, pCheap: null, difficultyScore: null,
    }
  })
  return { rows, coldPoints: rows.length }
}
