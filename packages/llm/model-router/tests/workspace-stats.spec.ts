/**
 * The workspace statistics fold: per-session summaries of `modelRoutingStats`
 * values, a merge that is order-independent, and the range and cap selection.
 */

import { describe, expect, it } from 'vitest'
import { createStatsState, viewStats } from '../src/stats.ts'
import {
  EMPTY_ROLLUP,
  WORKSPACE_STATS_SESSION_CAP,
  mergeRollups,
  rollupOf,
  summarizeSession,
  workspaceStats,
} from '../src/workspace-stats.ts'
import type { SessionSummary } from '../src/workspace-stats.ts'
import type { ModelRoutingReasonGroup, ModelRoutingStatsSnapshot } from '../src/types.ts'

const NOW = Date.UTC(2026, 8, 26, 12)
const HOUR = 60 * 60 * 1000

interface Shape {
  /** Time of the latest decision; omitted for a session with no decision. */
  lastAt?: number
  decisions?: number
  steps?: number
  downgradedSteps?: number
  reasons?: Record<string, [ModelRoutingReasonGroup, number]>
  /** `[count, tokens]` per cold cause. */
  cold?: Partial<Record<ModelRoutingStatsSnapshot['cold'][number]['cause'], [number, number]>>
}

/** A `modelRoutingStats` value over the fold's own empty value. */
function stats(shape: Shape): ModelRoutingStatsSnapshot {
  const base = viewStats(createStatsState())
  const decisions = shape.decisions ?? (shape.lastAt === undefined ? 0 : 1)
  return {
    ...base,
    counts: { ...base.counts, decisions, consults: decisions, steps: shape.steps ?? 0, downgradedSteps: shape.downgradedSteps ?? 0 },
    reasons: Object.entries(shape.reasons ?? {}).map(([reason, [group, count]]) => ({ reason, group, count })),
    cold: base.cold.map((row) => {
      const [count, tokens] = shape.cold?.[row.cause] ?? [0, 0]
      return { cause: row.cause, count, tokens }
    }),
    recent: shape.lastAt === undefined ? [] : [{
      seq: 7, t: shape.lastAt, turn: 1, step: 1, outcome: 'kept-strong', reason: 'current-preferred',
      best: null, difficulty: null, engine: null, latencyMs: null,
    }],
  }
}

function summary(sessionId: string, shape: Shape): SessionSummary {
  const summarized = summarizeSession(sessionId, stats(shape))
  if (summarized === undefined) throw new Error(`${sessionId} has no decision`)
  return summarized
}

const A = summary('a', {
  lastAt: NOW - HOUR, decisions: 3, steps: 10, downgradedSteps: 4,
  reasons: { 'gate-passed': ['switched', 2], 'current-preferred': ['judge-no', 1] },
  cold: { 'routed-switch': [1, 5_000], 'manual-switch': [1, 9_000] },
})
const B = summary('b', {
  lastAt: NOW - 2 * HOUR, decisions: 2, steps: 6, downgradedSteps: 0,
  reasons: { 'current-preferred': ['judge-no', 2] },
  cold: { 'routed-return': [2, 3_000] },
})
const C = summary('c', {
  lastAt: NOW - 3 * 24 * HOUR, decisions: 1, steps: 2, downgradedSteps: 1,
  reasons: { 'engine-unavailable': ['engine', 1] },
})

describe('summarizeSession', () => {
  it('summarizes a session\'s decisions, steps, reasons, and routed-switch prefills', () => {
    expect(A.row).toEqual({ sessionId: 'a', lastDecisionAt: NOW - HOUR, decisions: 3, steps: 10, downgradedSteps: 4 })
    expect(A.reasons).toEqual({ 'gate-passed': { group: 'switched', count: 2 }, 'current-preferred': { group: 'judge-no', count: 1 } })
    // A manual switch is not routing's cost.
    expect(A.routedSwitches).toEqual({ count: 1, tokens: 5_000 })
    expect(B.routedSwitches).toEqual({ count: 2, tokens: 3_000 })
  })

  it('has nothing to report for a session with no decision', () => {
    expect(summarizeSession('idle', stats({ steps: 4 }))).toBeUndefined()
  })
})

describe('mergeRollups', () => {
  const rollups = [A, B, C].map(rollupOf)
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]

  it('is commutative', () => {
    for (const [left, right] of [[A, B], [B, C], [A, C]] as const) {
      expect(mergeRollups(rollupOf(left), rollupOf(right))).toEqual(mergeRollups(rollupOf(right), rollupOf(left)))
    }
  })

  it('is associative, so every read order gives one rollup', () => {
    const merged = orders.map(order => order.map(at => rollups[at]!).reduce(mergeRollups, EMPTY_ROLLUP))
    for (const each of merged) expect(each).toEqual(merged[0])
    const [a, b, c] = rollups as [typeof EMPTY_ROLLUP, typeof EMPTY_ROLLUP, typeof EMPTY_ROLLUP]
    expect(mergeRollups(mergeRollups(a, b), c)).toEqual(mergeRollups(a, mergeRollups(b, c)))
  })

  it('has the empty rollup as identity, and sums every count and reason', () => {
    const [a] = rollups as [typeof EMPTY_ROLLUP]
    expect(mergeRollups(EMPTY_ROLLUP, a)).toEqual(a)
    expect(mergeRollups(a, EMPTY_ROLLUP)).toEqual(a)
    const all = rollups.reduce(mergeRollups, EMPTY_ROLLUP)
    expect(all.counts).toMatchObject({ decisions: 6, consults: 6, steps: 18, downgradedSteps: 5 })
    expect(all.reasons).toEqual({
      'gate-passed': { group: 'switched', count: 2 },
      'current-preferred': { group: 'judge-no', count: 3 },
      'engine-unavailable': { group: 'engine', count: 1 },
    })
    expect(all.routedSwitches).toEqual({ count: 3, tokens: 8_000 })
    expect(all.rows.map(row => row.sessionId)).toEqual(['a', 'b', 'c'])
  })

  it('orders rows by latest decision, then session id in code units', () => {
    const tie = (id: string) => rollupOf(summary(id, { lastAt: NOW }))
    // 'Z' sorts before 'a' in code units; a locale collation would put 'a' first.
    expect(mergeRollups(tie('a'), tie('Z')).rows.map(row => row.sessionId)).toEqual(['Z', 'a'])
    expect(mergeRollups(tie('Z'), tie('a')).rows.map(row => row.sessionId)).toEqual(['Z', 'a'])
  })
})

describe('workspaceStats', () => {
  const read = (range: '24h' | '7d' | 'all', summaries: readonly SessionSummary[] = [A, B, C]) =>
    workspaceStats({ workspaceId: 'w1', range, now: NOW, members: 5, summarized: 4, summaries })

  it('rolls up the sessions whose latest decision falls in the range', () => {
    expect(read('24h').rows.map(row => row.sessionId)).toEqual(['a', 'b'])
    expect(read('24h').sessions).toEqual({ members: 5, summarized: 4, inRange: 2, included: 2, capped: false })
    expect(read('24h').counts).toMatchObject({ decisions: 5, steps: 16, downgradedSteps: 4 })
    expect(read('7d').rows.map(row => row.sessionId)).toEqual(['a', 'b', 'c'])
    expect(read('all').sessions.inRange).toBe(3)
    // Exactly at the window's edge is in range.
    const edge = summary('edge', { lastAt: NOW - 24 * HOUR })
    expect(read('24h', [edge]).sessions.inRange).toBe(1)
    expect(read('24h', [summary('older', { lastAt: NOW - 24 * HOUR - 1 })]).sessions.inRange).toBe(0)
  })

  it('ranks reasons by count, then reason in code units', () => {
    const tied = summary('t', { lastAt: NOW, reasons: { 'low-confidence': ['judge-no', 2], 'Zeta': ['judge-no', 2], 'thin-margin': ['judge-no', 5] } })
    expect(read('all', [tied]).reasons.map(entry => entry.reason)).toEqual(['thin-margin', 'Zeta', 'low-confidence'])
    expect(read('all').reasons[0]).toEqual({ reason: 'current-preferred', group: 'judge-no', count: 3 })
    expect(read('all').routedSwitches).toEqual({ count: 3, tokens: 8_000 })
    expect(read('all').workspaceId).toBe('w1')
    expect(read('all').computedAt).toBe(NOW)
  })

  it('reads an empty workspace as no routing', () => {
    const empty = workspaceStats({ workspaceId: 'w1', range: 'all', now: NOW, members: 0, summarized: 0, summaries: [] })
    expect(empty.rows).toEqual([])
    expect(empty.counts.decisions).toBe(0)
    expect(empty.sessions).toEqual({ members: 0, summarized: 0, inRange: 0, included: 0, capped: false })
  })

  it('rolls up the 500 most recently routed of 501 sessions and flags the cap', () => {
    const many = Array.from({ length: WORKSPACE_STATS_SESSION_CAP + 1 }, (_, at) =>
      summary(`s${String(at).padStart(3, '0')}`, { lastAt: NOW - at * 1000, decisions: 2, steps: 3, downgradedSteps: 1 }))
    const capped = workspaceStats({ workspaceId: 'w1', range: 'all', now: NOW, members: 501, summarized: 501, summaries: [...many].reverse() })
    expect(capped.sessions).toEqual({ members: 501, summarized: 501, inRange: 501, included: 500, capped: true })
    expect(capped.rows).toHaveLength(500)
    // The oldest session is the one left out, and totals cover the included 500 only.
    expect(capped.rows.at(-1)?.sessionId).toBe('s499')
    expect(capped.rows.some(row => row.sessionId === 's500')).toBe(false)
    expect(capped.counts).toMatchObject({ decisions: 1_000, steps: 1_500, downgradedSteps: 500 })
    const exact = workspaceStats({ workspaceId: 'w1', range: 'all', now: NOW, members: 500, summarized: 500, summaries: many.slice(0, 500) })
    expect(exact.sessions).toMatchObject({ inRange: 500, included: 500, capped: false })
  })
})
