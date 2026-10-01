/**
 * Session-log metrics fold: one raw JSONL session log (`compression: none`)
 * collapses into the {@link TrialMetrics} of one trial.
 *
 * Event shapes come from `shres-session`'s SessionEventMap: the envelope is
 * `{ type, seq, time, data }` with `time` in epoch ms; `tool/call` data is
 * `{ turn, step, callId, name, arguments }` with `arguments` the model's raw
 * JSON string; `assistant/message` data carries `usage` with provider-reported
 * `inputTokens`/`outputTokens`; `step/end` lands exactly once per entered
 * step, so it is the model-request count. Packed chunk rows and unknown event
 * types are ignored, so the fold does not care about `packChunks`.
 *
 * Forensics metrics (added for the W0 arm-ladder evaluation):
 * - danglingCard: whether a jspace card was open at session end.
 * - verifiedCheckpointShare: fraction of checkpoints with verified: true.
 * - coverageRefusalThenPad: checkpoint refusal → immediate retry success count.
 * - noopNoteRefusals / noteCapRefusals: JSPACE_NOTE_NOOP and note-cap counts.
 * - sessionQueryCalls: count of session-query tool calls.
 * - compactionCount: count of `compaction/end` events (one closed attempt).
 * - pressureFired: true when compactionCount > 0.
 * - charterRunFailNamed: a `jspace/charter-run` with phase checkpoint|ship and passed false.
 * - emptyCharterRate: 1 when the last `jspace/card` charter is empty or no card opened.
 * - unverifiedShare: last-card checks with discrimination `unverified`, over registered checks.
 * - echoOkRejectRate: floor registration refusals (JSPACE_CHARTER_CONSTANT / JSPACE_CHARTER_NO_READ)
 *   over `jspace_open` / `jspace_charter_amend` results. The event name is `jspace/charter-amend`.
 * - outOfLoopExperiments: `run_code` tool calls in this session — programmatic computation
 *   outside the conversational tool loop. Subagent delegation (a separate experiment class)
 *   is counted from descendant-session headers in `descendants.js`, not from tool names,
 *   because the delegation tool name is configurable.
 *
 * Jev routing/compaction metrics (added for the WP-jev experiment surface) read the
 * model-router and compaction-jev log-only events, so they are null for arms that
 * compose neither (all-null is the honest reading of "never judged", which is why
 * every one of them is nullable rather than zero):
 * - cacheHitShare: root session only. Cache reads over the prompt tokens (input
 *   plus cache reads and writes) of the `assistant/message` usage records that
 *   report a cache-read count, by the `TokenUsage` presence contract: a record
 *   without one is unreported and excluded, never read as a miss. Null when no
 *   record reports one or the reported prompt is zero. The closure-wide,
 *   per-call figure is `accounting.cacheHitShare` (`accounting.js`); both use
 *   `cacheShares`.
 * - cacheUnreportedShare: root session only. The share of prompt tokens carried
 *   by usage records without a reported cache-read count, so the root share never
 *   hides unreported input. Null when the root session reported no prompt tokens.
 * - modelTransitions: consecutive `request/header` events whose provider/model differ.
 *   Null when the log carries no readable header.
 * - downgradedStreaks: run lengths of consecutive `model-routing/decision` events with
 *   outcome `downgraded`; null when the log carries no decision.
 * - downgradedShare / keptStrongShare: those outcomes over every decision; null when the
 *   log carries no decision. `skipped` and `error` decisions stay in the denominator.
 * - routingHintCount: decisions carrying the advisory `hint` the router logs while the
 *   manual route stands; null when the log carries no decision.
 * - jevCompactionAcceptedBelowThreshold: `compaction/verification` verdict counts.
 * - jevSelectionDegraded: `compaction/selection` events with `degraded: true`.
 *   Both are null when the log carries no event of that type, which is every backend
 *   other than compaction-jev.
 *
 * Researcher integrity metrics (added for the WP-research experiment surface) are all
 * log-derived — never model self-reports — and null for arms that do not mount the
 * researcher surface:
 * - gateRefusals: tool results matching the design-defense refusal.
 * - debateCalls: completed aegis+ward call pairs per Goal epoch, summed.
 * - runsLogged: `experiment_log_run` results that recorded a run (landed or spooled).
 * - verifySatisfiedRate: satisfied / `experiment_verify_decision_rule` calls.
 * - unverifiedRunRefusals: ledger results carrying the `unverified-run` refusal.
 * - ledgerDecisions: `ledger/decision` event counts by decision.
 * - deferredShare, ledgerAbandoned, unverifiedAcceptRecovery: derived from the above.
 * - thinDebates: debate pairs whose combined descendant seat-token volume fell under the
 *   thinDebates floor. The root fold cannot see descendant tokens, so it is computed by
 *   the async {@link computeThinDebates} over the descendant closure and assigned in the
 *   runner after {@link foldSessionLog}.
 *
 * @module bench/runner/metrics
 */

import { canonicalize } from '../canonical-json.js'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cacheShares } from './accounting.js'

/**
 * @typedef {import('../schema/trial.js').TrialMetrics} TrialMetrics
 */

/** Tool names whose calls count as accepted J-Space checkpoint/ship usage. */
const CHECKPOINT_TOOL = 'jspace_checkpoint'
const SHIP_TOOL = 'jspace_ship'

/** Code-mode programmatic-computation tool (RUN_CODE_NAME in `shres-tools`). */
const RUN_CODE_TOOL = 'run_code'

/** Session-query tool names. */
const SESSION_QUERY_TOOLS = new Set([
  'session_search',
  'session_event_search',
  'session_event_read',
  'session_event_trace',
  'session_trace',
])

/** Tools that register charter entries (floor refusals land on their results). */
const CHARTER_REGISTRATION_TOOLS = new Set(['jspace_open', 'jspace_charter_amend'])

/** Floor echo-ok refusals: named codes plus the model-visible copy the throw uses. */
const ECHO_OK_REFUSE = /JSPACE_CHARTER_CONSTANT|JSPACE_CHARTER_NO_READ|is a constant-success command|names no workspace read/

/** Refusal indicators in tool/result data for coverage and note diagnostics. */
const NOOP_NOTE_MARKER = 'JSPACE_NOTE_NOOP'
const NOTE_CAP_MARKER = 'note cap'

/** Researcher design-defense refusal prefix (DESIGN_DEFENSE_DENY_PREFIX). */
const DESIGN_DEFENSE_REFUSAL = /research protocol requires a design defense/

/** Ledger record refusal for a cited run whose machine rule did not re-execute to satisfied. */
const UNVERIFIED_RUN_REFUSAL = /unverified-run/

/** Debate seats whose completed calls satisfy the research design defense. */
const DEBATE_TOOLS = ['aegis', 'ward']

/** Model-facing tracker tools the integrity fold watches. */
const TRACKER_RUN_TOOL = 'experiment_log_run'
const TRACKER_VERIFY_TOOL = 'experiment_verify_decision_rule'

/** Landed-run result marker from `formatRunOutput`. */
const RUN_LANDED_MARKER = 'Logged experiment run'
const RUN_SPOOLED_MARKER = 'held in the local spool'

/** Satisfied verify verdict marker from `formatVerifyOutput`. */
const VERIFY_SATISFIED_MARKER = 'Decision rule satisfied'

/** thinDebates token floor: a debate pair under it is a minimal (thin) debate. */
export const THIN_DEBATES_FLOOR = 200

/**
 * Verification verdict meaning the better draft was kept below the pass threshold:
 * the draft failed its battery and no escalation remained.
 */
const VERDICT_ACCEPTED_BELOW_THRESHOLD = 'accepted-below-threshold'

/**
 * Flatten tool/result text from the durable `message` payload or the older
 * bench-synthetic `result` string.
 * @param {Record<string, unknown>} data - tool/result data.
 * @returns {string} concatenated text blocks.
 */
function extractToolResultText(data) {
  if (typeof data.result === 'string') return data.result
  return collectText(data.message)
}

/**
 * Walk a tool-result message (or nested content) for text blocks.
 * @param {unknown} value - message, content array, or text node.
 * @returns {string} joined text.
 */
function collectText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(collectText).join('\n')
  if (typeof value === 'object' && value !== null) {
    const record = /** @type {Record<string, unknown>} */ (value)
    if (typeof record.text === 'string') return record.text
    if (record.content !== undefined) return collectText(record.content)
  }
  return ''
}

/**
 * Whether a tool/result reflects a completed (non-error) call. The durable
 * message form carries an explicit `isError` on its `tool-result` block; the
 * plain bench-synthetic `result` string form has no error flag, so a result's
 * presence is completion. Mirrors the research-protocol gate's evidence walk.
 * @param {Record<string, unknown>} data - tool/result data.
 * @returns {boolean} true when the result is not an explicit error.
 */
function isNonErrorResult(data) {
  const message = data.message
  if (typeof message === 'object' && message !== null) {
    const source = /** @type {Record<string, unknown>} */ (message).source
    if (typeof source === 'object' && source !== null && source.kind === 'tool') {
      const content = Array.isArray(message.content) ? message.content : []
      const block = content.find(part =>
        typeof part === 'object' && part !== null && /** @type {Record<string, unknown>} */ (part).type === 'tool-result')
      return block === undefined || /** @type {Record<string, unknown>} */ (block).isError !== true
    }
  }
  return true
}

/**
 * Call id on a tool/result: durable `message.source.callId`, else `callId`.
 * @param {Record<string, unknown>} data - tool/result data.
 * @returns {string} call id or empty.
 */
function resultCallId(data) {
  const message = data.message
  if (typeof message === 'object' && message !== null) {
    const source = /** @type {Record<string, unknown>} */ (message).source
    if (typeof source === 'object' && source !== null) {
      const callId = /** @type {Record<string, unknown>} */ (source).callId
      if (typeof callId === 'string') return callId
    }
  }
  return typeof data.callId === 'string' ? data.callId : ''
}

/**
 * Identity key for one `tool/call`: name plus canonical arguments. Args that
 * do not parse stay opaque but still compare byte-for-byte.
 * @param {string} name - tool name.
 * @param {unknown} rawArguments - the event's raw `arguments` string.
 * @returns {string} the grouping key.
 */
function toolCallKey(name, rawArguments) {
  if (typeof rawArguments !== 'string') return name
  try {
    return `${name}\n${canonicalize(JSON.parse(rawArguments))}`
  } catch {
    // `arguments` is model-produced raw JSON; an unparseable string still
    // groups retries correctly when compared verbatim.
    return `${name}\n${rawArguments}`
  }
}

/**
 * Fold a whole session log into trial metrics. Corrupt JSON lines throw with
 * their line number — a log the runner managed to locate should be complete,
 * and silent truncation would corrupt the comparison.
 * @param {string} text - raw JSONL file contents.
 * @param {{ expectsSessionQuery: boolean, expectsJspace: boolean }} [armFlags] -
 *   arm-level flags that decide whether nullable fields report a value or null.
 * @returns {TrialMetrics} the folded metrics; `durationMs` spans first to last
 * timestamped record (0 on an empty log).
 */
export function foldSessionLog(text, armFlags) {
  const hasJspace = armFlags?.expectsJspace ?? true
  const hasSq = armFlags?.expectsSessionQuery ?? true
  const hasResearcher = armFlags?.expectsResearcher ?? false

  /** @type {TrialMetrics} */
  const metrics = {
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    turns: 0,
    toolCalls: 0,
    identicalRetries: 0,
    checkpoints: 0,
    shipPasses: 0,
    outOfLoopExperiments: 0,
    tokensIncludingDescendants: null,
    costIncludingDescendants: null,
    descendantSessions: 0,
    danglingCard: hasJspace ? false : null,
    verifiedCheckpointShare: null,
    coverageRefusalThenPad: 0,
    noopNoteRefusals: 0,
    noteCapRefusals: 0,
    sessionQueryCalls: hasSq ? 0 : null,
    compactionCount: 0,
    pressureFired: false,
    charterRunFailNamed: hasJspace ? false : null,
    emptyCharterRate: hasJspace ? 1 : null,
    unverifiedShare: null,
    echoOkRejectRate: null,
    gateRefusals: null,
    debateCalls: null,
    runsLogged: null,
    verifySatisfiedRate: null,
    unverifiedRunRefusals: null,
    ledgerDecisions: null,
    deferredShare: null,
    ledgerAbandoned: null,
    unverifiedAcceptRecovery: null,
    thinDebates: null,
    cacheHitShare: null,
    cacheUnreportedShare: null,
    modelTransitions: null,
    downgradedStreaks: null,
    downgradedShare: null,
    keptStrongShare: null,
    routingHintCount: null,
    jevCompactionAcceptedBelowThreshold: null,
    jevSelectionDegraded: null,
  }
  /** @type {Map<string, number>} */
  const callCounts = new Map()
  /** @type {Map<string, string>} */
  const callNames = new Map()
  let minTime = Number.POSITIVE_INFINITY
  let maxTime = 0

  let totalCheckpoints = 0
  let verifiedCheckpoints = 0
  let lastCheckpointWasRefusal = false
  let lastCheckpointTurn = -1
  let cardOpen = false
  /** @type {unknown[] | undefined} */
  let lastCharter
  let registrationAttempts = 0
  let echoOkRejects = 0

  // Researcher integrity state.
  let gateRefusals = 0
  let runsLogged = 0
  let verifyCalls = 0
  let verifySatisfied = 0
  let unverifiedRunRefusals = 0
  let ledgerAccepted = 0
  let ledgerRejected = 0
  let ledgerDeferred = 0
  let currentEpoch = 0
  /** @type {Map<string, { tool: string, epoch: number }>} */
  const pendingDebate = new Map()
  /** @type {Map<number, { aegis: number, ward: number }>} */
  const debateByEpoch = new Map()

  // Jev routing/compaction state.
  /** @type {{ provider: string, model: string } | null} */
  let lastHeaderRoute = null
  // Root-session prompt tokens split by cache-read presence.
  let reportedPrompt = 0
  let reportedCacheRead = 0
  let unreportedPrompt = 0
  let headerEvents = 0
  let modelTransitions = 0
  let routingDecisions = 0
  let routingDowngraded = 0
  let routingKeptStrong = 0
  let routingHints = 0
  let openDowngradedRun = 0
  /** @type {number[]} */
  const downgradedRuns = []
  let verificationEvents = 0
  let acceptedBelowThreshold = 0
  let selectionEvents = 0
  let selectionDegraded = 0

  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    /** @type {{ type?: unknown, time?: unknown, data?: unknown }} */
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      throw new Error(`session log line ${index + 1} is not valid JSON: ${/** @type {Error} */ (error).message}`)
    }
    if (typeof event.time === 'number' && Number.isFinite(event.time)) {
      if (event.time < minTime) minTime = event.time
      if (event.time > maxTime) maxTime = event.time
    }
    const data = /** @type {Record<string, unknown>} */ (event.data ?? {})
    switch (event.type) {
      case 'step/end':
        metrics.turns += 1
        break
      case 'tool/call': {
        metrics.toolCalls += 1
        const name = typeof data.name === 'string' ? data.name : ''
        if (typeof data.callId === 'string') callNames.set(data.callId, name)
        if (name === CHECKPOINT_TOOL) metrics.checkpoints += 1
        if (name === SHIP_TOOL) metrics.shipPasses += 1
        if (name === RUN_CODE_TOOL) metrics.outOfLoopExperiments += 1
        if (name === TRACKER_VERIFY_TOOL) verifyCalls += 1
        if (hasSq && SESSION_QUERY_TOOLS.has(name)) {
          metrics.sessionQueryCalls = (metrics.sessionQueryCalls ?? 0) + 1
        }
        if (DEBATE_TOOLS.includes(name) && typeof data.callId === 'string') {
          pendingDebate.set(data.callId, { tool: name, epoch: currentEpoch })
        }
        const key = toolCallKey(name, data.arguments)
        callCounts.set(key, (callCounts.get(key) ?? 0) + 1)
        const turn = typeof data.turn === 'number' ? data.turn : -1
        if (name === CHECKPOINT_TOOL && lastCheckpointWasRefusal && turn === lastCheckpointTurn) {
          metrics.coverageRefusalThenPad += 1
        }
        lastCheckpointWasRefusal = false
        break
      }
      case 'tool/result': {
        const resultName = typeof data.name === 'string' ? data.name : (callNames.get(resultCallId(data)) ?? '')
        const resultText = typeof data.result === 'string' ? data.result : ''
        if (hasJspace && CHARTER_REGISTRATION_TOOLS.has(resultName)) {
          const charterText = resultText.length > 0 ? resultText : extractToolResultText(data)
          registrationAttempts += 1
          if (ECHO_OK_REFUSE.test(charterText)) echoOkRejects += 1
        }
        if (resultName === CHECKPOINT_TOOL) {
          totalCheckpoints += 1
          if (resultText.includes('verified') && resultText.includes('true')) {
            verifiedCheckpoints += 1
          }
          if (resultText.includes('coverage') && (resultText.includes('refused') || resultText.includes('refusal') || resultText.includes('REFUSED'))) {
            lastCheckpointWasRefusal = true
            lastCheckpointTurn = typeof data.turn === 'number' ? data.turn : -1
          } else {
            lastCheckpointWasRefusal = false
          }
        }
        if (resultText.includes(NOOP_NOTE_MARKER)) {
          metrics.noopNoteRefusals += 1
        }
        if (resultText.includes(NOTE_CAP_MARKER)) {
          metrics.noteCapRefusals += 1
        }
        if (hasResearcher) {
          const text = resultText.length > 0 ? resultText : extractToolResultText(data)
          if (DESIGN_DEFENSE_REFUSAL.test(text)) gateRefusals += 1
          if (UNVERIFIED_RUN_REFUSAL.test(text)) unverifiedRunRefusals += 1
          // A run is logged whether it landed or was held in the spool: the
          // spool preserves the machine rule, so both satisfy record-time
          // verification in the spool-only posture.
          if (resultName === TRACKER_RUN_TOOL
            && (text.includes(RUN_LANDED_MARKER) || text.includes(RUN_SPOOLED_MARKER))) runsLogged += 1
          if (resultName === TRACKER_VERIFY_TOOL && text.includes(VERIFY_SATISFIED_MARKER)) verifySatisfied += 1
          // Match a debate call by its durable callId first; plain-string bench
          // logs may omit callId, so fall back to the oldest pending call of the
          // same tool.
          const callId = resultCallId(data)
          let pending = pendingDebate.get(callId)
          if (pending === undefined && DEBATE_TOOLS.includes(resultName)) {
            for (const [key, entry] of pendingDebate) {
              if (entry.tool === resultName) {
                pendingDebate.delete(key)
                pending = entry
                break
              }
            }
          }
          if (pending !== undefined) {
            if (pendingDebate.get(callId) !== undefined) pendingDebate.delete(callId)
            if (isNonErrorResult(data)) {
              const bucket = debateByEpoch.get(pending.epoch) ?? { aegis: 0, ward: 0 }
              if (pending.tool === 'aegis') bucket.aegis += 1
              else if (pending.tool === 'ward') bucket.ward += 1
              debateByEpoch.set(pending.epoch, bucket)
            }
          }
        }
        break
      }
      case 'assistant/message': {
        const rawUsage = data.usage
        if (typeof rawUsage !== 'object' || rawUsage === null) break
        const usage = /** @type {Record<string, unknown>} */ (rawUsage)
        if (typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens)) {
          metrics.inputTokens += usage.inputTokens
        }
        if (typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)) {
          metrics.outputTokens += usage.outputTokens
        }
        const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
        const prompt = (count(usage.inputTokens) ? usage.inputTokens : 0) + (count(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0)
        if (count(usage.cacheReadTokens)) {
          reportedPrompt += prompt + usage.cacheReadTokens
          reportedCacheRead += usage.cacheReadTokens
        } else {
          unreportedPrompt += prompt
        }
        break
      }
      case 'model-routing/decision': {
        // One decision per judged turn. Any outcome other than a downgrade ends
        // the open run, so a run is a maximal span of consecutive downgrades.
        routingDecisions += 1
        const outcome = data.outcome
        if (outcome === 'downgraded') {
          routingDowngraded += 1
          openDowngradedRun += 1
        } else {
          if (openDowngradedRun > 0) downgradedRuns.push(openDowngradedRun)
          openDowngradedRun = 0
          if (outcome === 'kept-strong') routingKeptStrong += 1
        }
        // The advisory hint the router logs while the manual route stands.
        if (typeof data.hint === 'string' && data.hint.length > 0) routingHints += 1
        break
      }
      case 'compaction/verification':
        verificationEvents += 1
        if (data.verdict === VERDICT_ACCEPTED_BELOW_THRESHOLD) acceptedBelowThreshold += 1
        break
      case 'compaction/selection':
        selectionEvents += 1
        if (data.degraded === true) selectionDegraded += 1
        break
      case 'request/header': {
        const header = /** @type {Record<string, unknown>} */ (data.header ?? {})
        const config = /** @type {Record<string, unknown>} */ (header.config ?? {})
        const provider = config.provider
        const model = config.model
        if (typeof provider !== 'string' || typeof model !== 'string') break
        headerEvents += 1
        if (lastHeaderRoute !== null && (lastHeaderRoute.provider !== provider || lastHeaderRoute.model !== model)) {
          modelTransitions += 1
        }
        lastHeaderRoute = { provider, model }
        break
      }
      case 'jspace/card':
        cardOpen = true
        lastCharter = Array.isArray(data.charter) ? data.charter : []
        if (typeof data.goalOpenedSeq === 'number' && data.goalOpenedSeq > currentEpoch) {
          currentEpoch = data.goalOpenedSeq
        }
        break
      case 'jspace/closed':
        cardOpen = false
        break
      case 'jspace/charter-run': {
        const phase = data.phase
        if (hasJspace && (phase === 'checkpoint' || phase === 'ship') && data.passed === false) {
          metrics.charterRunFailNamed = true
        }
        break
      }
      case 'ledger/decision': {
        if (!hasResearcher) break
        const decision = data.decision
        if (decision === 'accepted') ledgerAccepted += 1
        else if (decision === 'rejected') ledgerRejected += 1
        else if (decision === 'deferred') ledgerDeferred += 1
        break
      }
      case 'compaction/end':
        metrics.compactionCount += 1
        break
      default:
        break
    }
  }

  for (const count of callCounts.values()) {
    if (count > 1) metrics.identicalRetries += count - 1
  }
  metrics.durationMs = minTime === Number.POSITIVE_INFINITY ? 0 : maxTime - minTime

  if (hasJspace) metrics.danglingCard = cardOpen
  if (hasJspace) {
    metrics.emptyCharterRate = lastCharter === undefined || lastCharter.length === 0 ? 1 : 0
    if (lastCharter !== undefined) {
      const checks = lastCharter.filter(entry =>
        typeof entry === 'object' && entry !== null && /** @type {Record<string, unknown>} */ (entry).kind === 'check')
      if (checks.length > 0) {
        const unverified = checks.filter(entry =>
          /** @type {Record<string, unknown>} */ (entry).discrimination === 'unverified').length
        metrics.unverifiedShare = unverified / checks.length
      }
    }
    if (registrationAttempts > 0) {
      metrics.echoOkRejectRate = echoOkRejects / registrationAttempts
    }
  }
  if (totalCheckpoints > 0) {
    metrics.verifiedCheckpointShare = verifiedCheckpoints / totalCheckpoints
  }
  metrics.pressureFired = metrics.compactionCount > 0

  // Jev routing/compaction fold. Every field stays null when its events are
  // absent: a never-judged trial must not read as "judged, never downgraded".
  const shares = cacheShares({ reportedPrompt, cacheRead: reportedCacheRead, unreportedPrompt })
  metrics.cacheHitShare = shares.cacheHitShare
  metrics.cacheUnreportedShare = shares.unreportedShare
  if (headerEvents > 0) metrics.modelTransitions = modelTransitions
  if (routingDecisions > 0) {
    if (openDowngradedRun > 0) downgradedRuns.push(openDowngradedRun)
    metrics.downgradedStreaks = downgradedRuns
    metrics.downgradedShare = routingDowngraded / routingDecisions
    metrics.keptStrongShare = routingKeptStrong / routingDecisions
    metrics.routingHintCount = routingHints
  }
  if (verificationEvents > 0) metrics.jevCompactionAcceptedBelowThreshold = acceptedBelowThreshold
  if (selectionEvents > 0) metrics.jevSelectionDegraded = selectionDegraded

  if (hasResearcher) {
    let debateCalls = 0
    for (const bucket of debateByEpoch.values()) {
      debateCalls += Math.min(bucket.aegis, bucket.ward)
    }
    const ledgerTotal = ledgerAccepted + ledgerRejected + ledgerDeferred
    metrics.gateRefusals = gateRefusals
    metrics.debateCalls = debateCalls
    metrics.runsLogged = runsLogged
    metrics.verifySatisfiedRate = verifyCalls > 0 ? verifySatisfied / verifyCalls : null
    metrics.unverifiedRunRefusals = unverifiedRunRefusals
    metrics.ledgerDecisions = { accepted: ledgerAccepted, rejected: ledgerRejected, deferred: ledgerDeferred }
    metrics.deferredShare = ledgerTotal > 0 ? ledgerDeferred / ledgerTotal : null
    metrics.ledgerAbandoned = ledgerTotal === 0
    metrics.unverifiedAcceptRecovery = unverifiedRunRefusals > 0 && ledgerTotal > 0
    metrics.thinDebates = 0
  }

  return metrics
}

/**
 * Zeroed metrics for trials whose session log never materialized.
 * @returns {TrialMetrics} all-zero metrics with nulls for arm-dependent fields.
 */
export function emptyMetrics() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    turns: 0,
    toolCalls: 0,
    identicalRetries: 0,
    checkpoints: 0,
    shipPasses: 0,
    outOfLoopExperiments: 0,
    tokensIncludingDescendants: null,
    costIncludingDescendants: null,
    descendantSessions: 0,
    danglingCard: null,
    verifiedCheckpointShare: null,
    coverageRefusalThenPad: 0,
    noopNoteRefusals: 0,
    noteCapRefusals: 0,
    sessionQueryCalls: null,
    compactionCount: 0,
    pressureFired: false,
    charterRunFailNamed: null,
    emptyCharterRate: null,
    unverifiedShare: null,
    echoOkRejectRate: null,
    gateRefusals: null,
    debateCalls: null,
    runsLogged: null,
    verifySatisfiedRate: null,
    unverifiedRunRefusals: null,
    ledgerDecisions: null,
    deferredShare: null,
    ledgerAbandoned: null,
    unverifiedAcceptRecovery: null,
    thinDebates: null,
    cacheHitShare: null,
    cacheUnreportedShare: null,
    modelTransitions: null,
    downgradedStreaks: null,
    downgradedShare: null,
    keptStrongShare: null,
    routingHintCount: null,
    jevCompactionAcceptedBelowThreshold: null,
    jevSelectionDegraded: null,
  }
}

/**
 * Parse one session-log text into its ordered debate (aegis/ward) tool calls.
 * Used by {@link computeThinDebates} to attribute descendant token usage to the
 * debate seats that spawned it.
 * @param {string} text - raw JSONL root-session contents.
 * @returns {{ name: string, time: number }[]} debate tool calls in first-seen order.
 */
function debateCallsFromLog(text) {
  /** @type {{ name: string, time: number }[]} */
  const calls = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    /** @type {{ type?: unknown, time?: unknown, data?: unknown }} */
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type !== 'tool/call') continue
    const data = /** @type {Record<string, unknown>} */ (event.data ?? {})
    const name = typeof data.name === 'string' ? data.name : ''
    if (!DEBATE_TOOLS.includes(name)) continue
    calls.push({ name, time: typeof event.time === 'number' ? event.time : 0 })
  }
  return calls
}

/**
 * Count debate pairs whose combined descendant seat-token volume falls under
 * the thinDebates floor. Signal-only: descendant session headers record their
 * `parentSession` and `createdAt` but not which parent tool call spawned them,
 * so each descendant is bucketed to the nearest preceding debate tool call by
 * creation time, and each completed aegis call pairs with the next completed
 * ward call in the same epoch. The root fold cannot see descendant tokens, so
 * the runner calls this after {@link foldSessionLog}.
 * @param {string} sessionLogRoot - per-trial persistence root (descendant logs live here).
 * @param {string} rootText - the trial's root session-log text.
 * @returns {Promise<number>} count of thin debate pairs.
 */
export async function computeThinDebates(sessionLogRoot, rootText) {
  const calls = debateCallsFromLog(rootText)
  if (calls.length === 0) return 0

  // Walk descendant session logs, folding usage and keeping their creation time.
  /** @type {string[]} */
  const logs = []
  /** @param {string} dir */
  const walk = async dir => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name === 'session.jsonl') logs.push(path)
    }
  }
  await walk(sessionLogRoot)

  /** @type {{ tokens: number, createdAt: number, parent: string | null }[]} */
  const descendants = []
  for (const path of logs) {
    const text = await readFile(path, 'utf8')
    const firstLine = text.split('\n', 1)[0] ?? ''
    /** @type {{ type?: unknown, id?: unknown, createdAt?: unknown, parentSession?: unknown }} */
    let header
    try {
      header = JSON.parse(firstLine)
    } catch {
      continue
    }
    if (header.type !== 'session' || typeof header.id !== 'string') continue
    let input = 0
    let output = 0
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type !== 'assistant/message') continue
      const usage = /** @type {Record<string, unknown>} */ ((/** @type {Record<string, unknown>} */ (event.data ?? {})).usage ?? {})
      if (typeof usage.inputTokens === 'number') input += usage.inputTokens
      if (typeof usage.outputTokens === 'number') output += usage.outputTokens
    }
    descendants.push({
      tokens: input + output,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
      parent: typeof header.parentSession === 'string' ? header.parentSession : null,
    })
  }

  // Attribute each descendant to the nearest preceding debate call.
  /** @type {number[]} */
  const callTokens = new Array(calls.length).fill(0)
  for (const child of descendants) {
    let best = -1
    for (let i = 0; i < calls.length; i += 1) {
      if (calls[i].time <= child.createdAt) best = i
      else break
    }
    if (best >= 0) callTokens[best] += child.tokens
  }

  // Completed debate pairs: pair each aegis call with the next ward call.
  let thin = 0
  let wardIndex = 0
  for (let i = 0; i < calls.length; i += 1) {
    if (calls[i].name !== 'aegis') continue
    while (wardIndex < calls.length && calls[wardIndex].name !== 'ward') wardIndex += 1
    if (wardIndex >= calls.length) break
    const combined = callTokens[i] + callTokens[wardIndex]
    if (combined < THIN_DEBATES_FLOOR) thin += 1
    wardIndex += 1
  }
  return thin
}
