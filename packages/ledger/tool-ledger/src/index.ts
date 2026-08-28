/**
 * Model-facing decision-ledger tools over `ctx.ledger`: `ledger_record_decision`
 * and `ledger_query`. This package owns schemas, validation, prompt guidance,
 * and presentation, never provider selection or persistence. Tool results
 * surface the validation failure taxonomy verbatim, so the model sees exactly
 * why a record did not land.
 * @module @shres-code/shres-code-tool-ledger
 */

import type { Context } from '@shres-code/cordis'
import { defineTool } from '@shres-code/shres-code-tools'
import type { GenericCallView, ToolRunContext } from '@shres-code/shres-code-tools'
import type { LedgerRecordResult, LedgerRequest } from '@shres-code/shres-code-ledger'
import type { TrackerRunId } from '@shres-code/shres-code-tracker'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-ledger'

/** Services required by the decision-ledger tools. */
export const inject = ['tools', 'ledger']

/** Canonical `ledger_record_decision` output value. */
export interface RecordDecisionOutput {
  readonly entryId: string
  readonly status: 'recorded' | 'failed'
  /** The validation failure taxonomy, present only when the record was not recorded. */
  readonly reason?: string
}

/** Canonical `ledger_query` output value. */
export interface QueryOutput {
  readonly entries: ReadonlyArray<{
    readonly entryId: string
    readonly hypothesis: string
    readonly decision: string
    readonly rationale: string
    readonly runIds: readonly string[]
    readonly gitSha?: string
    readonly artifactUris?: readonly string[]
  }>
}

/**
 * Require the calling agent so decision records have a session log.
 * @param exec - the tool execution context.
 * @param toolName - the tool's name for the error message.
 * @returns the owning agent session.
 * @throws when the caller has no owning agent session.
 */
function requireSession(exec: ToolRunContext, toolName: string): NonNullable<ToolRunContext['agent']>['session'] {
  if (exec.agent === undefined) {
    throw new Error(`${toolName} requires an owning agent session`)
  }
  return exec.agent.session
}

/**
 * Format a record output as one model-facing text block, surfacing the
 * failure taxonomy verbatim when the record was not recorded.
 * @param value - the tool's canonical output.
 * @returns the model-facing text.
 */
export function formatRecordOutput(value: RecordDecisionOutput): string {
  if (value.status === 'recorded') {
    return `Recorded decision ${value.entryId}.`
  }
  return `Decision ${value.entryId} was not recorded (reason: ${value.reason ?? 'unknown'}).`
}

/**
 * Format a query output as a list.
 * @param value - the tool's canonical output.
 * @returns the model-facing text, or `No ledger decisions found.`.
 */
export function formatQueryOutput(value: QueryOutput): string {
  if (value.entries.length === 0) return 'No ledger decisions found.'
  const lines = value.entries.map(entry => `- ${entry.entryId} ${entry.decision} ${entry.hypothesis}`)
  return `Ledger decisions:\n${lines.join('\n')}`
}

/**
 * Pending-call presentation for `ledger_record_decision`: a generic card.
 * @param args - the raw tool arguments; `hypothesis` becomes the title.
 * @returns the generic card view.
 */
export function presentRecordCall(args: { hypothesis: string }): GenericCallView {
  return { card: 'generic', title: args.hypothesis, kind: 'other', rawInput: args.hypothesis }
}

/**
 * Project a {@link LedgerRecordResult} into a {@link RecordDecisionOutput}.
 * @param result - the seam's record outcome.
 * @returns the tool's canonical output value.
 */
function projectResult(result: LedgerRecordResult): RecordDecisionOutput {
  return result.kind === 'recorded'
    ? { entryId: result.entryId, status: 'recorded' }
    : { entryId: result.entryId, status: 'failed', reason: result.reason }
}

/**
 * Register the two decision-ledger tools.
 * @param ctx - context whose `tools` and `ledger` services carry the registrations.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'ledger_record_decision',
    description: 'Record one research decision to the ledger with its hypothesis, decision, evidence, and rationale, returning its entry id (or why the record was rejected).',
    parameters: {
      hypothesis: { type: 'string', required: true, description: 'The hypothesis the decision addresses.' },
      decision: { type: 'string', required: true, enum: ['accepted', 'rejected', 'deferred'], description: 'The decision reached.' },
      evidence: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          runIds: { type: 'array', required: true, description: 'Experiment run ids cited as evidence.', items: { type: 'string' } },
          gitSha: { type: 'string', description: 'Git commit the evidence reproduced.' },
          artifactUris: { type: 'array', description: 'Artifact modelstore:// URIs cited as evidence.', items: { type: 'string' } },
        },
      },
      rationale: { type: 'string', required: true, description: 'Why the decision was reached.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entryId: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['recorded', 'failed'] },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatRecordOutput(value as RecordDecisionOutput) }],
    },
    async execute(args, exec) {
      const session = requireSession(exec, 'ledger_record_decision')
      const request: LedgerRequest = {
        hypothesis: args.hypothesis,
        decision: args.decision,
        evidence: {
          runIds: args.evidence.runIds as TrackerRunId[],
          ...args.evidence.gitSha !== undefined ? { gitSha: args.evidence.gitSha } : {},
          ...args.evidence.artifactUris !== undefined ? { artifactUris: args.evidence.artifactUris } : {},
        },
        rationale: args.rationale,
      }
      return projectResult(await ctx.ledger.record(session, request, exec.callId))
    },
    presentCall: args => presentRecordCall(args),
  }))

  ctx.tools.register(defineTool({
    name: 'ledger_query',
    description: 'Query recorded research decisions by decision, hypothesis substring, and recency, returning their entry ids and evidence.',
    parameters: {
      decision: { type: 'string', enum: ['accepted', 'rejected', 'deferred'], description: 'Filter to one decision.' },
      hypothesisSubstring: { type: 'string', description: 'Match decisions whose hypothesis contains this substring.' },
      since: { type: 'integer', description: 'Epoch milliseconds; return decisions recorded on or after it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                entryId: { type: 'string', required: true },
                hypothesis: { type: 'string', required: true },
                decision: { type: 'string', required: true },
                rationale: { type: 'string', required: true },
                runIds: { type: 'array', required: true, items: { type: 'string' } },
                gitSha: { type: 'string' },
                artifactUris: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatQueryOutput(value as QueryOutput) }],
    },
    async execute(args) {
      const entries = await ctx.ledger.query({
        ...args.decision !== undefined ? { decision: args.decision } : {},
        ...args.hypothesisSubstring !== undefined ? { hypothesisSubstring: args.hypothesisSubstring } : {},
        ...args.since !== undefined ? { since: args.since } : {},
      })
      return {
        entries: entries.map(entry => ({
          entryId: entry.entryId,
          hypothesis: entry.hypothesis,
          decision: entry.decision,
          rationale: entry.rationale,
          runIds: [...entry.evidence.runIds],
          ...entry.evidence.gitSha !== undefined ? { gitSha: entry.evidence.gitSha } : {},
          ...entry.evidence.artifactUris.length > 0 ? { artifactUris: [...entry.evidence.artifactUris] } : {},
        })),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Query ledger decisions', kind: 'other', rawInput: '' }),
  }))
}
