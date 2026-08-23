/**
 * Live-HTTP transport for the shrestech-tracker provider: the wire payload
 * builders for `POST /api/runs` and `POST /api/sync`, the metric/run shape
 * validation that fails loud at the durable/wire boundary, and the two POST
 * helpers with their failure-taxonomy mapping. The bearer token is passed in
 * as a parameter and never appears in a logged payload or exception.
 *
 * @module @shres-code/shres-code-tracker-shrestech/transport
 */

import { TrackerError } from '@shres-code/shres-code-tracker'
import type {
  LogRunSpec,
  MetricPoint,
  TrackerFailureReason,
  TrackerRunId,
} from '@shres-code/shres-code-tracker'
import type { TrackerMetricSpoolEntry, TrackerSpoolEntry } from './spool.ts'

/** The subset of {@link TrackerFailureReason} the transport maps responses to. */
export type TransportFailure = Extract<TrackerFailureReason, 'auth' | 'unreachable'>

/** Minimal `Response` surface the transport needs, mockable in unit tests. */
export interface FetchResponseLike {
  readonly status: number
  readonly ok: boolean
  json(): Promise<unknown>
}

/** Fetch signature the transport posts through. */
export type FetchLike = (input: string, init: {
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string
}) => Promise<FetchResponseLike>

/** One run as carried on the wire: the resolved spec plus its run id. */
export interface RunWire {
  readonly runId: string
  readonly experiment: string
  readonly hypothesis: string
  readonly decisionRule: string
  readonly dataVersion: string
  readonly gitSha: string
  readonly metrics: readonly MetricPoint[]
  readonly artifacts: readonly string[]
}

/** One metric append as carried on the `/api/sync` wire. */
export interface MetricWire {
  readonly runId: string
  readonly metrics: readonly MetricPoint[]
}

/** The `POST /api/sync` request body: drained runs plus drained metric appends. */
export interface SyncPayload {
  readonly runs: readonly RunWire[]
  readonly metrics: readonly MetricWire[]
}

/** The `POST /api/sync` response body: the run ids the server accepted. */
export interface SyncResponse {
  readonly landedRunIds: readonly string[]
}

/** Outcome of a `POST /api/sync` attempt before run-level bookkeeping. */
export type SyncOutcome =
  | { readonly kind: 'ok'; readonly landedRunIds: readonly string[] }
  | { readonly kind: 'failure'; readonly reason: TransportFailure }

/** Error code for any tracker response the failure taxonomy does not name. */
const UNEXPECTED = 'TRACKER_UNEXPECTED_RESPONSE'
/** Error code for a malformed `/api/sync` response body. */
const SYNC_RESPONSE = 'TRACKER_SYNC_RESPONSE'
/** Error code for a malformed run or metric in a sync payload. */
const PAYLOAD_SHAPE = 'TRACKER_PAYLOAD_SHAPE'

/**
 * Build the `POST /api/runs` request body from a resolved spec.
 * @param runId - the run's allocated id (carried so the server deduplicates).
 * @param spec - the resolved run spec.
 * @returns the wire payload.
 */
export function buildRunPayload(runId: TrackerRunId, spec: LogRunSpec): RunWire {
  return { runId, ...spec }
}

/**
 * Build the `POST /api/sync` request body from drained spool entries. Every
 * run and metric append is validated at this durable→wire boundary; a
 * malformed entry fails loud with a {@link TrackerError} rather than posting a
 * corrupt batch.
 * @param runEntries - the drained, deduplicated run posts.
 * @param metricEntries - the drained, deduplicated metric appends.
 * @returns the validated sync payload.
 * @throws {@link TrackerError} naming the first malformed run or metric entry.
 */
export function buildSyncPayload(
  runEntries: readonly TrackerSpoolEntry[],
  metricEntries: readonly TrackerMetricSpoolEntry[],
): SyncPayload {
  const runs: RunWire[] = []
  for (const entry of runEntries) runs.push(toRunWire(entry))
  const metrics: MetricWire[] = []
  for (const entry of metricEntries) metrics.push(toMetricWire(entry))
  return { runs, metrics }
}

/**
 * Attempt a single run post. Maps a network failure or any 5xx to
 * `'unreachable'`, a 401/403 to `'auth'`, and any other unexpected status to a
 * thrown {@link TrackerError}.
 * @param fetchImpl - the fetch implementation to post through.
 * @param baseUrl - the tracker base URL.
 * @param token - the bearer token; never logged.
 * @param runId - the run's allocated id.
 * @param spec - the resolved run spec.
 * @returns `'landed'` on a 2xx, else the mapped failure reason.
 * @throws {@link TrackerError} on an unmapped (unexpected) status.
 */
export async function postRunRequest(
  fetchImpl: FetchLike,
  baseUrl: string,
  token: string,
  runId: TrackerRunId,
  spec: LogRunSpec,
): Promise<'landed' | TrackerFailureReason> {
  const result = await attemptFetch(fetchImpl, `${baseUrl}/api/runs`, token, JSON.stringify(buildRunPayload(runId, spec)))
  return result.kind === 'ok' ? 'landed' : result.reason
}

/**
 * Attempt the bulk sync drain. `POST`es the validated payload; on success
 * returns the accepted run ids, and on a network failure / 5xx / 401 / 403
 * returns the mapped failure reason so the caller re-enqueues the drained
 * entries.
 * @param fetchImpl - the fetch implementation to post through.
 * @param baseUrl - the tracker base URL.
 * @param token - the bearer token; never logged.
 * @param payload - the validated sync payload.
 * @returns the accepted run ids, or the failure reason.
 * @throws {@link TrackerError} on an unexpected status or a malformed response body.
 */
export async function postSyncRequest(
  fetchImpl: FetchLike,
  baseUrl: string,
  token: string,
  payload: SyncPayload,
): Promise<SyncOutcome> {
  const result = await attemptFetch(fetchImpl, `${baseUrl}/api/sync`, token, JSON.stringify(payload))
  if (result.kind === 'failure') return result
  const response = await parseSyncResponse(result.response)
  return { kind: 'ok', landedRunIds: response.landedRunIds }
}

/**
 * Run one POST and map the outcome to the transport failure taxonomy. A
 * redirect is followed by the default fetch policy; the only statuses named by
 * the taxonomy are 401/403 (`auth`) and 5xx (`unreachable`), so any other
 * non-2xx is an unexpected response and fails loud.
 * @param fetchImpl - the fetch implementation to post through.
 * @param url - the full endpoint URL.
 * @param token - the bearer token; never logged.
 * @param body - the serialized request body.
 * @returns the response on a 2xx, else the failure reason.
 */
async function attemptFetch(
  fetchImpl: FetchLike,
  url: string,
  token: string,
  body: string,
): Promise<{ kind: 'ok'; response: FetchResponseLike } | { kind: 'failure'; reason: TransportFailure }> {
  let response: FetchResponseLike
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body,
    })
  } catch {
    return { kind: 'failure', reason: 'unreachable' }
  }
  if (response.status === 401 || response.status === 403) return { kind: 'failure', reason: 'auth' }
  if (response.status >= 500) return { kind: 'failure', reason: 'unreachable' }
  if (response.ok) return { kind: 'ok', response }
  throw new TrackerError(
    `tracker-shrestech: unexpected tracker response status ${response.status}`,
    UNEXPECTED,
  )
}

/**
 * Read and validate a `/api/sync` response body.
 * @param response - the raw fetch response.
 * @returns the validated landed-run-id set.
 * @throws {@link TrackerError} when the body is not JSON or lacks a `landedRunIds` string array.
 */
async function parseSyncResponse(response: FetchResponseLike): Promise<SyncResponse> {
  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new TrackerError('tracker-shrestech: /api/sync returned a non-JSON response', SYNC_RESPONSE)
  }
  if (typeof data !== 'object' || data === null) {
    throw new TrackerError('tracker-shrestech: /api/sync response must be an object', SYNC_RESPONSE)
  }
  const landedRunIds = (data as { landedRunIds?: unknown }).landedRunIds
  if (!Array.isArray(landedRunIds) || !landedRunIds.every(id => typeof id === 'string')) {
    throw new TrackerError('tracker-shrestech: /api/sync response must carry a landedRunIds string array', SYNC_RESPONSE)
  }
  return { landedRunIds }
}

/**
 * Project and validate one spooled run post into a {@link RunWire}.
 * @param entry - a spooled run post read from the durable spool.
 * @returns the validated wire run.
 * @throws {@link TrackerError} when the entry is malformed.
 */
function toRunWire(entry: TrackerSpoolEntry): RunWire {
  assertRunWire(entry.runId)
  assertRunWire(entry.experiment)
  assertRunWire(entry.hypothesis)
  assertRunWire(entry.decisionRule)
  assertRunWire(entry.dataVersion)
  assertRunWire(entry.gitSha)
  validateMetricPoints(entry.metrics)
  return {
    runId: entry.runId,
    experiment: entry.experiment,
    hypothesis: entry.hypothesis,
    decisionRule: entry.decisionRule,
    dataVersion: entry.dataVersion,
    gitSha: entry.gitSha,
    metrics: entry.metrics,
    artifacts: entry.artifacts,
  }
}

/**
 * Project and validate one spooled metric append into a {@link MetricWire}.
 * @param entry - the spooled metric append read from the durable spool.
 * @returns the validated wire metric append.
 * @throws {@link TrackerError} when the append is malformed.
 */
function toMetricWire(entry: TrackerMetricSpoolEntry): MetricWire {
  assertRunWire(entry.runId)
  validateMetricPoints(entry.metrics)
  return { runId: entry.runId, metrics: entry.metrics }
}

/**
 * Assert a required string field is present and non-blank.
 * @param value - the field value read from the durable spool.
 * @throws {@link TrackerError} when it is blank or absent.
 */
function assertRunWire(value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TrackerError('tracker-shrestech: sync payload carries a blank run field', PAYLOAD_SHAPE)
  }
}

/**
 * Validate a metric-point list read from the durable spool.
 * @param points - the metric points to validate.
 * @throws {@link TrackerError} naming the first malformed point.
 */
function validateMetricPoints(points: readonly MetricPoint[]): void {
  for (const point of points) {
    if (typeof point !== 'object' || point === null) throw metricShapeError()
    if (!assertNonBlank(point.name) || typeof point.value !== 'number' || !Number.isFinite(point.value)) {
      throw metricShapeError()
    }
    if (point.step !== undefined && (typeof point.step !== 'number' || !Number.isFinite(point.step))) {
      throw metricShapeError()
    }
  }
}

/**
 * Assert a value is a non-blank string.
 * @param value - the value to inspect.
 * @returns whether the value is a non-blank string.
 */
function assertNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Build the shape-mismatch error for a malformed metric.
 * @returns a {@link TrackerError} naming the shape violation.
 */
function metricShapeError(): TrackerError {
  return new TrackerError('tracker-shrestech: sync payload carries a malformed metric point', PAYLOAD_SHAPE)
}
