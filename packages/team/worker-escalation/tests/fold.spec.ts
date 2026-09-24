/**
 * The aging counter and the step cooldown over a bare session log: the two
 * folds over this package's own `escalation/decision` events. The trigger
 * verdicts they gate on are pinned where their folds live, in
 * `@shres-code/shres-code-progress-signals`.
 *
 * The logs are bare event arrays: a fold reads only what a case appends, so no
 * store, invariant host, or service topology enters these cases.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@shres-code/shres-code-session'
import { foldEscalationAging, foldEscalationCooldown } from '../src/fold.ts'
import type { EscalationDecision } from '../src/types.ts'

/** One logged event carrying only the fields the folds read. */
function event(type: string, seq: number, data: unknown): SessionEvent {
  return { type, seq, time: 0, data } as unknown as SessionEvent
}

/** One completed step. */
function stepEnd(seq: number): SessionEvent {
  return event('step/end', seq, { turn: 1, step: 1 })
}

/** One logged ladder decision. */
function decision(seq: number, data: EscalationDecision): SessionEvent {
  return event('escalation/decision', seq, data)
}

/** One `continue` decision recording the aging state after itself. */
function continued(seq: number, continues: number): SessionEvent {
  return decision(seq, {
    trigger: 'errorBurst',
    triggerSeq: 1,
    choice: 'continue',
    engine: 'absent',
    reason: 'engine-absent',
    aging: { continues, lastContinueSeq: seq },
  })
}

/** The terminal decision, which records its inherited continue count. */
function reportedBlocked(seq: number, continues: number): SessionEvent {
  return decision(seq, {
    trigger: 'errorBurst',
    triggerSeq: 1,
    choice: 'report-blocked',
    reason: 'max-continues',
    aging: { continues },
  })
}

/** A `needs-help` decision: a passed gate whose choice the ladder records and does not act on. */
function needsHelp(seq: number, continues: number): SessionEvent {
  return decision(seq, {
    trigger: 'errorBurst',
    triggerSeq: 1,
    choice: 'needs-help',
    engine: 'ok',
    reason: 'gate-passed',
    confidence: 0.9,
    margin: 0.8,
    aging: { continues, lastContinueSeq: seq },
  })
}

describe('foldEscalationAging', () => {
  it('folds an empty epoch to no continues, no last-continue seq, and no terminal', () => {
    expect(foldEscalationAging([])).toEqual({ continues: 0, reportBlocked: false })
  })

  it('counts continue resolutions and points at the newest one', () => {
    expect(foldEscalationAging([continued(1, 1), continued(5, 2)]))
      .toEqual({ continues: 2, lastContinueSeq: 5, reportBlocked: false })
  })

  it('latches the report-blocked terminal without counting it as a continue', () => {
    expect(foldEscalationAging([continued(1, 1), reportedBlocked(4, 1)]))
      .toEqual({ continues: 1, lastContinueSeq: 1, reportBlocked: true })
  })

  it('excludes every decision at or below the epoch anchor', () => {
    const events = [continued(1, 1), continued(4, 2), reportedBlocked(6, 2)]
    expect(foldEscalationAging(events, 4)).toEqual({ continues: 0, reportBlocked: true })
    expect(foldEscalationAging(events, 3)).toEqual({ continues: 1, lastContinueSeq: 4, reportBlocked: true })
    expect(foldEscalationAging(events, 0)).toEqual({ continues: 2, lastContinueSeq: 4, reportBlocked: true })
  })

  it('counts a needs-help decision as a continue resolution', () => {
    // Stage 1 executes nothing on the ask's choice, so a needs-help decision
    // advances the epoch exactly as a continue does and the terminal stays
    // reachable while the ask keeps answering it.
    expect(foldEscalationAging([continued(1, 1), needsHelp(4, 2)]))
      .toEqual({ continues: 2, lastContinueSeq: 4, reportBlocked: false })
  })
})

describe('foldEscalationCooldown', () => {
  it('counts every completed step of an epoch with no decision', () => {
    expect(foldEscalationCooldown([stepEnd(1), stepEnd(2), stepEnd(3)]))
      .toEqual({ stepsSinceLastDecision: 3 })
  })

  it('counts steps after the newest decision and reports its seq', () => {
    expect(foldEscalationCooldown([stepEnd(1), continued(2, 1), stepEnd(3), stepEnd(4)]))
      .toEqual({ lastDecisionSeq: 2, stepsSinceLastDecision: 2 })
  })

  it('takes the newest decision of any choice', () => {
    expect(foldEscalationCooldown([continued(1, 1), reportedBlocked(3, 1), stepEnd(4)]))
      .toEqual({ lastDecisionSeq: 3, stepsSinceLastDecision: 1 })
  })

  it('falls back to the epoch anchor for a decision outside the epoch', () => {
    expect(foldEscalationCooldown([continued(1, 1), stepEnd(3), stepEnd(4)], 2))
      .toEqual({ stepsSinceLastDecision: 2 })
  })
})
