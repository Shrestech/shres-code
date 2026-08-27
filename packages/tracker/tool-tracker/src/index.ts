/**
 * Model-facing experiment tracking tools over `ctx.tracker`: `experiment_log_run`,
 * `experiment_log_metrics`, and `experiment_query`. This package owns schemas,
 * validation, prompt guidance, and presentation, never provider selection or
 * persistence. Tool results surface the provider-post failure taxonomy verbatim,
 * so the model sees exactly why a post did not land.
 * @module @shres-code/shres-code-tool-tracker
 */

import type { Context } from '@shres-code/cordis'
import { defineTool } from '@shres-code/shres-code-tools'
import type { GenericCallView, ToolRunContext } from '@shres-code/shres-code-tools'
import type {
  LogRunRequest,
  TrackerDecisionRuleVerdict,
  TrackerRunId,
  TrackerRunResult,
} from '@shres-code/shres-code-tracker'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-tracker'

/** Services required by the experiment tracking tools. */
export const inject = ['tools', 'tracker']

/** Canonical `experiment_log_run` output value. */
export interface LogRunOutput {
  readonly runId: string
  readonly status: 'landed' | 'spooled'
  /** The provider-post failure taxonomy, present only when the run was spooled. */
  readonly reason?: string
}

/** Canonical `experiment_log_metrics` output value. */
export interface LogMetricsOutput {
  readonly runId: string
  readonly metricsCount: number
}

/** Canonical `experiment_query` output value. */
export interface QueryOutput {
  readonly runs: ReadonlyArray<{
    readonly runId: string
    readonly experiment: string
    readonly decisionRule: string
    readonly dataVersion: string
    readonly gitSha: string
    readonly reason?: string
  }>
}

/** Canonical `experiment_verify_decision_rule` output value. */
export type VerifyOutput =
  | {
    readonly status: 'satisfied' | 'unsatisfied'
    readonly rule: { readonly metric: string; readonly op: string; readonly threshold: number }
    readonly actual: number
  }
  | {
    readonly status: 'refused'
    readonly reason: string
    readonly detail: string
  }

/**
 * Require the calling agent so run/metrics mutations have a session log.
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
 * Format a log-run output as one model-facing text block, surfacing the
 * failure taxonomy verbatim when the run was spooled.
 * @param value - the tool's canonical output.
 * @returns the model-facing text.
 */
export function formatRunOutput(value: LogRunOutput): string {
  if (value.status === 'landed') {
    return `Logged experiment run ${value.runId}.`
  }
  return `Run ${value.runId} did not land at the tracker; held in the local spool (reason: ${value.reason ?? 'unknown'}).`
}

/**
 * Format a metrics-append output.
 * @param value - the tool's canonical output.
 * @returns the model-facing text.
 */
export function formatMetricsOutput(value: LogMetricsOutput): string {
  return `Appended ${value.metricsCount} metric point${value.metricsCount === 1 ? '' : 's'} to run ${value.runId}.`
}

/**
 * Format a query output as a list.
 * @param value - the tool's canonical output.
 * @returns the model-facing text, or `No experiment runs found.`.
 */
export function formatQueryOutput(value: QueryOutput): string {
  if (value.runs.length === 0) return 'No experiment runs found.'
  const lines = value.runs.map((run) => {
    const suffix = run.reason === undefined ? '' : ` (not landed: ${run.reason})`
    return `- ${run.runId} ${run.experiment} ${run.decisionRule} @ ${run.gitSha}${suffix}`
  })
  return `Experiment runs:\n${lines.join('\n')}`
}

/**
 * Format a decision-rule verification output, surfacing the verdict verbatim:
 * the rule and observed value for satisfied/unsatisfied, or the refusal reason
 * and detail for refused.
 * @param value - the tool's canonical output.
 * @returns the model-facing text.
 */
export function formatVerifyOutput(value: VerifyOutput): string {
  if (value.status === 'refused') {
    return `Decision rule verification refused (${value.reason}): ${value.detail}`
  }
  return `Decision rule ${value.status}: ${value.rule.metric} ${value.rule.op} ${value.rule.threshold} (actual ${value.actual})`
}

/**
 * Pending-call presentation for `experiment_log_run`: a generic card.
 * @param args - the raw tool arguments; `experiment` becomes the title.
 * @returns the generic card view.
 */
export function presentRunCall(args: { experiment: string }): GenericCallView {
  return { card: 'generic', title: args.experiment, kind: 'other', rawInput: args.experiment }
}

/**
 * Project a {@link TrackerRunResult} into a {@link LogRunOutput}.
 * @param result - the seam's post outcome.
 * @returns the tool's canonical output value.
 */
function projectResult(result: TrackerRunResult): LogRunOutput {
  return result.kind === 'landed'
    ? { runId: result.runId, status: 'landed' }
    : { runId: result.runId, status: 'spooled', reason: result.reason }
}

/**
 * Project a {@link TrackerDecisionRuleVerdict} into a {@link VerifyOutput}.
 * @param verdict - the seam's mechanical verdict.
 * @returns the tool's canonical output value.
 */
function projectVerdict(verdict: TrackerDecisionRuleVerdict): VerifyOutput {
  if (verdict.status === 'refused') {
    return { status: 'refused', reason: verdict.reason, detail: verdict.detail }
  }
  return { status: verdict.status, rule: verdict.rule, actual: verdict.actual }
}

/**
 * Register the three experiment tracking tools.
 * @param ctx - context whose `tools` and `tracker` services carry the registrations.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'experiment_log_run',
    description: 'Log one experiment run to the tracker with its required decision_rule, data_version, and git_sha, returning its run id (or why the post was held locally).',
    parameters: {
      experiment: { type: 'string', required: true, description: 'Experiment or study this run belongs to.' },
      hypothesis: { type: 'string', required: true, description: 'The hypothesis under test.' },
      decisionRule: { type: 'string', required: true, description: 'The decision rule encoded in the API itself — a threshold change is a new experiment.' },
      dataVersion: { type: 'string', required: true, description: 'Data version the run used.' },
      gitSha: { type: 'string', required: true, description: 'Git commit the run reproduced.' },
      metrics: {
        type: 'array',
        description: 'Metrics recorded with the run.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Metric name.' },
            value: { type: 'number', required: true, description: 'Measured value.' },
            step: { type: 'integer', description: 'Optional step or epoch the point was measured at.' },
          },
        },
      },
      artifacts: { type: 'array', description: 'Artifact modelstore:// URIs the run produced.', items: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['landed', 'spooled'] },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatRunOutput(value as LogRunOutput) }],
    },
    async execute(args, exec) {
      const session = requireSession(exec, 'experiment_log_run')
      const request: LogRunRequest = {
        experiment: args.experiment,
        hypothesis: args.hypothesis,
        decisionRule: args.decisionRule,
        dataVersion: args.dataVersion,
        gitSha: args.gitSha,
        ...args.metrics !== undefined ? { metrics: args.metrics } : {},
        ...args.artifacts !== undefined ? { artifacts: args.artifacts } : {},
      }
      return projectResult(await ctx.tracker.logRun(session, request, exec.callId))
    },
    presentCall: args => presentRunCall(args),
  }))

  ctx.tools.register(defineTool({
    name: 'experiment_log_metrics',
    description: 'Append a batched list of metric points to one experiment run.',
    parameters: {
      runId: { type: 'string', required: true, description: 'The run id returned by experiment_log_run.' },
      metrics: {
        type: 'array',
        required: true,
        description: 'Metric points to append.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Metric name.' },
            value: { type: 'number', required: true, description: 'Measured value.' },
            step: { type: 'integer', description: 'Optional step or epoch the point was measured at.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', required: true },
          metricsCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatMetricsOutput(value as LogMetricsOutput) }],
    },
    async execute(args, exec) {
      const session = requireSession(exec, 'experiment_log_metrics')
      await ctx.tracker.logMetrics(session, args.runId as TrackerRunId, args.metrics)
      return { runId: args.runId, metricsCount: args.metrics.length }
    },
    presentCall: () => ({ card: 'generic', title: 'Log experiment metrics', kind: 'other', rawInput: '' }),
  }))

  ctx.tools.register(defineTool({
    name: 'experiment_query',
    description: 'Query experiment runs by experiment, git sha, and recency, returning run ids and their land/spool status.',
    parameters: {
      experiment: { type: 'string', description: 'Filter to one experiment.' },
      gitSha: { type: 'string', description: 'Filter to one git commit.' },
      since: { type: 'string', description: 'ISO-8601 timestamp; return runs on or after it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                runId: { type: 'string', required: true },
                experiment: { type: 'string', required: true },
                decisionRule: { type: 'string', required: true },
                dataVersion: { type: 'string', required: true },
                gitSha: { type: 'string', required: true },
                reason: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatQueryOutput(value as QueryOutput) }],
    },
    async execute(args) {
      const runs = await ctx.tracker.queryRuns({
        ...args.experiment !== undefined ? { experiment: args.experiment } : {},
        ...args.gitSha !== undefined ? { gitSha: args.gitSha } : {},
        ...args.since !== undefined ? { since: args.since } : {},
      })
      return {
        runs: runs.map(run => ({
          runId: run.runId,
          experiment: run.experiment,
          decisionRule: run.decisionRule,
          dataVersion: run.dataVersion,
          gitSha: run.gitSha,
          ...run.reason !== undefined ? { reason: run.reason } : {},
        })),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Query experiment runs', kind: 'other', rawInput: '' }),
  }))

  ctx.tools.register(defineTool({
    name: 'experiment_verify_decision_rule',
    description: 'Mechanically re-execute one run\'s machine decision rule against its logged metrics, returning whether the rule is satisfied, unsatisfied, or refused with the reason. Never an LLM judgment.',
    parameters: {
      runId: { type: 'string', required: true, description: 'The run id returned by experiment_log_run.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['satisfied', 'unsatisfied', 'refused'] },
          rule: {
            type: 'object',
            additionalProperties: false,
            properties: {
              metric: { type: 'string', required: true },
              op: { type: 'string', required: true },
              threshold: { type: 'number', required: true },
            },
          },
          actual: { type: 'number' },
          reason: { type: 'string' },
          detail: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatVerifyOutput(value as VerifyOutput) }],
    },
    async execute(args) {
      return projectVerdict(await ctx.tracker.verifyDecisionRule(args.runId as TrackerRunId))
    },
    presentCall: () => ({ card: 'generic', title: 'Verify decision rule', kind: 'other', rawInput: '' }),
  }))
}
