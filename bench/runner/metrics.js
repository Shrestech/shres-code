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
 * @module bench/runner/metrics
 */

/**
 * @typedef {import('../schema/trial.js').TrialMetrics} TrialMetrics
 */

/** Tool names with attempt and result metrics. */
const CHECKPOINT_TOOL = 'jspace_checkpoint'
const SHIP_TOOL = 'jspace_ship'

/** Stock Goal written by a placeholder auto-open or bare `/j-space on`. */
const PLACEHOLDER_GOAL = 'J-Space is on'

/** Stable text emitted by the diagnosed identical-retry guard. */
const RETRY_DENIAL =
  'jspace refuses repeating the same failed tool call while Core and Next are unchanged.'

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

/** Whether a value is a JSON record rather than an array. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the durable identity, outcome, and text of one `tool/result`.
 * @param {unknown} value - event data.
 * @returns {{ callId: string, isError: boolean, text: string } | null}
 */
function toolResult(value) {
  if (!isRecord(value) || !isRecord(value.message)) return null
  const message = value.message
  if (!isRecord(message.source) || typeof message.source.callId !== 'string') return null
  if (!Array.isArray(message.content)) return null
  const blocks = message.content.filter(block =>
    isRecord(block) && block.type === 'tool-result')
  if (blocks.length === 0) return null
  const texts = []
  for (const block of blocks) {
    if (!Array.isArray(block.content)) continue
    for (const item of block.content) {
      if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
        texts.push(item.text)
      }
    }
  }
  return {
    callId: message.source.callId,
    isError: value.error !== undefined || blocks.some(block => block.isError === true),
    text: texts.join('\n'),
  }
}

/**
 * Decode the fields needed for card-write metrics. Other card fields remain
 * owned by the J-Space product fold.
 * @param {unknown} value - `jspace/card` event data.
 * @returns {{ goal: string, core: string[], checked: unknown[] } | null}
 */
function cardSnapshot(value) {
  if (!isRecord(value) || typeof value.goal !== 'string') return null
  if (!Array.isArray(value.core) || value.core.some(item => typeof item !== 'string')) return null
  if (!Array.isArray(value.checked)) return null
  return { goal: value.goal, core: value.core, checked: value.checked }
}

/**
 * Compare two card Core snapshots without treating a repeated whole-card
 * event as another Core write.
 * @param {readonly string[]} left
 * @param {readonly string[]} right
 * @returns {boolean}
 */
function equalStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Fold a whole session log into trial metrics. Corrupt JSON lines throw with
 * their line number — a log the runner managed to locate should be complete,
 * and silent truncation would corrupt the comparison.
 * @param {string} text - raw JSONL file contents.
 * @returns {TrialMetrics} the folded metrics; `durationMs` spans first to last
 * timestamped record (0 on an empty log).
 */
export function foldSessionLog(text) {
  /** @type {TrialMetrics} */
  const metrics = {
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    turns: 0,
    toolCalls: 0,
    duplicateCallAttempts: 0,
    identicalRetries: 0,
    checkpointAttempts: 0,
    checkpointWrites: 0,
    checkpoints: 0,
    shipAttempts: 0,
    shipPasses: 0,
    retryDenials: 0,
    cardOpens: 0,
    meaningfulGoalWrites: 0,
    placeholderGoalLeftovers: 0,
    coreWrites: 0,
  }
  /** @type {Map<string, number>} */
  const callCounts = new Map()
  /** @type {Map<string, string>} */
  const callNames = new Map()
  /** @type {{ callId: string, isError: boolean, text: string }[]} */
  const results = []
  let cardOpen = false
  let currentGoal = ''
  /** @type {string[]} */
  let currentCore = []
  let checkedLength = 0
  let minTime = Number.POSITIVE_INFINITY
  let maxTime = 0

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
        if (name === CHECKPOINT_TOOL) metrics.checkpointAttempts += 1
        if (name === SHIP_TOOL) metrics.shipAttempts += 1
        if (typeof data.callId === 'string') callNames.set(data.callId, name)
        const key = toolCallKey(name, data.arguments)
        callCounts.set(key, (callCounts.get(key) ?? 0) + 1)
        break
      }
      case 'tool/result': {
        const result = toolResult(data)
        if (result !== null) results.push(result)
        break
      }
      case 'jspace/card': {
        const card = cardSnapshot(data)
        if (card === null) break
        const opening = !cardOpen
        if (opening) metrics.cardOpens += 1
        if ((opening || card.goal !== currentGoal) && card.goal !== PLACEHOLDER_GOAL) {
          metrics.meaningfulGoalWrites += 1
        }
        if ((opening && card.core.length > 0) || (!opening && !equalStrings(card.core, currentCore))) {
          metrics.coreWrites += 1
        }
        if (card.checked.length > checkedLength) {
          metrics.checkpointWrites += card.checked.length - checkedLength
        }
        cardOpen = true
        currentGoal = card.goal
        currentCore = [...card.core]
        checkedLength = card.checked.length
        break
      }
      case 'jspace/closed':
        cardOpen = false
        currentGoal = ''
        currentCore = []
        checkedLength = 0
        break
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
      default:
        break
    }
  }

  for (const count of callCounts.values()) {
    if (count > 1) metrics.duplicateCallAttempts += count - 1
  }
  metrics.identicalRetries = metrics.duplicateCallAttempts
  metrics.checkpoints = metrics.checkpointWrites

  const shipPassCallIds = new Set()
  const deniedCallIds = new Set()
  for (const result of results) {
    const name = callNames.get(result.callId)
    if (name === SHIP_TOOL && !result.isError) shipPassCallIds.add(result.callId)
    if (result.isError && result.text.includes(RETRY_DENIAL)) deniedCallIds.add(result.callId)
  }
  metrics.shipPasses = shipPassCallIds.size
  metrics.retryDenials = deniedCallIds.size
  metrics.placeholderGoalLeftovers = cardOpen && currentGoal === PLACEHOLDER_GOAL ? 1 : 0
  metrics.durationMs = minTime === Number.POSITIVE_INFINITY ? 0 : maxTime - minTime
  return metrics
}

/**
 * Zeroed metrics for trials whose session log never materialized.
 * @returns {TrialMetrics} all-zero metrics.
 */
export function emptyMetrics() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    turns: 0,
    toolCalls: 0,
    duplicateCallAttempts: 0,
    identicalRetries: 0,
    checkpointAttempts: 0,
    checkpointWrites: 0,
    checkpoints: 0,
    shipAttempts: 0,
    shipPasses: 0,
    retryDenials: 0,
    cardOpens: 0,
    meaningfulGoalWrites: 0,
    placeholderGoalLeftovers: 0,
    coreWrites: 0,
  }
}
