/**
 * Routing view fixtures typed against the model-router wire contract: a
 * live-shaped session (22 kept-strong decisions from a remote judge, no
 * streaks), an active session (streaks, returns, every colour slot and cold
 * cause, more than one page of decisions), and one decision detail.
 */
import type {
  ModelRoutingDecisionDetail, ModelRoutingGateView, ModelRoutingProjection, ModelRoutingStatsSnapshot,
} from '@shres-code/shres-code-model-router/client'

/** Fixed latency bounds, 1 ms to 30 s. */
export const BUCKETS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 30000]

/** The configured gate. */
export const GATE: ModelRoutingGateView = {
  downgradeThreshold: 0.8,
  downgradeMargin: 0.1,
  operatingPoints: [],
  // The router's calibration per engine; a test that reads it supplies its own.
  engines: [],
  judgmentDeadlineMs: 1500,
  entryScoreCeiling: 2,
  escalateBackScoreThreshold: 3,
  difficultyLevels: ['trivial', 'easy', 'moderate', 'hard', 'expert'],
  hold: { minSteps: 3, maxSteps: 20 },
  stateMaxChars: 12_000,
}

/** An empty snapshot: no calls and no decisions. */
export function emptyStats(): ModelRoutingStatsSnapshot {
  return {
    counts: {
      decisions: 0, consults: 0, downgradedSteps: 0, steps: 0, streaks: 0,
      keptStrong: 0, routeFailed: 0, judgeFailed: 0, deadlineHits: 0, warmUps: 0, turnsWithDecisions: 0, warmSkipped: 0,
      childRouted: 0, childFailures: 0, childSuccesses: 0, childNeutral: 0,
    },
    children: { decided: 0, routed: 0, kept: 0, byReason: [], byModel: [], failures: 0, suspended: 0 },
    recentChildren: [],
    reasons: [],
    keptReasons: [],
    exits: [],
    streakLengths: { median: null, max: null },
    confidence: { values: [], margins: [], max: null, total: 0 },
    latency: {
      bucketsMs: BUCKETS, counts: BUCKETS.map(() => 0), failed: 0, p50: null, p95: null, includesFailed: false,
    },
    eligibility: { counts: BUCKETS.map(() => 0), p50: null, p95: null },
    criticalPath: { totalMs: 0, perTurnMs: null, judgeOnly: 0 },
    judge: { calls: 0, promptTokens: 0, outputTokens: 0 },
    thresholds: [],
    models: [],
    cold: [
      { cause: 'routed-switch', count: 0, tokens: 0 },
      { cause: 'routed-return', count: 0, tokens: 0 },
      { cause: 'manual-switch', count: 0, tokens: 0 },
      { cause: 'idle-expiry', count: 0, tokens: 0 },
      { cause: 'session-start', count: 0, tokens: 0 },
      { cause: 'post-compaction', count: 0, tokens: 0 },
      { cause: 'other', count: 0, tokens: 0 },
    ],
    coldTtl: { perModel: [], fallbackMs: 300_000 },
    shadow: { decisions: 0, downgraded: 0, streaks: 0 },
    unreportedCallShare: null,
    moved: { tokensOffStrong: 0, returnReprefill: 0, objective: null },
    egress: [],
    engines: [],
    timeline: { steps: [], marks: [], decisions: [], aggregated: false },
    recent: [],
  }
}

const REASONS = ['current-preferred', 'low-confidence', 'difficulty-too-high'] as const

/** The live-demo shape: 22 kept-strong decisions over 93 steps, best confidence 0.39. */
export function liveStats(): ModelRoutingStatsSnapshot {
  const base = emptyStats()
  const steps = Array.from({ length: 93 }, (_, index) => ({
    turn: Math.floor(index / 4) + 1,
    step: (index % 4) + 1,
    lastTurn: Math.floor(index / 4) + 1,
    model: index < 3 ? 2 : index < 48 ? 1 : 0,
    seq: 100 + index * 10,
    t: index * 1_000,
  }))
  const decisions = Array.from({ length: 22 }, (_, index) => ({
    seq: 1000 + index, i: index * 4, outcome: 'kept-strong' as const,
    reason: index < 15 ? 'current-preferred' : index < 20 ? 'low-confidence' : 'difficulty-too-high',
    best: index === 21 ? null : Math.round((0.02 + (index % 10) * 0.037) * 100) / 100,
    engine: 0,
    shadow: false,
    wouldModel: null,
  }))
  const counts = BUCKETS.map(bound => (bound === 1000 ? 22 : 0))
  return {
    ...base,
    counts: {
      decisions: 22, consults: 22, downgradedSteps: 0, steps: 93, streaks: 0,
      keptStrong: 22, routeFailed: 0, judgeFailed: 0, deadlineHits: 0, warmUps: 0, turnsWithDecisions: 22, warmSkipped: 0,
      childRouted: 0, childFailures: 0, childSuccesses: 0, childNeutral: 0,
    },
    reasons: [
      { reason: 'current-preferred', group: 'judge-no', count: 15 },
      { reason: 'low-confidence', group: 'judge-no', count: 5 },
      { reason: 'difficulty-too-high', group: 'judge-no', count: 2 },
    ],
    keptReasons: REASONS.map((reason, index) => ({ reason, count: [15, 5, 2][index] ?? 0 })),
    confidence: {
      values: decisions.flatMap(entry => (entry.best === null ? [] : [entry.best])),
      margins: decisions.flatMap(entry => (entry.best === null ? [] : [Math.max(0, 0.5 - entry.best)])),
      max: 0.39,
      total: 21,
    },
    latency: { bucketsMs: BUCKETS, counts, failed: 0, p50: 1000, p95: 1000, includesFailed: false },
    eligibility: { counts: BUCKETS.map(() => 0), p50: null, p95: null },
    criticalPath: { totalMs: 22_000, perTurnMs: 1_000, judgeOnly: 22 },
    judge: { calls: 0, promptTokens: 0, outputTokens: 0 },
    thresholds: [],
    models: [
      { provider: 'claude-session', model: 'claude-opus-5-5', role: 'strong', colorSlot: 'strong', steps: 45, calls: 60, uncached: 400_000, unreported: 0, cacheRead: 9_000_000, cacheWrite: 1_300_000, output: 60_000, reportedCalls: 60 },
      { provider: 'zai', model: 'glm-5.3', role: 'other', colorSlot: 1, steps: 45, calls: 50, uncached: 0, unreported: 3_500_000, cacheRead: 0, cacheWrite: 0, output: 30_000, reportedCalls: 0 },
      { provider: 'openai', model: 'gpt-6-astra', role: 'other', colorSlot: 2, steps: 3, calls: 3, uncached: 80_000, unreported: 0, cacheRead: 0, cacheWrite: 10_000, output: 1_800, reportedCalls: 3 },
    ],
    cold: base.cold.map((row) => {
      if (row.cause === 'idle-expiry') return { ...row, count: 4, tokens: 878_000 }
      if (row.cause === 'other') return { ...row, count: 2, tokens: 393_000 }
      if (row.cause === 'manual-switch') return { ...row, count: 2, tokens: 235_000 }
      if (row.cause === 'session-start') return { ...row, count: 1, tokens: 30_600 }
      return row
    }),
    unreportedCallShare: 0.44,
    moved: { tokensOffStrong: 0, returnReprefill: 0, objective: 'quota' },
    egress: [{ engine: 'typesafe', asks: 22, chars: 264_000, bound: 'at-most' }],
    engines: [{ name: 'typesafe', decisions: 22 }],
    timeline: { steps, marks: [{ i: 3, kind: 'manual' }, { i: 48, kind: 'manual' }, { i: 60, kind: 'idle' }], decisions, aggregated: false },
    recent: decisions.slice().reverse().map(entry => ({
      seq: entry.seq, t: entry.seq * 1_000, turn: Math.floor(entry.i / 4) + 1, step: 1, outcome: entry.outcome, reason: entry.reason,
      best: entry.best, difficulty: entry.best === null ? null : 1.4, engine: 'typesafe · jev-1.13.0', latencyMs: entry.best === null ? null : 709,
    })),
  }
}

/** An active session: two candidates, streaks, a return, a route failure, and 60 recent decisions. */
export function activeStats(): ModelRoutingStatsSnapshot {
  const base = emptyStats()
  const recent = Array.from({ length: 60 }, (_, index) => ({
    seq: 2000 + index, t: index, turn: 60 - index, step: 1,
    outcome: index % 3 === 0 ? 'downgraded' as const : index % 3 === 1 ? 'kept-strong' as const : 'error' as const,
    reason: index % 3 === 0 ? 'gate-passed' : index % 3 === 1 ? 'thin-margin' : 'engine-unavailable',
    best: index % 3 === 2 ? null : 0.85,
    difficulty: index % 3 === 2 ? null : 0.6,
    engine: index % 3 === 2 ? null : 'laya',
    latencyMs: index % 3 === 2 ? null : 30,
  }))
  const counts = BUCKETS.map(bound => (bound === 20 ? 30 : bound === 50 ? 10 : 0))
  return {
    ...base,
    counts: {
      decisions: 60, consults: 40, downgradedSteps: 38, steps: 100, streaks: 6,
      keptStrong: 20, routeFailed: 2, judgeFailed: 20, deadlineHits: 3, warmUps: 0, turnsWithDecisions: 60, warmSkipped: 3,
      childRouted: 0, childFailures: 0, childSuccesses: 0, childNeutral: 0,
    },
    reasons: [
      { reason: 'gate-passed', group: 'switched', count: 20 },
      { reason: 'thin-margin', group: 'judge-no', count: 20 },
      { reason: 'engine-unavailable', group: 'engine', count: 18 },
      { reason: 'base-unlisted', group: 'fail-closed', count: 2 },
    ],
    keptReasons: [{ reason: 'thin-margin', count: 20 }],
    exits: [{ brokenBy: 'gate-failed', count: 4 }, { brokenBy: 'hold-cap', count: 2 }],
    streakLengths: { median: 5, max: 12 },
    confidence: { values: [0.85, 0.85, 0.9, 0.2], margins: [0.3, 0.3, 0.4, 0.05], max: 0.9, total: 40 },
    latency: { bucketsMs: BUCKETS, counts, failed: 20, p50: 20, p95: 50, includesFailed: true },
    eligibility: { counts: BUCKETS.map(bound => bound === 10 ? 40 : 0), p50: 10, p95: 10 },
    criticalPath: { totalMs: 1_600, perTurnMs: 40, judgeOnly: 0 },
    judge: { calls: 0, promptTokens: 0, outputTokens: 0 },
    thresholds: [],
    models: [
      { provider: 'claude-session', model: 'claude-opus-5-5', role: 'strong', colorSlot: 'strong', steps: 62, calls: 70, uncached: 100_000, unreported: 0, cacheRead: 2_000_000, cacheWrite: 300_000, output: 20_000, reportedCalls: 70 },
      { provider: 'ollama', model: 'deepseek-v4.1-flash', role: 'candidate', colorSlot: 1, steps: 30, calls: 32, uncached: 50_000, unreported: 0, cacheRead: 400_000, cacheWrite: 90_000, output: 9_000, reportedCalls: 32 },
      { provider: 'moonshot', model: 'kimi-k3', role: 'candidate', colorSlot: 2, steps: 8, calls: 8, uncached: 0, unreported: 70_000, cacheRead: 0, cacheWrite: 0, output: 2_000, reportedCalls: 0 },
      { provider: 'a', model: 'm3', role: 'other', colorSlot: 3, steps: 0, calls: 1, uncached: 1, unreported: 0, cacheRead: 0, cacheWrite: 0, output: 1, reportedCalls: 1 },
      { provider: 'a', model: 'm4', role: 'other', colorSlot: 4, steps: 0, calls: 1, uncached: 1, unreported: 0, cacheRead: 0, cacheWrite: 0, output: 1, reportedCalls: 1 },
      { provider: 'a', model: 'm5', role: 'other', colorSlot: 5, steps: 0, calls: 1, uncached: 1, unreported: 0, cacheRead: 0, cacheWrite: 0, output: 1, reportedCalls: 1 },
      { provider: 'a', model: 'm6', role: 'other', colorSlot: 'other', steps: 0, calls: 1, uncached: 1, unreported: 0, cacheRead: 0, cacheWrite: 0, output: 1, reportedCalls: 1 },
    ],
    cold: base.cold.map(row => (row.cause === 'routed-switch' ? { ...row, count: 6, tokens: 120_000 } : row.cause === 'routed-return' ? { ...row, count: 5, tokens: 80_000 } : row)),
    coldTtl: {
      perModel: [
        { provider: 'claude-session', model: 'claude-opus-5-5', ms: 3_600_000, source: 'adapter' },
      ],
      fallbackMs: 300_000,
    },
    shadow: { decisions: 0, downgraded: 0, streaks: 0 },
    unreportedCallShare: 0.07,
    moved: { tokensOffStrong: 600_000, returnReprefill: 80_000, objective: 'mixed' },
    egress: [{ engine: 'laya', asks: 40, chars: 120_000, bound: 'exact' }],
    engines: [{ name: 'laya', decisions: 40 }],
    timeline: {
      steps: [
        { turn: 1, step: 1, lastTurn: 3, model: 0, seq: 10, t: 0 },
        { turn: 4, step: 1, lastTurn: 4, model: 1, seq: 20, t: 1 },
        { turn: 5, step: 1, lastTurn: 6, model: 9, seq: 30, t: 2 },
      ],
      marks: [{ i: 1, kind: 'down' }, { i: 2, kind: 'return' }, { i: 2, kind: 'failed' }],
      decisions: [
        { seq: 11, i: 1, outcome: 'downgraded', reason: 'gate-passed', best: 0.9, engine: 0, shadow: false, wouldModel: null },
        { seq: 21, i: 2, outcome: 'error', reason: 'route-failed', best: 0.2, engine: null, shadow: false, wouldModel: null },
        { seq: 22, i: 2, outcome: 'kept-strong', reason: 'thin-margin', best: 0.5, engine: 0, shadow: false, wouldModel: null },
      ],
      aggregated: true,
    },
    recent,
  }
}

/** Routing on, with no decision logged yet. */
export const ON: ModelRoutingProjection = { mode: 'on', active: true, pending: false }
/** Routing off. */
export const OFF: ModelRoutingProjection = { mode: 'off', active: false, pending: false }

/** One logged decision as the drill-down reads it: kept strong on low confidence. */
export function decisionDetail(
  overrides: { [K in keyof ModelRoutingDecisionDetail['decision']]?: ModelRoutingDecisionDetail['decision'][K] | undefined } = {},
): ModelRoutingDecisionDetail {
  const detail = decisionDefaults(overrides)
  // An override of undefined removes the field, as a decision without it logs.
  const record = detail.decision as unknown as Record<string, unknown>
  for (const key of Object.keys(record)) if (record[key] === undefined) Reflect.deleteProperty(record, key)
  return detail
}

function decisionDefaults(overrides: object): ModelRoutingDecisionDetail {
  return {
    seq: 1037,
    time: Date.UTC(2026, 8, 25, 7, 38, 12),
    turn: 2,
    step: 1,
    gate: GATE,
    decision: {
      outcome: 'kept-strong',
      reason: 'low-confidence',
      stateHash: 'h',
      stateSeqs: [1, 2, 3],
      stateProjection: { renderer: 'conversation-v1', contextTurns: 2, maxChars: 12_000, omittedSeqs: [4] },
      candidateEligibility: {
        requirements: { requiresImage: false, provider: 'claude-session', model: 'claude-opus-5-5' },
        candidates: [
          { id: 'flash', provider: 'ollama-cloud', model: 'deepseek-v4.1-flash:cloud', reasoningEffort: 'low' as never, description: 'small, well-scoped edits in familiar code' },
          { id: 'mid-kimi', provider: 'moonshotai', model: 'kimi-k3', description: 'long-context reading and summaries' },
        ],
        eligibleCandidates: [],
        assessments: [
          { id: 'flash', provider: 'ollama-cloud', model: 'deepseek-v4.1-flash:cloud', reason: 'eligible' },
          { id: 'mid-kimi', provider: 'moonshotai', model: 'kimi-k3', reason: 'context-too-small' },
        ],
      },
      judgmentQuestions: [
        { kind: 'score', id: 'difficulty' as never, instructions: 'Rate the difficulty.', levels: ['a', 'b'] },
        { kind: 'choice', id: 'route' as never, instructions: 'Which route should handle this turn?', options: [{ option: 'keep-current', description: 'Keep current (GPT-6 Astra · high)' }, { option: 'flash' }, { option: 'mid-kimi' }] },
      ],
      judgmentInput: {
        selectedIndex: 0, state: 'USER: fix the typo', stateTokens: 612, sequenceTokens: [700], paddedTokens: 700,
        limits: {} as never,
      },
      route: { choice: 'keep-current', confidence: 0.43, probabilities: { 'keep-current': 0.43, flash: 0.39, 'mid-kimi': 0.02 } },
      difficulty: { score: 0.06, confidence: 0.9 },
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'gate-failed', entryBase: { provider: 'claude-session', model: 'claude-opus-5-5' } },
      engine: 'typesafe',
      model: 'jev-1.13.0',
      latencyMs: 765,
      engineFailure: { code: 'DEADLINE' },
      objective: 'quota',
      ...overrides,
    },
  }
}
