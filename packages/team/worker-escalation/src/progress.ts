/**
 * The Stage 1 ask's state: the numbers-first worker digest.
 *
 * Counts of how the worker's tool calls resolved, the goal epoch's distinct
 * failed approaches, the identical-call chain in force, and the completed steps
 * since its progress floor lead; the trailing `ok`|`FAIL` lines follow last, so
 * the character cap eats them first.
 *
 * No excerpt of any kind is composed here. The error and argument excerpts the
 * Lead's report carries are workspace-derived text, and a judgment engine is
 * told what happened rather than shown what the worker read; Stage 1 configures
 * no switch that could turn either on.
 *
 * @module @shres-code/shres-code-worker-escalation/progress
 */

import { foldProgressFacts, foldToolWindow } from '@shres-code/shres-code-progress-signals'
import type { ProgressFacts, ToolWindowEntry } from '@shres-code/shres-code-progress-signals'
import type { Session } from '@shres-code/shres-code-session'
import type { ResolvedWorkerEscalationConfig } from './config.ts'
import { boundText } from './digest.ts'

/**
 * One trailing tool outcome, as the state renders it.
 * @param entry - the call and the result that answered it.
 * @returns the line: the success marker, the tool name, and the call's seq.
 */
function toolLine(entry: ToolWindowEntry): string {
  return (entry.ok ? 'ok ' : 'FAIL ') + entry.name + ' seq=' + String(entry.seq)
}

/** The numbers-first block, ahead of every tool line. */
function numberLines(facts: ProgressFacts): string[] {
  return [
    'Tool outcomes: ok=' + String(facts.ok) + ' fail=' + String(facts.fail),
    'Distinct failed approaches this goal epoch: ' + String(facts.attemptCount),
    'Identical-call chain in force: ' + String(facts.repeatRunLength),
    'Completed steps since the last verified checkpoint: ' + String(facts.stepsSinceCheckpoint),
  ]
}

/**
 * Compose the state one Stage 1 ask reads from one worker session's committed
 * events.
 * @param session - live worker session whose log to fold.
 * @param config - resolved ladder configuration: its trigger thresholds drive
 *   the folds, `maxDigestTools` bounds the tool window, and `maxDigestChars`
 *   bounds the complete render.
 * @param epochAnchorSeq - exclusive lower bound of the goal epoch.
 * @returns the bounded state text.
 */
export function composeProgressState(
  session: Session,
  config: ResolvedWorkerEscalationConfig,
  epochAnchorSeq: number,
): string {
  const lines = numberLines(foldProgressFacts(session.events, config.triggers, epochAnchorSeq))
  const window = foldToolWindow(session.events, config.maxDigestTools)
  if (window.length > 0) lines.push('Recent tool outcomes:\n' + window.map(toolLine).join('\n'))
  return boundText(lines.join('\n'), config.maxDigestChars)
}
