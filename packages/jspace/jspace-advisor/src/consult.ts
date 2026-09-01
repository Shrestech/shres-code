/**
 * `jspace_consult` gating, output schema, and run-result settle mapping.
 * @module @shres-code/shres-code-jspace-advisor/consult
 */

import type { ContentBlock } from '@shres-code/shres-code-llm'
import type { SubagentResult } from '@shres-code/shres-code-subagent'
import type { ObjectJsonSchema } from '@shres-code/shres-code-tools'
import type { JspaceAdvisorDigest } from './types.ts'
import { renderAdvisorDigest } from './digest.ts'
import { parentEventReadInstructions } from './review.ts'

/** Model-visible refusal when a session has no open J-Space card. */
export const CONSULT_REQUIRES_CARD =
  'jspace_consult requires an open J-Space card; open one with jspace_open first.'

/** Model-visible refusal when the advisor is not armed for this session. */
export const CONSULT_UNAVAILABLE =
  'jspace_consult is unavailable; the jspace advisor is not armed for this session.'

/**
 * Why `jspace_consult` must refuse, or `undefined` when it may proceed.
 * @param seatActive - true when the jspace seat is engaged for this session.
 * @param cardOpen - true when the session has an open card.
 * @param bound - true when the advisor has a provider/model to mount the reviewer.
 * @returns the refusal message.
 */
export function consultRefusal(
  seatActive: boolean,
  cardOpen: boolean,
  bound: boolean,
): string | undefined {
  if (!seatActive || !bound) return CONSULT_UNAVAILABLE
  if (!cardOpen) return CONSULT_REQUIRES_CARD
  return undefined
}

/** Structured consult reply. */
export interface ConsultReply {
  /** One-sentence advisory verdict. */
  readonly advice: string
  /** Optional concrete recommendation. */
  readonly recommendation?: string
}

/** Tool-side output schema for the consult reply (defineTool compiles the DSL). */
export const CONSULT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    advice: { type: 'string', required: true },
    recommendation: { type: 'string' },
  },
} as const

/** Object-rooted JSON Schema for the structured consult reply, in the enforced subset. */
export const CONSULT_OUTPUT_JSON_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['advice'],
  properties: {
    advice: { type: 'string' },
    recommendation: { type: 'string' },
  },
}

/**
 * Map a non-`completed` stop reason to a headline error, or `undefined` when
 * the run completed. Merge-extensible: unknown terminal reasons fail rather
 * than reporting partial output as success.
 * @param result - the child's terminal result.
 * @returns the headline, or `undefined` when completed.
 */
export function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'jspace_consult was cancelled'
    case 'error':
      return 'jspace_consult reviewer failed'
    case 'max-tokens':
      return 'jspace_consult reviewer hit its token limit before finishing'
    case 'refusal':
      return 'jspace_consult reviewer declined the question'
    default:
      return `jspace_consult reviewer ended abnormally (${String(result.stopReason)})`
  }
}

/**
 * Append the reviewer's preserved partial answer to a stop-reason error so a
 * truncated reply's real text still reaches the caller.
 * @param error - the stop-reason headline.
 * @param output - the reviewer's selected output.
 * @returns the headline, extended with the partial text when any exists.
 */
export function withPartialText(error: string, output: ContentBlock[]): string {
  const text = output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}`
}

/**
 * Settle a consult run into a tool value: the structured reply on completion,
 * or a thrown Error with preserved partial text otherwise.
 * @param result - the child's terminal result.
 * @returns the structured reply.
 * @throws {Error} when the run did not complete.
 */
export function settleConsult(result: SubagentResult): ConsultReply {
  const error = stopReasonError(result)
  if (error !== undefined) throw new Error(withPartialText(error, result.output))
  const structured = result.structured as ConsultReply | undefined
  if (structured === undefined || typeof structured.advice !== 'string') {
    throw new Error('jspace_consult reviewer returned no structured advice')
  }
  return structured
}

/**
 * Build the reviewer's consult prompt: the rendered digest plus the question.
 * @param digest - folded advisory digest.
 * @param question - the caller's question.
 * @param parentEventRead - true when `session_event_read` is in `reviewerTools` and mounted.
 * @returns the prompt text.
 */
export function buildConsultPrompt(
  digest: JspaceAdvisorDigest,
  question: string,
  parentEventRead = false,
): string {
  return `${renderAdvisorDigest(digest)}\n\nThe named main session asks: ${question}\n`
    + `Advise it from the digest. ${parentEventReadInstructions(parentEventRead)} `
    + 'Do not search other sessions. Do not review code here; recommend ward for a deep review. '
    + 'Return a one-sentence `advice` and an optional concrete `recommendation`. Spend tokens '
    + 'only on the answer.'
}
