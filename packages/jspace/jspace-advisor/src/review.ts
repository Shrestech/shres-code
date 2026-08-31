/**
 * Proactive review machinery: trigger classification (event triggers plus the
 * step-cadence drift check), the standing reviewer's persona and turn prompts
 * (full digest first, deltas after), and the verdict parser for the JSON
 * reply protocol. All cadence and dedup state derives from the session log
 * so replays and forks reconstruct it.
 * @module @shres-code/shres-code-jspace-advisor/review
 */

import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import { renderAdvisorDigest, renderAdvisorDelta } from './digest.ts'
import type { JspaceAdvisorDelta, JspaceAdvisorDigest, AdvisorTrigger } from './types.ts'

/** Built-in reviewer persona; overridable via Config. */
export const DEFAULT_REVIEWER_PERSONA =
  'You are the jspace advisor, the standing reviewer of one main session. '
  + 'Your conversation holds every earlier digest and verdict; each turn brings either the '
  + 'full digest or one delta since your last review, and the user messages (U1, U2, ...) are '
  + 'the ground truth of the user goal - U1 always restated - while the session card is only '
  + 'what the session believes its goal is and may be stale or a placeholder. Judge the recent '
  + 'work against the USER goal, not the card. The digest and deltas are the main session and '
  + 'are sufficient input: do not search for other sessions. '
  + 'Use a read-only tool only when the input is genuinely insufficient, at most one call. '
  + 'End every review turn with exactly one reply that is a single JSON object and no other '
  + 'text: {"verdict":"on-track"|"drift","advice":"<one sentence>","redirect":"<exact correction>"}. '
  + 'When the work serves the goal: verdict on-track and one-line advice. When it drifts: '
  + 'verdict drift, advice naming the drift in one sentence, and redirect giving the exact '
  + 'correction - what to drop and what to do next to serve the goal. Omit redirect when '
  + 'on-track.'

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

/** Display label persisted with the advisor child in the subagent list. */
export const ADVISOR_CHILD_LABEL = 'Advisor'

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

/**
 * Build the reviewer's first-turn prompt: the rendered full digest plus the
 * trigger that woke it.
 * @param digest - folded advisory digest.
 * @param trigger - why the review ran.
 * @returns the prompt text.
 */
export function buildReviewPrompt(digest: JspaceAdvisorDigest, trigger: AdvisorTrigger): string {
  return renderAdvisorDigest(digest) + '\n\nTrigger: ' + trigger + '\n'
    + 'The digest above is the main session. Review it against the user goal '
    + 'and reply with only the verdict JSON now.'
}

/**
 * Build a follow-up turn's prompt: the rendered delta since the reviewer's
 * previous turn plus the trigger that woke it.
 * @param delta - folded advisory delta.
 * @param trigger - why the review ran.
 * @returns the prompt text.
 */
export function buildReviewDeltaPrompt(delta: JspaceAdvisorDelta, trigger: AdvisorTrigger): string {
  return renderAdvisorDelta(delta) + '\n\nTrigger: ' + trigger + '\n'
    + 'The delta above is what changed in the main session since your last '
    + 'review. Weigh it against the user goal and your earlier verdicts, then '
    + 'reply with only the verdict JSON now.'
}

/**
 * Parse one reviewer reply under the JSON protocol. Accepts a bare object, a
 * fenced code block, or an object embedded in stray prose (outermost braces);
 * anything else that does not carry a valid verdict is a failed review turn.
 * @param text - the reply text.
 * @returns the verdict, or undefined when the reply carries none.
 */
export function parseReviewVerdict(text: string): ReviewVerdict | undefined {
  const candidates: string[] = []
  const trimmed = text.trim()
  candidates.push(trimmed)
  const fence = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(trimmed)
  if (fence?.[1] !== undefined) candidates.push(fence[1])
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1))
  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      // Not JSON under this candidate; the next candidate may be.
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const value = parsed as { verdict?: unknown; advice?: unknown; redirect?: unknown }
    if (value.verdict !== 'on-track' && value.verdict !== 'drift') continue
    if (typeof value.advice !== 'string') continue
    if (value.redirect !== undefined && typeof value.redirect !== 'string') continue
    return {
      verdict: value.verdict,
      advice: value.advice,
      ...value.redirect === undefined ? {} : { redirect: value.redirect },
    }
  }
  return undefined
}

/**
 * Read the verdict of one completed advisor-child turn: the latest
 * assistant message whose text parses under the JSON protocol. Turn steps
 * before the reply (reasoning, tool calls) never parse, so the scan lands on
 * the reply.
 * @param session - the advisor child's session after its turn ended.
 * @returns the verdict, or undefined when the turn carries none.
 */
export function parseFinalVerdict(session: Session): ReviewVerdict | undefined {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event === undefined || event.type !== 'assistant/message') continue
    const content = (event.data.message as { content?: ReadonlyArray<{ type?: string; text?: string }> }).content
    const text = (content ?? [])
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('')
      .trim()
    if (text.length === 0) continue
    const verdict = parseReviewVerdict(text)
    if (verdict !== undefined) return verdict
  }
  return undefined
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
 * step/end events are not handled here - the drift cadence is
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
