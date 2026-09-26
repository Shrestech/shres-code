/**
 * Offline PR16 replay frontend: physical JSONL decode plus public
 * replayConsultInput. Inspect detects synthetic recovery only.
 * load/prepare are never called.
 * @module
 */
import { readFile } from 'node:fs/promises'
import { SessionId, decodeStorageRecord } from '../../packages/core/session/lib/index.js'
import { coldPointAt, replayConsultInput, resolveConfig } from '../../packages/llm/model-router/lib/index.js'
import { FRONTEND_METHOD_FIELDS, parseReplayMethod } from './replay-method.js'
import { labelColdPoints } from './label-cold-points.js'

/** Raised when a trial artifact cannot be used as untouched physical input. */
export class TrialInputIncompleteError extends Error {
  /**
   * @param {string} message - named refusal.
   * @param {{ trialId?: string, path?: string }} [detail]
   */
  constructor(message, detail = {}) {
    super(message)
    this.name = 'TrialInputIncompleteError'
    this.trialId = detail.trialId
    this.path = detail.path
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stripAdapterDefaults(config) {
  if (!isPlainObject(config)) return config
  const next = { ...config }
  delete next.adapterDefaults
  return next
}

function lastOpenTurn(events) {
  let open
  for (const event of events) {
    if (event.type === 'turn/start') open = event.data.turn
    if (event.type === 'turn/end' && event.data.turn === open) open = undefined
  }
  return open
}

function lastOpenStep(events) {
  let open
  for (const event of events) {
    if (event.type === 'step/start') open = { turn: event.data.turn, step: event.data.step }
    if (event.type === 'step/end' && open && event.data.turn === open.turn && event.data.step === open.step) {
      open = undefined
    }
  }
  return open
}

function physicallyRecovered(events) {
  return events.some((event) => {
    if (event.type === 'turn/end' && event.data?.reason?.kind === 'interrupted') return true
    const text = JSON.stringify(event.data ?? {})
    return event.type === 'tool/result' && /TOOL_NOT_STARTED|TOOL_OUTCOME_UNKNOWN/.test(text)
  })
}

/**
 * Decode one JSONL artifact from bytes. Packed chunk rows expand through the
 * public decoder. Seq must be contiguous from 0; the file must end in a newline.
 * @param {Buffer} bytes
 * @param {string} path
 * @returns {{ header: object, events: object[] }}
 */
export function decodePhysicalJsonl(bytes, path) {
  if (bytes.length === 0) throw new TrialInputIncompleteError('empty session artifact', { path })
  if (bytes[bytes.length - 1] !== 0x0a) {
    throw new TrialInputIncompleteError('session artifact does not end with a newline', { path })
  }
  const text = bytes.toString('utf8')
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) throw new TrialInputIncompleteError('empty session artifact', { path })
  let header
  try {
    header = JSON.parse(lines[0])
  } catch {
    throw new TrialInputIncompleteError('session header is not JSON', { path })
  }
  if (!isPlainObject(header) || header.type !== 'session') {
    throw new TrialInputIncompleteError('session header is not a session record', { path })
  }
  const events = []
  for (let index = 1; index < lines.length; index++) {
    let parsed
    try {
      parsed = JSON.parse(lines[index])
    } catch {
      throw new TrialInputIncompleteError('unparsable committed event at line ' + String(index + 1), { path })
    }
    let decoded
    try {
      decoded = decodeStorageRecord(parsed)
    } catch (error) {
      throw new TrialInputIncompleteError(
        'decodeStorageRecord refused line ' + String(index + 1) + ': ' + (error instanceof Error ? error.message : String(error)),
        { path },
      )
    }
    for (const event of decoded) events.push(event)
  }
  for (const [index, event] of events.entries()) {
    if (event.seq !== index) {
      throw new TrialInputIncompleteError(
        'seq is not contiguous from 0 (expected ' + String(index) + ', got ' + String(event.seq) + ')',
        { path },
      )
    }
  }
  return { header, events }
}

function verifierSkipped(trial) {
  const detail = trial?.verifier?.detail
  return typeof detail === 'string' && detail.startsWith('skipped:')
}

function taskPassedOf(trial) {
  if (verifierSkipped(trial)) return 'unknown'
  if (typeof trial.resolved !== 'boolean') throw new TypeError('trial.resolved must be boolean when the verifier ran')
  return trial.resolved
}

/**
 * Classify one physically decoded log. Inspect may only detect synthetic recovery.
 * @param {object} input
 */
export function classifyArtifact({ header, events, readFrom, inspected }) {
  if (header.seedLength !== undefined) {
    throw new TrialInputIncompleteError('seeded bench logs are refused')
  }
  if (physicallyRecovered(events)) {
    throw new TrialInputIncompleteError('physically present interrupted recovery is class C')
  }
  if (JSON.stringify(events) !== JSON.stringify(readFrom.events)) {
    throw new TrialInputIncompleteError('decoded physical events are not deep-equal to readFrom(id, 0).events')
  }
  if (inspected !== undefined && inspected.events.length > events.length) {
    const synthetic = inspected.events.slice(events.length)
    if (synthetic.some(event => event.type === 'turn/end' && event.data?.reason?.kind === 'interrupted')) {
      if (lastOpenTurn(events) === undefined && lastOpenStep(events) === undefined) {
        throw new TrialInputIncompleteError('inspect reported synthetic recovery on a physically complete log')
      }
      return { artifact: 'open-final-turn' }
    }
  }
  if (lastOpenTurn(events) !== undefined || lastOpenStep(events) !== undefined) {
    return { artifact: 'open-final-turn' }
  }
  return { artifact: 'complete' }
}

function requestConfigFor(arm, composed) {
  if (arm !== 'C') return composed.routeBase
  return stripAdapterDefaults(composed.requestConfig)
}

/**
 * Replay one trial log: physical decode, classify, consult, label.
 * @param {object} input
 */
export async function replayTrialLog({ trial, path, persistence, composed, method, arm, now = Date.now() }) {
  parseReplayMethod(method, { require: FRONTEND_METHOD_FIELDS })
  const bytes = await readFile(path)
  const { header, events } = decodePhysicalJsonl(bytes, path)
  const id = SessionId(header.id)
  const readFrom = await persistence.readFrom(id, 0)
  const inspected = await persistence.inspect(id)
  const { artifact } = classifyArtifact({ header, events, readFrom, inspected })
  const config = resolveConfig(composed.routerConfig)
  const ttl = composed.ttl
  const coldPoints = []
  const consults = []
  for (const start of events.filter(event => event.type === 'step/start')) {
    const at = { turn: start.data.turn, step: start.data.step, now, seedLength: header.seedLength }
    const result = await replayConsultInput(
      config,
      events,
      at,
      composed.routeBase,
      composed.trialOwnRoute,
      requestConfigFor(arm, composed),
      composed.resolveModelInfo,
    )
    consults.push({ turn: start.data.turn, step: start.data.step, result })
    if (result.kind === 'warm') continue
    const point = result.coldPoint ?? coldPointAt(
      events, composed.trialOwnRoute, ttl, now, header.seedLength !== undefined,
    )
    if (point === undefined || point === null) continue
    coldPoints.push({
      turn: start.data.turn,
      step: start.data.step,
      stepStartSeq: start.seq,
      kind: point.kind,
      ttlMs: ttl.ttlMs,
      ttlSource: ttl.ttlSource,
    })
  }
  const labelled = labelColdPoints({
    events,
    coldPoints,
    taskPassed: taskPassedOf(trial),
    arm,
    method,
  })
  const rows = labelled.rows.map(row => (
    artifact === 'open-final-turn' ? { ...row, artifact: 'open-final-turn' } : row
  ))
  return { artifact, events, header, rows, consults }
}
