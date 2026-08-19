/**
 * Trial record: one line of `trials.jsonl`, the source of truth for one
 * task attempt in one arm. Aggregates are always rebuildable from these.
 *
 * @module bench/schema/trial
 */

/** Failure modes distinguish a real miss from infrastructure noise. */
export const FAILURE_MODES = Object.freeze([
  'AGENT_TIMEOUT',
  'VERIFY_FAILED',
  'HARNESS_ERROR',
  'BUDGET_EXCEEDED',
  'PROVIDER_ERROR',
])

/**
 * @typedef {object} TrialMetrics
 * @property {number} inputTokens - provider-reported input tokens, summed over requests.
 * @property {number} outputTokens - provider-reported output tokens, summed over requests.
 * @property {number} durationMs - wall time of the agent run.
 * @property {number} turns - model request count.
 * @property {number} toolCalls - `tool/call` events in the session log.
 * @property {number} [duplicateCallAttempts] - calls after the first with identical name+args; not necessarily denied.
 * @property {number} identicalRetries - compatibility alias for `duplicateCallAttempts`.
 * @property {number} [checkpointAttempts] - `jspace_checkpoint` `tool/call` events.
 * @property {number} [checkpointWrites] - Checked entries added by `jspace/card` snapshots.
 * @property {number} checkpoints - compatibility alias for `checkpointWrites`.
 * @property {number} [shipAttempts] - `jspace_ship` `tool/call` events.
 * @property {number} shipPasses - distinct `jspace_ship` calls with a non-error `tool/result`.
 * @property {number} [retryDenials] - distinct error results carrying the J-Space identical-retry denial.
 * @property {number} [cardOpens] - transitions from no open card to a valid `jspace/card`.
 * @property {number} [meaningfulGoalWrites] - non-placeholder Goal changes recorded by valid card snapshots.
 * @property {number} [placeholderGoalLeftovers] - open cards still holding the stock placeholder at session end.
 * @property {number} [coreWrites] - non-empty initial Core writes plus later Core changes.
 */

/**
 * @typedef {object} PhaseRecord - one chain phase: a separate headless spawn
 * with a fresh session root; the scratch workspace carries across phases.
 * @property {number} phaseIndex - zero-based phase order.
 * @property {string | null} sessionFile - this phase's session log path relative to the arm directory.
 * @property {string | null} resumedFrom - prior phase's session id when card-carry resume exists; always null under cold carry.
 * @property {number | null} exitCode - harness process exit code; null when killed by a signal.
 * @property {boolean} timedOut - the phase exceeded its timeout and was killed.
 * @property {TrialMetrics} metrics - this phase's metrics.
 * @property {string} startedAt - ISO 8601.
 * @property {string} endedAt - ISO 8601.
 */

/**
 * @typedef {object} Trial
 * @property {string} taskId - stable task id; with `trialIndex`, the A/B pairing key.
 * @property {number} trialIndex - zero-based repetition index.
 * @property {string} arm - arm name (`off`, `on`, …).
 * @property {'success' | 'error'} status - `error` means infrastructure failed; excluded from pass rate.
 * @property {boolean} resolved - verifier passed.
 * @property {string | null} failureMode - one of FAILURE_MODES when resolved is false.
 * @property {number} [score] - optional graded score in [0, 1] for partial-credit tasks.
 * @property {{ command: string, exitCode: number, detail?: string }} verifier - how resolved was decided.
 * @property {TrialMetrics} metrics - for chains, the per-phase sums.
 * @property {string | null} sessionFile - session log path relative to the arm directory; for chains, the final phase's.
 * @property {string} startedAt - ISO 8601.
 * @property {string} endedAt - ISO 8601.
 * @property {PhaseRecord[]} [phases] - chain trials only, in phase order.
 * @property {{ violations: string[] }} [integrity] - arm-integrity audit findings; omitted when clean.
 */

/** TrialMetrics field names, shared by trial- and phase-level validation. */
const METRIC_FIELDS = ['inputTokens', 'outputTokens', 'durationMs', 'turns', 'toolCalls', 'identicalRetries', 'checkpoints', 'shipPasses']

/** Metrics added after the first persisted W0 runs; optional when reading those records. */
const TRUTHFUL_METRIC_FIELDS = [
  'duplicateCallAttempts',
  'checkpointAttempts',
  'checkpointWrites',
  'shipAttempts',
  'retryDenials',
  'cardOpens',
  'meaningfulGoalWrites',
  'placeholderGoalLeftovers',
  'coreWrites',
]

/**
 * Validate one metrics record. Throws on the first violation.
 * @param {unknown} value - candidate.
 * @param {string} name - dotted field path used in error messages.
 * @returns {asserts value is TrialMetrics}
 */
function validateMetrics(value, name) {
  const m = /** @type {Record<string, unknown>} */ (value)
  if (typeof m !== 'object' || m === null) throw new Error(`${name} must be a record`)
  for (const field of METRIC_FIELDS) {
    if (typeof m[field] !== 'number' || m[field] < 0) throw new Error(`${name}.${field} must be a non-negative number`)
  }
  for (const field of TRUTHFUL_METRIC_FIELDS) {
    if (m[field] !== undefined && (typeof m[field] !== 'number' || m[field] < 0)) {
      throw new Error(`${name}.${field} must be a non-negative number when present`)
    }
  }
  if (m.duplicateCallAttempts !== undefined && m.duplicateCallAttempts !== m.identicalRetries) {
    throw new Error(`${name}.identicalRetries must equal duplicateCallAttempts when present`)
  }
  if (m.checkpointWrites !== undefined && m.checkpointWrites !== m.checkpoints) {
    throw new Error(`${name}.checkpoints must equal checkpointWrites when present`)
  }
  if (m.shipAttempts !== undefined && m.shipPasses > m.shipAttempts) {
    throw new Error(`${name}.shipPasses cannot exceed shipAttempts`)
  }
}

/**
 * Validate one chain phase record. Throws on the first violation.
 * @param {unknown} value - candidate.
 * @param {number} index - expected phaseIndex; phases are strictly 0..n-1 in order.
 * @returns {asserts value is PhaseRecord}
 */
function validatePhaseRecord(value, index) {
  const p = /** @type {Record<string, unknown>} */ (value)
  const name = `trial.phases[${index}]`
  if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new Error(`${name} must be a record`)
  if (p.phaseIndex !== index) throw new Error(`${name}.phaseIndex must be ${index}`)
  if (p.sessionFile !== null && typeof p.sessionFile !== 'string') throw new Error(`${name}.sessionFile must be string|null`)
  if (p.resumedFrom !== null && typeof p.resumedFrom !== 'string') throw new Error(`${name}.resumedFrom must be string|null`)
  if (p.exitCode !== null && !Number.isSafeInteger(p.exitCode)) throw new Error(`${name}.exitCode must be an integer|null`)
  if (typeof p.timedOut !== 'boolean') throw new Error(`${name}.timedOut must be boolean`)
  validateMetrics(p.metrics, `${name}.metrics`)
  for (const field of ['startedAt', 'endedAt']) {
    if (typeof p[field] !== 'string' || /** @type {string} */ (p[field]).length === 0) {
      throw new Error(`${name}.${field} must be a non-empty string`)
    }
  }
}

/**
 * Validate one trial record. Throws on the first violation.
 * @param {unknown} value - candidate.
 * @returns {asserts value is Trial}
 */
export function validateTrial(value) {
  const t = /** @type {Record<string, unknown>} */ (value)
  if (typeof t !== 'object' || t === null || Array.isArray(t)) throw new Error('trial must be a record')
  for (const field of ['taskId', 'arm', 'status', 'startedAt', 'endedAt']) {
    if (typeof t[field] !== 'string' || t[field].length === 0) throw new Error(`trial.${field} must be a non-empty string`)
  }
  if (!Number.isSafeInteger(t.trialIndex) || /** @type {number} */ (t.trialIndex) < 0) {
    throw new Error('trial.trialIndex must be a non-negative integer')
  }
  if (t.status !== 'success' && t.status !== 'error') throw new Error('trial.status must be success|error')
  if (typeof t.resolved !== 'boolean') throw new Error('trial.resolved must be boolean')
  if (t.failureMode !== null && !FAILURE_MODES.includes(/** @type {string} */ (t.failureMode))) {
    throw new Error(`trial.failureMode must be null or one of ${FAILURE_MODES.join(', ')}`)
  }
  if (t.score !== undefined && (typeof t.score !== 'number' || t.score < 0 || t.score > 1)) {
    throw new Error('trial.score must be in [0, 1] when present')
  }
  const v = /** @type {Record<string, unknown>} */ (t.verifier)
  if (typeof v !== 'object' || v === null) throw new Error('trial.verifier must be a record')
  if (typeof v.command !== 'string' || v.command.length === 0) throw new Error('trial.verifier.command required')
  if (!Number.isSafeInteger(v.exitCode)) throw new Error('trial.verifier.exitCode must be an integer')
  validateMetrics(t.metrics, 'trial.metrics')
  if (t.sessionFile !== null && typeof t.sessionFile !== 'string') throw new Error('trial.sessionFile must be string|null')
  if (t.phases !== undefined) {
    if (!Array.isArray(t.phases) || t.phases.length === 0) throw new Error('trial.phases must be a non-empty array')
    t.phases.forEach((phase, index) => validatePhaseRecord(phase, index))
  }
  if (t.integrity !== undefined) {
    const integrity = /** @type {Record<string, unknown>} */ (t.integrity)
    if (typeof integrity !== 'object' || integrity === null) throw new Error('trial.integrity must be a record')
    if (!Array.isArray(integrity.violations) || integrity.violations.some(item => typeof item !== 'string')) {
      throw new Error('trial.integrity.violations must be a string array')
    }
  }
}
