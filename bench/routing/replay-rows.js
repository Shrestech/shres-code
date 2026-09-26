/**
 * Pure replay labeller of the routing measurement's offline judge replay: it
 * turns one decoded session log plus caller-supplied cold points into pinned
 * labelled-scores rows, one per replayed cold-point consult, with the §4
 * label. The consult half (eligibility, answered, winner, confidence, margin,
 * pCheap, difficulty, fit) waits on the router's replayConsultInput handoff;
 * until a row passes through that half it carries `eligible: false,
 * answered: false` and null consult fields, so a premature metric run reads
 * zero eligible rows instead of a fabricated denominator. No model is called
 * and no calibration data is read.
 *
 * Inputs and what they must already be when they arrive:
 *
 * - `events` are decoded logical-log events of one arm trial — the actual
 *   storage codec's output, with ignorable events retained (`escalation/decision`
 *   is an ignorable event and is the worker-escalation trigger record this
 *   module counts; a decode that drops ignorable events silently un-escapes
 *   every row).
 * - `coldPoints` are supplied by the caller: the stable
 *   `turn:<turn>/step:<step>` ids and window seqs come from the router's
 *   public replay handoff (`coldPointAt` at the opening step), never from
 *   this module. S and C calibration arms carry no router decision events, so
 *   cold points are not inferable from a log, and how an S trial is labelled
 *   is an unresolved owner-method decision this module does not preempt: it
 *   labels exactly the cold points it is given and leaves every metric
 *   eligibility decision downstream.
 *
 * Label (prereg §4): a cold point is cheap-sufficient when the trial passed
 * the task and its trajectory from that cold point reached the next cold
 * point without a worker-escalation trigger — through the end of the log for
 * the last cold point. The window position of a trigger is its
 * `data.triggerSeq` (the event that satisfied the trigger), not the decision
 * event's own seq, and any decision choice counts as fired. The
 * ALL-vs-ELIGIBLE denominators of `computeReplayMetrics` are preserved
 * downstream: this module only labels; it never decides eligibility.
 *
 * @module bench/routing/replay-rows
 */
import { validateReplayRow } from '../analysis/replay-metrics.js'

/** Default session-log event types counted as worker-escalation triggers. */
export const ESCALATION_EVENT_NAMES = ['escalation/decision']

/**
 * The worker-escalation trigger window seqs of one decoded log, ascending.
 * Every matching event counts as a fired trigger regardless of its choice;
 * its position is the seq of the event that satisfied the trigger
 * (`data.triggerSeq`), so a decision appended after the trigger's evidence
 * still escapes the window that evidence opened.
 * @param {readonly { type?: string, data?: Record<string, unknown> }[]} events - decoded session-log events.
 * @param {readonly string[]} [eventTypes] - event types counted as triggers; defaults to the worker-escalation family.
 * @returns {number[]} ascending trigger seqs.
 * @throws {TypeError} when a matching event carries no safe-integer `data.triggerSeq`.
 */
export function extractEscalationTriggerSeqs(events, eventTypes = ESCALATION_EVENT_NAMES) {
  const names = new Set(eventTypes)
  const triggerSeqs = []
  for (const event of events) {
    if (event.type === undefined || !names.has(event.type)) continue
    const triggerSeq = event.data?.triggerSeq
    if (typeof triggerSeq !== 'number' || !Number.isSafeInteger(triggerSeq)) {
      throw new TypeError(`escalation event ${JSON.stringify(event.type)} carries no safe-integer data.triggerSeq, so its §4 window position is unknowable`)
    }
    triggerSeqs.push(triggerSeq)
  }
  return triggerSeqs.sort((a, b) => a - b)
}

/**
 * Label one arm trial into pinned labelled-scores rows. Rows come back in
 * cold-point order with the consult fields unset (`eligible: false,
 * answered: false`, every consult value null) — the consult half of the
 * replay fills them.
 * @param {object} input
 * @param {string} input.task - the task id the trial belongs to.
 * @param {'routine' | 'moderate' | 'hard'} input.stratum - the task's preregistered stratum.
 * @param {readonly { type?: string, data?: Record<string, unknown> }[]} input.events - decoded session-log events of the arm trial.
 * @param {readonly { coldPointId: string, seq: number }[]} input.coldPoints - the trial's cold points in the router's stable id form, from the caller's replay handoff.
 * @param {boolean} input.taskPassed - whether the trial's final verifier passed.
 * @param {readonly string[]} [input.escalationEventTypes] - event types counted as worker-escalation triggers.
 * @returns {{ rows: import('../analysis/replay-metrics.js').ReplayRow[], coldPoints: number, triggers: number }} the labelled rows and the raw counts.
 * @throws {TypeError} when the caller supplies no cold point or a malformed cold point.
 */
export function labelReplayRows({ task, stratum, events, coldPoints, taskPassed, escalationEventTypes }) {
  if (!Array.isArray(coldPoints) || coldPoints.length === 0) {
    throw new TypeError(`task ${JSON.stringify(task)}: the caller supplied no cold point, so there is nothing to label`)
  }
  const points = coldPoints.map((coldPoint, index) => {
    if (typeof coldPoint?.coldPointId !== 'string' || coldPoint.coldPointId === '') {
      throw new TypeError(`task ${JSON.stringify(task)}: cold point ${index} carries no coldPointId`)
    }
    if (typeof coldPoint.seq !== 'number' || !Number.isSafeInteger(coldPoint.seq)) {
      throw new TypeError(`cold point ${coldPoint.coldPointId} carries no safe-integer seq`)
    }
    return coldPoint
  }).sort((a, b) => a.seq - b.seq)
  const lastSeq = events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0)
  const triggers = extractEscalationTriggerSeqs(events, escalationEventTypes)
  const rows = points.map((coldPoint, index) => {
    const windowEnd = index + 1 < points.length ? points[index + 1].seq : lastSeq + 1
    const escaped = triggers.some(seq => seq > coldPoint.seq && seq < windowEnd)
    return validateReplayRow({
      task, stratum, coldPointId: coldPoint.coldPointId,
      eligible: false, answered: false, truncated: null, headTokens: null,
      winner: null, confidence: null, margin: null, pCheap: null, difficultyScore: null,
      cheapSufficient: taskPassed && !escaped,
    }, `cold point ${coldPoint.coldPointId}`)
  })
  return { rows, coldPoints: points.length, triggers: triggers.length }
}
