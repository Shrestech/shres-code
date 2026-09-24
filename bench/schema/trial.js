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
 * @typedef {object} TrialExecution
 * @property {number | null} exitCode - harness process exit code; null when killed by a signal.
 * @property {boolean} timedOut - the harness exceeded its task timeout and was killed.
 * @property {boolean} budgetExceeded - the live token cap terminated the harness child.
 */

/**
 * @typedef {object} TrialMetrics
 * @property {number} inputTokens - provider-reported input tokens, summed over requests.
 * @property {number} outputTokens - provider-reported output tokens, summed over requests.
 * @property {number} durationMs - wall time of the agent run.
 * @property {number} turns - model request count.
 * @property {number} toolCalls - `tool/call` events in the session log.
 * @property {number} identicalRetries - tool calls repeated with identical name+args.
 * @property {number} checkpoints - `jspace_checkpoint` calls accepted (0 in the off arm).
 * @property {number} shipPasses - `jspace_ship` calls accepted (0 in the off arm).
 * @property {number | null} tokensIncludingDescendants - input+output tokens summed over the
 *   root session and every descendant session, keyed by header `parentSession` links under the
 *   trial's persistence root (seeded `bench-prior-*` fixtures excluded). Null only when the root
 *   header cannot be read. The numerator matches `inputTokens`/`outputTokens`: `assistant/message`
 *   provider-reported usage only.
 * @property {number} descendantSessions - count of descendant sessions in the closure (excludes
 *   the root; includes descendants whose logs carry no usage events).
 * @property {number | null} costIncludingDescendants - exact API-equivalent USD over the same
 *   closure from the trial's `accounting` (`exactCost`): priced model calls plus priced judge
 *   usage, excluding subscription routes; null when any such call is unpriced or lacks a
 *   reported cache-read count, and on trials recorded before the bench priced trials.
 * @property {boolean | null} danglingCard - card open at session end (last jspace state not
 *   closed); null for jspace-off arms.
 * @property {number | null} verifiedCheckpointShare - fraction of checkpoint lines carrying
 *   `verified: true`; null when no checkpoints exist in the log.
 * @property {number} coverageRefusalThenPad - count of sequences where a jspace_checkpoint
 *   tool/result is a coverage refusal and the next jspace_checkpoint call succeeds within
 *   the same turn (the by-padding proxy).
 * @property {number} noopNoteRefusals - count of JSPACE_NOTE_NOOP tool results.
 * @property {number} noteCapRefusals - count of note-cap denial tool results.
 * @property {number | null} sessionQueryCalls - count of session_search / session_event_search
 *   / session_event_read / session_event_trace / session_trace calls; null for arms excluding
 *   the session-query consumer.
 * @property {number} compactionCount - number of `compaction/end` events in the session log
 *   (one closed compaction attempt, success or error).
 * @property {boolean} pressureFired - true when compactionCount > 0.
 * @property {boolean | null} charterRunFailNamed - a `jspace/charter-run` with phase
 *   checkpoint or ship and `passed: false` (the refusal names `entryId`); null for jspace-off.
 * @property {number | null} emptyCharterRate - 1 when the last `jspace/card` charter is empty
 *   or no card opened; 0 when the last card carries at least one entry; null for jspace-off.
 * @property {number | null} unverifiedShare - last-card `kind: 'check'` entries with
 *   `discrimination: 'unverified'`, divided by registered checks; null when no checks.
 * @property {number | null} echoOkRejectRate - floor registration refusals
 *   (`JSPACE_CHARTER_CONSTANT` / `JSPACE_CHARTER_NO_READ`, or their model-visible copy)
 *   over `jspace_open` / `jspace_charter_amend` results; null when no registration attempt.
 * @property {number | null} gateRefusals - count of tool results matching the researcher
 *   design-defense refusal (`research protocol requires a design defense`); null for arms
 *   that do not mount the researcher surface.
 * @property {number | null} debateCalls - completed aegis+ward call pairs per Goal epoch,
 *   summed (min of completed aegis and ward calls per epoch); null for non-researcher arms.
 * @property {number | null} runsLogged - `experiment_log_run` results that landed at the
 *   tracker; null for non-researcher arms. Spool-only deployments record zero.
 * @property {number | null} verifySatisfiedRate - fraction of `experiment_verify_decision_rule`
 *   calls that returned `satisfied`; null when no verify calls or non-researcher.
 * @property {number | null} unverifiedRunRefusals - count of ledger tool results carrying
 *   the `unverified-run` refusal reason; null for non-researcher arms.
 * @property {{ accepted: number, rejected: number, deferred: number } | null} ledgerDecisions -
 *   `ledger/decision` session-event counts by decision; null for non-researcher arms.
 * @property {number | null} deferredShare - fraction of ledger decisions that were `deferred`;
 *   null when no ledger decisions or non-researcher.
 * @property {boolean | null} ledgerAbandoned - a researcher trial that recorded zero ledger
 *   decisions; null for non-researcher arms.
 * @property {boolean | null} unverifiedAcceptRecovery - a researcher trial that had at least one
 *   `unverified-run` refusal and still ended with a recorded ledger decision; null for
 *   non-researcher arms.
 * @property {number | null} thinDebates - debate pairs whose combined descendant seat-token
 *   volume fell under the thinDebates floor (200); null for non-researcher arms.
 * @property {number | null} modelTransitions - consecutive `request/header` pairs whose
 *   `config.provider`/`config.model` differ. A header logged only to re-state the same route
 *   is not a transition. Null when the log carries no readable header.
 * @property {number[] | null} downgradedStreaks - run lengths of consecutive
 *   `model-routing/decision` events whose `outcome` is `downgraded`, in log order. An empty
 *   array is "judged, never downgraded"; null is "never judged".
 * @property {number | null} downgradedShare - downgraded decisions over all decisions; null when
 *   no decision was logged.
 * @property {number | null} keptStrongShare - `kept-strong` decisions over all decisions; null
 *   when no decision was logged. `skipped` and `error` decisions sit in the denominator and in
 *   neither numerator.
 * @property {number | null} routingHintCount - decisions carrying an advisory `hint` (the router
 *   logs `consider-stronger` while the manual route stands); null when no decision was logged.
 * @property {number | null} jevCompactionAcceptedBelowThreshold - `compaction/verification`
 *   events whose `verdict` is `accepted-below-threshold`; null when the log carries no
 *   verification event, which is every non-JEV compaction backend.
 * @property {number | null} jevSelectionDegraded - `compaction/selection` events with
 *   `degraded: true`; null when the log carries no selection event.
 */

/**
 * @typedef {object} PhaseRecord - one chain phase: a separate headless spawn
 * with a fresh session root; the scratch workspace carries across phases.
 * @property {number} phaseIndex - zero-based phase order.
 * @property {string | null} sessionFile - this phase's session log path relative to the arm directory.
 * @property {string | null} resumedFrom - prior phase's session id when card-carry resume exists; always null under cold carry.
 * @property {number | null} exitCode - harness process exit code; null when killed by a signal.
 * @property {boolean} timedOut - the phase exceeded its timeout and was killed.
 * @property {boolean} budgetExceeded - the live token cap terminated this phase's spawn.
 * @property {TrialMetrics} metrics - this phase's metrics.
 * @property {import('../runner/accounting.js').TrialAccounting} [accounting] - this phase's priced accounting.
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
 * @property {TrialExecution} [execution] - process outcome for a single-session spawn; absent on chain trials and legacy rows.
 * @property {string} startedAt - ISO 8601.
 * @property {string} endedAt - ISO 8601.
 * @property {PhaseRecord[]} [phases] - chain trials only, in phase order.
 * @property {string} [priceSnapshot] - id (`YYYY-MM-DD`) of the `bench/prices` snapshot the trial
 *   was priced under; absent on trials recorded before the bench priced trials.
 * @property {import('../runner/accounting.js').TrialAccounting} [accounting] - priced, cache-inclusive
 *   accounting over the root session and its descendants; for chains, the sum over phases. Its
 *   `cacheHitShare` is the trial's cache-hit share for every report, aggregate, and verdict.
 * @property {{ violations: string[] }} [integrity] - arm-integrity audit findings; omitted when clean.
 */

/** TrialMetrics field names that are always non-negative numbers. */
const METRIC_FIELDS = ['inputTokens', 'outputTokens', 'durationMs', 'turns', 'toolCalls', 'identicalRetries', 'checkpoints', 'shipPasses', 'descendantSessions', 'outOfLoopExperiments', 'coverageRefusalThenPad', 'noopNoteRefusals', 'noteCapRefusals', 'compactionCount']

/** TrialMetrics field names that are number|null. */
const NULLABLE_NUMBER_FIELDS = ['tokensIncludingDescendants', 'costIncludingDescendants', 'verifiedCheckpointShare', 'sessionQueryCalls', 'gateRefusals', 'debateCalls', 'runsLogged', 'verifySatisfiedRate', 'unverifiedRunRefusals', 'deferredShare', 'thinDebates', 'modelTransitions', 'downgradedShare', 'keptStrongShare', 'routingHintCount', 'jevCompactionAcceptedBelowThreshold', 'jevSelectionDegraded']

/** TrialMetrics field names that are boolean|null. */
const NULLABLE_BOOLEAN_FIELDS = ['danglingCard', 'ledgerAbandoned', 'unverifiedAcceptRecovery']

/** TrialMetrics field names that are required booleans. */
const BOOLEAN_FIELDS = ['pressureFired']

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
  for (const field of NULLABLE_NUMBER_FIELDS) {
    if (m[field] !== null && (typeof m[field] !== 'number' || !Number.isFinite(/** @type {number} */ (m[field])))) {
      throw new Error(`${name}.${field} must be a finite number or null`)
    }
  }
  for (const field of NULLABLE_BOOLEAN_FIELDS) {
    if (m[field] !== null && typeof m[field] !== 'boolean') {
      throw new Error(`${name}.${field} must be a boolean or null`)
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof m[field] !== 'boolean') throw new Error(`${name}.${field} must be a boolean`)
  }
  // downgradedStreaks is a nullable list of run lengths, so every entry is a
  // positive integer — a zero or negative length is not a run.
  const streaks = m.downgradedStreaks
  if (streaks !== null) {
    if (!Array.isArray(streaks) || streaks.some(length => !Number.isSafeInteger(length) || length < 1)) {
      throw new Error(`${name}.downgradedStreaks must be an array of positive integers or null`)
    }
  }
  // ledgerDecisions is a nullable object of three non-negative counts.
  const ld = m.ledgerDecisions
  if (ld !== null) {
    if (typeof ld !== 'object' || ld === null || Array.isArray(ld)) {
      throw new Error(`${name}.ledgerDecisions must be a record or null`)
    }
    for (const field of ['accepted', 'rejected', 'deferred']) {
      const count = /** @type {Record<string, unknown>} */ (ld)[field]
      if (typeof count !== 'number' || count < 0) {
        throw new Error(`${name}.ledgerDecisions.${field} must be a non-negative number`)
      }
    }
  }
}

/**
 * Validate a process outcome retained alongside a single-session trial.
 * @param {unknown} value - candidate.
 * @param {string} name - dotted field path used in error messages.
 * @returns {asserts value is TrialExecution}
 */
function validateExecution(value, name) {
  const execution = /** @type {Record<string, unknown>} */ (value)
  if (typeof execution !== 'object' || execution === null || Array.isArray(execution)) {
    throw new Error(`${name} must be a record`)
  }
  if (execution.exitCode !== null && !Number.isSafeInteger(execution.exitCode)) {
    throw new Error(`${name}.exitCode must be an integer|null`)
  }
  if (typeof execution.timedOut !== 'boolean') throw new Error(`${name}.timedOut must be boolean`)
  if (typeof execution.budgetExceeded !== 'boolean') throw new Error(`${name}.budgetExceeded must be boolean`)
}

/**
 * Validate one accounting record. Throws on the first violation.
 * @param {unknown} value - candidate.
 * @param {string} name - dotted field path used in error messages.
 * @returns {void}
 */
function validateAccounting(value, name) {
  const a = /** @type {Record<string, unknown>} */ (value)
  if (typeof a !== 'object' || a === null || Array.isArray(a)) throw new Error(`${name} must be a record`)
  const nonNegative = (record, fields, path) => {
    for (const field of fields) {
      const count = record[field]
      if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
        throw new Error(`${path}.${field} must be a non-negative number`)
      }
    }
  }
  nonNegative(a, ['calls', 'unreportedCalls', 'dollars', 'dollarsUpperBound', 'offPeakCalls', 'unpricedCalls', 'quotaCalls', 'quotaTokens', 'quotaUnpricedTokens'], name)
  const tokens = /** @type {Record<string, unknown>} */ (a.tokens)
  if (typeof tokens !== 'object' || tokens === null) throw new Error(`${name}.tokens must be a record`)
  nonNegative(tokens, ['uncachedInput', 'unreportedInput', 'output', 'cacheRead', 'cacheWrite'], `${name}.tokens`)
  for (const field of ['cacheHitShare', 'unreportedShare']) {
    const share = a[field]
    if (share !== null && (typeof share !== 'number' || share < 0 || share > 1)) throw new Error(`${name}.${field} must be in [0, 1] or null`)
  }
  if (!Array.isArray(a.unpricedModels) || a.unpricedModels.some(item => typeof item !== 'string')) {
    throw new Error(`${name}.unpricedModels must be a string array`)
  }
  const numbers = (list, path) => {
    if (!Array.isArray(list) || list.some(item => typeof item !== 'number' || !Number.isFinite(item) || item < 0)) {
      throw new Error(`${path} must be an array of non-negative numbers`)
    }
  }
  numbers(a.ttftSamplesMs, `${name}.ttftSamplesMs`)
  const judge = /** @type {Record<string, unknown>} */ (a.judge)
  if (typeof judge !== 'object' || judge === null) throw new Error(`${name}.judge must be a record`)
  nonNegative(judge, ['calls', 'latencyMs', 'criticalPathMs', 'vendorPlanCalls', 'pricedCalls', 'unpricedCalls', 'dollars', 'dollarsUpperBound'], `${name}.judge`)
  numbers(judge.latencySamplesMs, `${name}.judge.latencySamplesMs`)
  const byKind = /** @type {Record<string, unknown>} */ (judge.callsByKind)
  if (typeof byKind !== 'object' || byKind === null) throw new Error(`${name}.judge.callsByKind must be a record`)
  nonNegative(byKind, ['decision', 'child-decision', 'shadow-decision'], `${name}.judge.callsByKind`)
  const byEngine = judge.byEngine
  if (typeof byEngine !== 'object' || byEngine === null || Array.isArray(byEngine)) {
    throw new Error(`${name}.judge.byEngine must be a record`)
  }
  nonNegative(/** @type {Record<string, unknown>} */ (byEngine), Object.keys(byEngine), `${name}.judge.byEngine`)
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
  if (p.accounting !== undefined) validateAccounting(p.accounting, `${name}.accounting`)
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
  if (t.execution !== undefined) validateExecution(t.execution, 'trial.execution')
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
  if (t.priceSnapshot !== undefined && (typeof t.priceSnapshot !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t.priceSnapshot))) {
    throw new Error('trial.priceSnapshot must be a YYYY-MM-DD snapshot id when present')
  }
  if (t.accounting !== undefined) validateAccounting(t.accounting, 'trial.accounting')
  if ((t.priceSnapshot === undefined) !== (t.accounting === undefined)) {
    throw new Error('trial.priceSnapshot and trial.accounting are recorded together')
  }
  if (t.integrity !== undefined) {
    const integrity = /** @type {Record<string, unknown>} */ (t.integrity)
    if (typeof integrity !== 'object' || integrity === null) throw new Error('trial.integrity must be a record')
    if (!Array.isArray(integrity.violations) || integrity.violations.some(item => typeof item !== 'string')) {
      throw new Error('trial.integrity.violations must be a string array')
    }
  }
}
