/**
 * Proactive review machinery: trigger classification (event triggers plus the
 * step-cadence drift check), reviewer persona and prompt, and the settle
 * mapping for a one-shot reviewer run. All cadence and dedup state derives
 * from the session log so replays and forks reconstruct it.
 * @module @shres-code/shres-code-jspace-advisor/review
 */

import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import type { SubagentResult } from '@shres-code/shres-code-subagent'
import type { ObjectJsonSchema } from '@shres-code/shres-code-tools'
import { stopReasonError, withPartialText } from './consult.ts'
import { renderAdvisorDigest } from './digest.ts'
import type { JspaceAdvisorDigest, AdvisorTrigger } from './types.ts'

/** Built-in reviewer persona; overridable via Config. */
export const DEFAULT_REVIEWER_PERSONA =
  'You are the jspace advisor, a reviewer model watching a bounded digest of the main session. '
  + 'The digest carries the user messages (U1, U2, ...) — the ground truth of the user goal, '
  + 'U1 always retained — and the session card, which is only what the session believes its '
  + 'goal is and may be stale or a placeholder. Judge the recent work against the USER goal, '
  + 'not the card. Gather context with the read-only tools available to you. '
  + 'When the work serves the goal: verdict on-track, one-line advice. When it drifts: verdict '
  + 'drift, advice naming the drift in one sentence, and redirect giving the exact correction — '
  + 'what to drop and what to do next to serve the goal.'

/**
 * Default reviewer tool filter: durable knowledge reads mounted in every
 * shipped bundle. The session_query family (session_search,
 * session_event_search, session_event_read) requires the deployment to mount
 * tool-session-query; the tool filter rejects unknown names loudly.
 */
export const DEFAULT_REVIEWER_TOOLS = [
  'wiki_search',
  'wiki_read',
] as const

/** Whether a session is a root (not a delegated child). */
export function isRootSession(session: Session): boolean {
  return session.header.parentSession === undefined
}

/** Structured reviewer verdict for one proactive run. */
export interface ReviewVerdict {
  /** Whether the session is serving the user's goal. */
  readonly verdict: 'on-track' | 'drift'
  /** One-sentence assessment. */
  readonly advice: string
  /** Exact correction back to the goal; expected on drift. */
  readonly redirect?: string
}

/** Object-rooted JSON Schema for the structured proactive verdict, in the enforced subset. */
export const REVIEW_OUTPUT_JSON_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'advice'],
  properties: {
    verdict: { type: 'string', enum: ['on-track', 'drift'] },
    advice: { type: 'string' },
    redirect: { type: 'string' },
  },
}

/**
 * Settle a proactive reviewer run into its structured verdict.
 * @param result - the child's terminal result.
 * @returns the structured verdict.
 * @throws {Error} when the run did not complete or returned no verdict.
 */
export function settleReview(result: SubagentResult): ReviewVerdict {
  const error = stopReasonError(result)
  if (error !== undefined) throw new Error(withPartialText(error, result.output))
  const structured = result.structured as ReviewVerdict | undefined
  if (structured === undefined || typeof structured.advice !== 'string'
    || (structured.verdict !== 'on-track' && structured.verdict !== 'drift')) {
    throw new Error('jspace-advisor reviewer returned no structured verdict')
  }
  return structured
}

/**
 * Build the reviewer prompt for one proactive review: the rendered digest
 * plus the trigger that woke it.
 * @param digest - folded advisory digest.
 * @param trigger - why the review ran.
 * @returns the prompt text.
 */
export function buildReviewPrompt(digest: JspaceAdvisorDigest, trigger: AdvisorTrigger): string {
  return renderAdvisorDigest(digest) + '\n\nTrigger: ' + trigger + '\n'
    + 'Review the main session against the user goal above. Return a structured verdict.'
}

/** Whether the event is an errored, tool-sourced tool/result. */
export function isErroredToolResult(event: SessionEvent): boolean {
  if (event.type !== 'tool/result') return false
  const message = (event.data as {
    message?: { source?: { kind?: string }; content?: ReadonlyArray<{ type?: string; isError?: boolean }> }
  }).message
  if (message?.source?.kind !== 'tool') return false
  return message.content?.find(part => part.type === 'tool-result')?.isError === true
}

/** Goal of the last jspace/card event before `seq`, or `undefined`. */
function previousCardGoal(log: readonly SessionEvent[], seq: number): string | undefined {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index]
    if (event === undefined || event.type !== 'jspace/card' || event.seq >= seq) continue
    return event.data.goal
  }
  return undefined
}

/**
 * Consecutive errored tool results ending at `seq`. Consecutive means among
 * tool results: interleaved tool/call and other events do not reset the run;
 * the first successful tool-sourced result ends it.
 */
function countConsecutiveErrors(log: readonly SessionEvent[], seq: number): number {
  let count = 0
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index]
    if (event === undefined || event.seq > seq) continue
    if (event.type !== 'tool/result') continue
    const message = (event.data as { message?: { source?: { kind?: string } } }).message
    if (message?.source?.kind !== 'tool') continue
    if (!isErroredToolResult(event)) break
    count += 1
  }
  return count
}

/**
 * Classify one committed event as a proactive review trigger, or `undefined`.
 * step/end events are not handled here — the drift cadence is
 * {@link classifyDrift}. Charter discrimination probes (phase 'probe') are
 * harness machinery, not session failures, and never trigger.
 * Coalescing (one review per user turn) is applied by the caller.
 * @param event - the committed session event.
 * @param log - the session log (the event may already be appended).
 * @param errorBurst - consecutive errored tool results that count as a burst.
 * @returns the trigger, or `undefined`.
 */
export function classifyTrigger(
  event: SessionEvent,
  log: readonly SessionEvent[],
  errorBurst: number,
): AdvisorTrigger | undefined {
  if (event.type === 'jspace/charter-run') {
    if (event.data.phase === 'probe') return undefined
    if (event.data.phase === 'ship') return 'ship-attempt'
    if (!event.data.passed) return 'charter-fail'
    return undefined
  }
  if (event.type === 'jspace/card') {
    const previous = previousCardGoal(log, event.seq)
    if (previous !== undefined && previous !== event.data.goal) return 'goal-epoch'
    return undefined
  }
  if (isErroredToolResult(event)) {
    return countConsecutiveErrors(log, event.seq) >= errorBurst ? 'error-burst' : undefined
  }
  return undefined
}

/** The latest logged jspace/advisor event, or `undefined`. */
export function latestAdvice(log: readonly SessionEvent[]): SessionEvent<'jspace/advisor'> | undefined {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index]
    if (event === undefined) continue
    if (event.type === 'jspace/advisor') return event
  }
  return undefined
}

/**
 * The drift cadence: `drift-check` once every `everySteps` completed steps
 * since the last recorded advice (or since session start), computed from the
 * log. The caller applies the one-per-turn suppression.
 * @param log - the session log.
 * @param everySteps - cadence in completed model steps.
 * @returns 'drift-check' when the cadence fires, else `undefined`.
 */
export function classifyDrift(log: readonly SessionEvent[], everySteps: number): AdvisorTrigger | undefined {
  const advice = latestAdvice(log)
  const since = advice === undefined ? -1 : advice.seq
  let steps = 0
  for (const event of log) {
    if (event.type === 'step/end' && event.seq > since) steps += 1
  }
  return steps >= everySteps ? 'drift-check' : undefined
}

/**
 * One review per user turn, and no repeated verdict until the user speaks:
 * suppress when the latest advice is newer than the latest human message.
 * Continuation wakes are not user speech, so an unanswered redirect never
 * re-fires.
 * @param log - the session log.
 * @returns true when no new review should run.
 */
export function suppressReview(log: readonly SessionEvent[]): boolean {
  const advice = latestAdvice(log)
  if (advice === undefined) return false
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index]
    if (event === undefined) continue
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      return advice.seq > event.seq
    }
  }
  return true
}
