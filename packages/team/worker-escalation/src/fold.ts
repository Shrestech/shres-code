/**
 * Pure folds over this package's own `escalation/decision` events: the
 * goal-epoch aging counter and the step cooldown. The trigger verdicts they gate
 * on come from `@shres-code/shres-code-progress-signals`. Nothing here keeps
 * live memory — resume, fork, and compaction restore every state from the log
 * alone, which is what lets a restarted worker continue a half-aged epoch and
 * lets a bench replay one.
 *
 * @module @shres-code/shres-code-worker-escalation/fold
 */

import type { SessionEvent } from '@shres-code/shres-code-session'

/** The aging state one goal epoch reaches: its continue resolutions and the terminal latch. */
export interface EscalationAgingState {
  /** Continue resolutions the epoch has taken. */
  readonly continues: number
  /** Seq of the newest continue resolution; absent before the first. */
  readonly lastContinueSeq?: number
  /** Whether the epoch already reported the worker blocked, which is its one-shot terminal. */
  readonly reportBlocked: boolean
}

/**
 * Fold the aging state of one goal epoch.
 * @param events - the session log or any prefix of it.
 * @param epochAnchorSeq - exclusive lower bound of the goal epoch: the jspace
 *   card's `goalOpenedSeq`, or -1 to fold the whole log.
 * @returns the epoch's continue count, its newest continue seq, and whether its
 *   terminal already fired.
 */
export function foldEscalationAging(events: readonly SessionEvent[], epochAnchorSeq: number = -1): EscalationAgingState {
  let continues = 0
  let lastContinueSeq: number | undefined
  let reportBlocked = false
  for (const event of events) {
    if (event.type !== 'escalation/decision' || event.seq <= epochAnchorSeq) continue
    if (event.data.choice === 'report-blocked') {
      reportBlocked = true
      continue
    }
    continues += 1
    lastContinueSeq = event.seq
  }
  return {
    continues,
    reportBlocked,
    ...lastContinueSeq === undefined ? {} : { lastContinueSeq },
  }
}

/** The step cooldown state of one goal epoch. */
export interface EscalationCooldownState {
  /** Seq of the newest ladder decision in the epoch; absent before the first. */
  readonly lastDecisionSeq?: number
  /** Completed steps since that decision, or since the epoch's anchor when there is none. */
  readonly stepsSinceLastDecision: number
}

/**
 * Fold the step cooldown the ladder gates on: completed steps since the newest
 * decision, so a standing trigger cannot write a decision per event.
 * @param events - the session log or any prefix of it.
 * @param epochAnchorSeq - exclusive lower bound of the goal epoch: the jspace
 *   card's `goalOpenedSeq`, or -1 to fold the whole log.
 * @returns the newest decision seq and the completed steps since it.
 */
export function foldEscalationCooldown(
  events: readonly SessionEvent[],
  epochAnchorSeq: number = -1,
): EscalationCooldownState {
  let lastDecisionSeq: number | undefined
  for (const event of events) {
    if (event.type === 'escalation/decision' && event.seq > epochAnchorSeq) lastDecisionSeq = event.seq
  }
  const from = lastDecisionSeq ?? epochAnchorSeq
  let steps = 0
  for (const event of events) {
    if (event.type === 'step/end' && event.seq > from) steps += 1
  }
  return {
    stepsSinceLastDecision: steps,
    ...lastDecisionSeq === undefined ? {} : { lastDecisionSeq },
  }
}
