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

/** Tool name that reads one parent-session event; opt-in on `reviewerTools`. */
export const PARENT_EVENT_READ_TOOL = 'session_event_read'

/**
 * Whether the reviewer may be told to call {@link PARENT_EVENT_READ_TOOL}.
 * Both the filter name and a live registry entry are required: the filter
 * rejects unknown names, and an unmounted name must not appear in the persona.
 * @param reviewerTools - names opened on the reviewer child.
 * @param toolMounted - true when `ctx.tools.get(PARENT_EVENT_READ_TOOL)` is defined.
 * @returns true when the persona and consult prompt may mention the tool.
 */
export function parentEventReadAllowed(
  reviewerTools: readonly string[],
  toolMounted: boolean,
): boolean {
  return toolMounted && reviewerTools.includes(PARENT_EVENT_READ_TOOL)
}

/**
 * Tool-use sentences for a reviewer child.
 * @param parentEventRead - true when {@link parentEventReadAllowed} is true.
 * @returns the tool-use fragment.
 */
export function parentEventReadInstructions(parentEventRead: boolean): string {
  if (parentEventRead) {
    return 'Tools: wiki_search/wiki_read for project memory; session_event_read for one unabridged parent event. '
      + 'If the digest is insufficient, call session_event_read with that session_id and a seq from the tool window. '
      + 'Omitting session_id reads YOUR log — never do that. At most one tool call per turn. Prefer the digest; tokens are expensive.'
  }
  return 'Tools: wiki_search/wiki_read for project memory. Judge from the digest; do not inspect session events. '
    + 'At most one tool call per turn. Prefer the digest; tokens are expensive.'
}

/**
 * Standing-reviewer persona: verdict JSON on every turn.
 * @param parentEventRead - true when {@link parentEventReadAllowed} is true.
 * @returns the persona text.
 */
export function buildStandingReviewerPersona(parentEventRead: boolean): string {
  return [
    'You are the jspace advisor, the standing reviewer of one main session.',
    'Goal: steer that session so its work serves the USER messages (U1, U2, …; U1 always restated).',
    'The card is only what the session claims and may be stale. Judge work against the user, not the card.',
    'You cannot edit files, run a shell, approve tools, or review code yourself.',
    'Code review is a main-session permission: on a deep review, redirect it to call ward (the Reviewer seat) with a self-contained prompt. Do not ask it to paste diffs here.',
    'If the user ask is satisfied and the Goal is still open, that is drift: redirect to jspace_open only for new work, or tell the user the card stays until /j-space off.',
    'Delivered work that was never shipped is also drift (checkpoint, then jspace_ship).',
    'Each turn is a full digest or a delta. Every user message in it is ground truth and must be weighed.',
    'The digest names the main session id and labels every tool seq. Those seqs belong to that session, not yours.',
    parentEventReadInstructions(parentEventRead),
    'Do not search other sessions. Do not dump code or long quotes into the verdict.',
    'End every turn with exactly one JSON object and no other text: '
    + '{"verdict":"on-track"|"drift","advice":"<one sentence>","redirect":"<exact correction>"}.',
    'On-track: one-line advice, omit redirect. Drift: name the drift, and redirect with what to drop and what to do next '
    + '(including ward or jspace_consult when that is the correction).',
  ].join(' ')
}

/**
 * One-shot consult persona: structured `advice` / `recommendation`, not verdict JSON.
 * @param parentEventRead - true when {@link parentEventReadAllowed} is true.
 * @returns the persona text.
 */
export function buildConsultPersona(parentEventRead: boolean): string {
  return [
    'You are the jspace advisor on a one-shot consult of one main session.',
    'Advise that session so its work serves the USER messages in the digest (U1 is the goal).',
    'The card is only what the session claims and may be stale. Judge work against the user, not the card.',
    'You cannot edit files, run a shell, approve tools, or review code yourself.',
    'Code review is a main-session permission: recommend it call ward (the Reviewer seat) with a self-contained prompt.',
    'If the user ask is satisfied and the Goal is still open, say so: jspace_open only for new work, or the user turns J-Space off.',
    'Delivered work that was never shipped should be checkpointed and shipped.',
    parentEventReadInstructions(parentEventRead),
    'Do not search other sessions. Do not dump code or long quotes.',
    'Return structured output only: one-sentence `advice` and an optional concrete `recommendation`.',
    'Do not emit proactive verdict JSON (`verdict` / `redirect`).',
  ].join(' ')
}

/** Built-in standing reviewer persona (wiki-only default; no parent-event read). */
export const DEFAULT_REVIEWER_PERSONA = buildStandingReviewerPersona(false)

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

/**
 * Whether a session is a root (not a delegated child).
 * @param session - session to classify.
 * @returns true when `parentSession` is absent.
 */
export function isRootSession(session: Session): boolean {
  return session.header.parentSession === undefined
}

/**
 * Whether the event is a human source-'user' message.
 * @param event - committed session event.
 * @returns true for source-kind user messages.
 */
export function isHumanUserMessage(event: SessionEvent): boolean {
  return event.type === 'user/message' && event.data.source.kind === 'user'
}

/**
 * Latest human user-message seq after `sinceSeq`, or undefined.
 * @param log - session log.
 * @param sinceSeq - exclusive lower bound.
 * @returns the latest matching seq.
 */
export function latestHumanUserSeqAfter(log: readonly SessionEvent[], sinceSeq: number): number | undefined {
  let found: number | undefined
  for (const event of log) {
    if (event.seq <= sinceSeq) continue
    if (isHumanUserMessage(event)) found = event.seq
  }
  return found
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
    + 'The digest above is the named main session. Review it against the user goal '
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
    + 'The delta above is what changed in the named main session since your last '
    + 'review. Weigh every new user message against the user goal and your earlier '
    + 'verdicts, then reply with only the verdict JSON now.'
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

/**
 * Whether the event is an errored, tool-sourced tool/result.
 * @param event - the session event.
 * @returns true when the event is a failed tool-sourced result.
 */
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
  if (event.type === 'jspace/shipped') return 'ship-attempt'
  if (isSuccessfulJspaceShipResult(event, log)) return 'ship-attempt'
  if (event.type === 'jspace/card') {
    const previous = previousCardGoal(log, event.seq)
    if (previous !== undefined && previous !== event.data.goal) return 'goal-epoch'
    return undefined
  }
  if (isErroredToolResult(event)) {
    return countConsecutiveErrors(log, event.seq) >= errorBurst ? 'error-burst' : undefined
  }
  if (isHumanUserMessage(event)) return 'user-intent'
  return undefined
}

/**
 * The latest logged jspace/advisor event, or `undefined`.
 * @param log - session log.
 * @returns the latest advice event, if any.
 */
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
 * Whether a successful `jspace_ship` tool result is this event.
 * @param event - candidate event.
 * @param log - session log (to resolve the call's tool name).
 * @returns true when this is a non-error `jspace_ship` result.
 */
export function isSuccessfulJspaceShipResult(
  event: SessionEvent,
  log: readonly SessionEvent[],
): boolean {
  if (event.type !== 'tool/result' || isErroredToolResult(event)) return false
  const callId = (event.data as {
    message?: { source?: { kind?: string; callId?: string } }
  }).message?.source?.callId
  if (callId === undefined) return false
  for (const candidate of log) {
    if (candidate.type !== 'tool/call') continue
    const data = candidate.data as { callId?: string; name?: string }
    if (data.callId === callId) return data.name === 'jspace_ship'
  }
  return false
}

/**
 * Cadence-only suppression: drift-check and error-burst wait until the user
 * speaks. Lifecycle triggers (ship, charter-fail, goal-epoch) and user-intent
 * always run.
 * @param trigger - classified trigger.
 * @returns true when {@link suppressReview} applies to this family.
 */
export function isCadenceTrigger(trigger: AdvisorTrigger): boolean {
  return trigger === 'drift-check' || trigger === 'error-burst'
}

/**
 * Cadence suppression: latest advice newer than the latest human message.
 * Continuation wakes are not user speech. Callers apply this only to
 * {@link isCadenceTrigger} families.
 * @param log - the session log.
 * @returns true when drift-check / error-burst should not run.
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
