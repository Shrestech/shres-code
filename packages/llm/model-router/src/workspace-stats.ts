/**
 * The workspace statistics fold: one summary per session, taken from the
 * session's `modelRoutingStats` value, and a merge of summaries that is
 * associative and commutative with an empty identity, so the rollup does not
 * depend on the order sessions are read in. Pure; the host read gathers the
 * values (live or from the persisted projection cache) and calls
 * {@link workspaceStats}.
 *
 * @module
 */

import { createStatsState, viewStats } from './stats.ts'
import type {
  ModelRoutingReasonGroup,
  ModelRoutingStatsRange,
  ModelRoutingStatsSnapshot,
  ModelRoutingWorkspaceSession,
  ModelRoutingWorkspaceStats,
} from './types.ts'

/** Sessions a workspace read rolls up at most: the most recently routed ones. */
export const WORKSPACE_STATS_SESSION_CAP = 500

/** Length of each bounded range, in milliseconds. */
const RANGE_MS: Readonly<Record<Exclude<ModelRoutingStatsRange, 'all'>, number>> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
}

type Counts = ModelRoutingStatsSnapshot['counts']

/** One session's contribution to the workspace statistics. */
export interface SessionSummary {
  readonly row: ModelRoutingWorkspaceSession
  readonly counts: Counts
  /** Decisions per reason, with the reason's group. */
  readonly reasons: Readonly<Record<string, { group: ModelRoutingReasonGroup; count: number }>>
  /** Cold prefills after routed switches and routed returns, and their tokens. */
  readonly routedSwitches: { count: number; tokens: number }
}

/** A merge of session summaries; {@link EMPTY_ROLLUP} is its identity. */
export interface SummaryRollup {
  /** Every merged session's row, most recent decision first, then by session id. */
  readonly rows: readonly ModelRoutingWorkspaceSession[]
  readonly counts: Counts
  readonly reasons: Readonly<Record<string, { group: ModelRoutingReasonGroup; count: number }>>
  readonly routedSwitches: { count: number; tokens: number }
}

/** Every count at zero, in the fold's own key set. */
const ZERO_COUNTS: Counts = viewStats(createStatsState()).counts

/** The merge's identity: no sessions. */
export const EMPTY_ROLLUP: SummaryRollup = {
  rows: [],
  counts: ZERO_COUNTS,
  reasons: {},
  routedSwitches: { count: 0, tokens: 0 },
}

/**
 * Summarize one session's statistics.
 * @param sessionId - the session.
 * @param stats - its `modelRoutingStats` value.
 * @returns the summary, or undefined for a session with no decision, which has no routing to report.
 */
export function summarizeSession(sessionId: string, stats: ModelRoutingStatsSnapshot): SessionSummary | undefined {
  // `recent` is newest first and non-empty whenever a decision exists.
  const latest = stats.recent[0]
  if (latest === undefined) return undefined
  const routed = stats.cold.filter(row => row.cause === 'routed-switch' || row.cause === 'routed-return')
  return {
    row: {
      sessionId,
      lastDecisionAt: latest.t,
      decisions: stats.counts.decisions,
      steps: stats.counts.steps,
      downgradedSteps: stats.counts.downgradedSteps,
    },
    counts: stats.counts,
    reasons: Object.fromEntries(stats.reasons.map(entry => [entry.reason, { group: entry.group, count: entry.count }])),
    routedSwitches: {
      count: routed.reduce((sum, row) => sum + row.count, 0),
      tokens: routed.reduce((sum, row) => sum + row.tokens, 0),
    },
  }
}

/**
 * One session's summary as a rollup of that session alone.
 * @param summary - the session's summary.
 * @returns the rollup.
 */
export function rollupOf(summary: SessionSummary): SummaryRollup {
  return { rows: [summary.row], counts: summary.counts, reasons: summary.reasons, routedSwitches: summary.routedSwitches }
}

/**
 * Merge two rollups: rows combine in their canonical order and every count
 * and histogram sums, so the result is the same whichever operand comes first.
 * @param left - one rollup.
 * @param right - the other.
 * @returns the merged rollup.
 */
export function mergeRollups(left: SummaryRollup, right: SummaryRollup): SummaryRollup {
  const counts = { ...left.counts }
  for (const key of Object.keys(counts) as (keyof Counts)[]) counts[key] = left.counts[key] + right.counts[key]
  const reasons: Record<string, { group: ModelRoutingReasonGroup; count: number }> = { ...left.reasons }
  for (const [reason, entry] of Object.entries(right.reasons)) {
    reasons[reason] = { group: entry.group, count: (reasons[reason]?.count ?? 0) + entry.count }
  }
  return {
    rows: [...left.rows, ...right.rows].sort(byRecency),
    counts,
    reasons,
    routedSwitches: {
      count: left.routedSwitches.count + right.routedSwitches.count,
      tokens: left.routedSwitches.tokens + right.routedSwitches.tokens,
    },
  }
}

/** Most recent decision first; equal times order by session id in code units. */
function byRecency(left: ModelRoutingWorkspaceSession, right: ModelRoutingWorkspaceSession): number {
  return right.lastDecisionAt - left.lastDecisionAt || codeUnitOrder(left.sessionId, right.sessionId)
}

/**
 * Order two distinct strings by UTF-16 code units, the same on every host.
 * Both callers compare distinct keys (session ids, reasons), so none is equal.
 */
function codeUnitOrder(left: string, right: string): number {
  return left < right ? -1 : 1
}

/** Inputs of one workspace read. */
export interface WorkspaceStatsInput {
  readonly workspaceId: string
  readonly range: ModelRoutingStatsRange
  /** The read's time, epoch milliseconds. */
  readonly now: number
  /** Unarchived sessions the workspace accounts. */
  readonly members: number
  /** Members whose statistics were read. */
  readonly summarized: number
  /** The summaries of those with a decision. */
  readonly summaries: readonly SessionSummary[]
}

/**
 * Roll up one workspace: the summarized sessions whose latest decision falls
 * in the range, most recent first, at most {@link WORKSPACE_STATS_SESSION_CAP}.
 * @param input - the read's summaries and bookkeeping.
 * @param cap - sessions rolled up at most.
 * @returns the workspace statistics.
 */
export function workspaceStats(input: WorkspaceStatsInput, cap = WORKSPACE_STATS_SESSION_CAP): ModelRoutingWorkspaceStats {
  const since = input.range === 'all' ? -Infinity : input.now - RANGE_MS[input.range]
  const inRange = input.summaries.filter(summary => summary.row.lastDecisionAt >= since)
  const included = [...inRange].sort((left, right) => byRecency(left.row, right.row)).slice(0, cap)
  const rollup = included.map(rollupOf).reduce(mergeRollups, EMPTY_ROLLUP)
  return {
    workspaceId: input.workspaceId,
    range: input.range,
    computedAt: input.now,
    sessions: {
      members: input.members,
      summarized: input.summarized,
      inRange: inRange.length,
      included: included.length,
      capped: inRange.length > included.length,
    },
    counts: rollup.counts,
    reasons: Object.entries(rollup.reasons)
      .map(([reason, entry]) => ({ reason, group: entry.group, count: entry.count }))
      .sort((left, right) => right.count - left.count || codeUnitOrder(left.reason, right.reason)),
    routedSwitches: rollup.routedSwitches,
    rows: [...rollup.rows],
  }
}
