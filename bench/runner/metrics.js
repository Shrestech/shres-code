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
 *
 * @module bench/runner/metrics
 */

/**
 * @typedef {import('../schema/trial.js').TrialMetrics} TrialMetrics
 */

/** Tool names whose calls count as accepted J-Space checkpoint/ship usage. */
const CHECKPOINT_TOOL = 'jspace_checkpoint'
const SHIP_TOOL = 'jspace_ship'

/** Session-query tool names. */
const SESSION_QUERY_TOOLS = new Set([
  'session_search',
  'session_event_search',
  'session_event_read',
  'session_event_trace',
  'session_trace',
])

/** Refusal indicators in tool/result data for coverage and note diagnostics. */
const NOOP_NOTE_MARKER = 'JSPACE_NOTE_NOOP'
const NOTE_CAP_MARKER = 'note cap'

/**
 * Stable string form for retry comparison: object keys sort recursively so
 * semantically identical arguments compare equal regardless of key order.
 * @param {unknown} value - a parsed JSON value.
 * @returns {string} canonical JSON text.
 */
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
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
    tokensIncludingDescendants: null,
    costIncludingDescendants: null,
    danglingCard: hasJspace ? false : null,
    verifiedCheckpointShare: null,
    coverageRefusalThenPad: 0,
    noopNoteRefusals: 0,
    noteCapRefusals: 0,
    sessionQueryCalls: hasSq ? 0 : null,
    compactionCount: 0,
    pressureFired: false,
  }
  /** @type {Map<string, number>} */
  const callCounts = new Map()
  let minTime = Number.POSITIVE_INFINITY
  let maxTime = 0

  let totalCheckpoints = 0
  let verifiedCheckpoints = 0
  let lastCheckpointWasRefusal = false
  let lastCheckpointTurn = -1
  let cardOpen = false

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
        if (name === CHECKPOINT_TOOL) metrics.checkpoints += 1
        if (name === SHIP_TOOL) metrics.shipPasses += 1
        if (hasSq && SESSION_QUERY_TOOLS.has(name)) {
          metrics.sessionQueryCalls = (metrics.sessionQueryCalls ?? 0) + 1
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
        const resultName = typeof data.name === 'string' ? data.name : ''
        const resultText = typeof data.result === 'string' ? data.result : ''
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
        break
      }
      case 'assistant/message': {
        const usage = /** @type {Record<string, unknown>} */ (data.usage ?? {})
        if (typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens)) {
          metrics.inputTokens += usage.inputTokens
        }
        if (typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)) {
          metrics.outputTokens += usage.outputTokens
        }
        break
      }
      case 'jspace/card':
        cardOpen = true
        break
      case 'jspace/closed':
        cardOpen = false
        break
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
  if (totalCheckpoints > 0) {
    metrics.verifiedCheckpointShare = verifiedCheckpoints / totalCheckpoints
  }
  metrics.pressureFired = metrics.compactionCount > 0

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
    tokensIncludingDescendants: null,
    costIncludingDescendants: null,
    danglingCard: null,
    verifiedCheckpointShare: null,
    coverageRefusalThenPad: 0,
    noopNoteRefusals: 0,
    noteCapRefusals: 0,
    sessionQueryCalls: null,
    compactionCount: 0,
    pressureFired: false,
  }
}
