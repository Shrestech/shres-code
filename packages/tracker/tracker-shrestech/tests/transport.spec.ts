import { describe, expect, it, vi } from 'vitest'
import {
  buildRunPayload,
  buildSyncPayload,
  postRunRequest,
  postSyncRequest,
} from '@shres-code/shres-code-tracker-shrestech'
import { toMetricSpoolEntry, toSpoolEntry } from '@shres-code/shres-code-tracker-shrestech'
import type { FetchResponseLike, SyncPayload } from '@shres-code/shres-code-tracker-shrestech'
import type { LogRunSpec, TrackerRunId } from '@shres-code/shres-code-tracker'

const BASE = 'https://tracker.example.com'
const TOKEN = 'sekret'
const runId = 'run-1' as TrackerRunId

const spec: LogRunSpec = {
  experiment: 'study',
  hypothesis: 'h',
  decisionRule: 'val_bpb < 1.0',
  dataVersion: 'v3',
  gitSha: 'abc123',
  metrics: [{ name: 'loss', value: 0.5 }],
  artifacts: ['modelstore://a'],
}

/** A fake response surface satisfying {@link FetchResponseLike}. */
function response(status: number, body?: unknown): FetchResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: vi.fn(async () => body ?? {}),
  }
}

/** A fake fetch returning one scripted response or rejecting. */
function fetchReturning(r: FetchResponseLike | Error): (typeof globalThis)['fetch'] {
  return vi.fn(async () => {
    if (r instanceof Error) throw r
    return r
  }) as unknown as (typeof globalThis)['fetch']
}

const validSync: SyncPayload = {
  runs: [{ runId, ...spec }],
  metrics: [{ runId, metrics: [{ name: 'loss', value: 0.5 }] }],
}

describe('buildRunPayload', () => {
  it('carries the run id alongside the resolved spec', () => {
    expect(buildRunPayload(runId, spec)).toEqual({ runId, ...spec })
  })
})

describe('buildSyncPayload', () => {
  it('projects validated run and metric entries onto the wire', () => {
    const runEntry = toSpoolEntry(runId, spec, 'spooled', '2026-08-24T00:00:00.000Z')
    const metricEntry = toMetricSpoolEntry(runId, spec.metrics, '2026-08-24T00:00:00.000Z')
    expect(buildSyncPayload([runEntry], [metricEntry])).toEqual(validSync)
  })

  it('fails loud on a blank run field from the spool', () => {
    const bad = { ...toSpoolEntry(runId, spec, 'spooled'), experiment: '' }
    expect(() => buildSyncPayload([bad], [])).toThrow(/blank run field/)
  })

  it('fails loud on a metric point that is not an object', () => {
    const bad = { ...toSpoolEntry(runId, spec, 'spooled'), metrics: ['nope'] as unknown as LogRunSpec['metrics'] }
    expect(() => buildSyncPayload([bad], [])).toThrow(/malformed metric point/)
  })

  it('fails loud on a malformed metric name', () => {
    const bad = { ...toSpoolEntry(runId, spec, 'spooled'), metrics: [{ name: ' ', value: 1 }] }
    expect(() => buildSyncPayload([bad], [])).toThrow(/malformed metric point/)
  })

  it('fails loud on a non-finite metric value', () => {
    const bad = { ...toSpoolEntry(runId, spec, 'spooled'), metrics: [{ name: 'loss', value: Number.NaN }] }
    expect(() => buildSyncPayload([bad], [])).toThrow(/malformed metric point/)
  })

  it('fails loud on a non-finite metric step', () => {
    const bad = { ...toMetricSpoolEntry(runId, [{ name: 'loss', value: 1, step: Number.POSITIVE_INFINITY }]) }
    expect(() => buildSyncPayload([], [bad])).toThrow(/malformed metric point/)
  })

  it('fails loud on a metric entry whose run id is blank', () => {
    const bad = { ...toMetricSpoolEntry(runId, [{ name: 'loss', value: 1 }]), runId: ' ' as TrackerRunId }
    expect(() => buildSyncPayload([], [bad])).toThrow(/blank run field/)
  })
})

describe('postRunRequest', () => {
  it('returns landed on a 2xx', async () => {
    const fetch = fetchReturning(response(200))
    await expect(postRunRequest(fetch, BASE, TOKEN, runId, spec)).resolves.toBe('landed')
  })

  it('returns auth on a 401 and 403', async () => {
    await expect(postRunRequest(fetchReturning(response(401)), BASE, TOKEN, runId, spec)).resolves.toBe('auth')
    await expect(postRunRequest(fetchReturning(response(403)), BASE, TOKEN, runId, spec)).resolves.toBe('auth')
  })

  it('returns unreachable on a 5xx', async () => {
    await expect(postRunRequest(fetchReturning(response(503)), BASE, TOKEN, runId, spec)).resolves.toBe('unreachable')
  })

  it('returns unreachable on a network failure', async () => {
    await expect(postRunRequest(fetchReturning(new TypeError('down')), BASE, TOKEN, runId, spec))
      .resolves.toBe('unreachable')
  })

  it('fails loud on an unexpected status', async () => {
    await expect(postRunRequest(fetchReturning(response(404)), BASE, TOKEN, runId, spec))
      .rejects.toThrow(/unexpected tracker response status 404/)
  })
})

describe('postSyncRequest', () => {
  it('returns the accepted run ids on a 2xx', async () => {
    const fetch = fetchReturning(response(200, { landedRunIds: ['run-1', 'run-2'] }))
    await expect(postSyncRequest(fetch, BASE, TOKEN, validSync))
      .resolves.toEqual({ kind: 'ok', landedRunIds: ['run-1', 'run-2'] })
  })

  it('returns auth on a 401', async () => {
    await expect(postSyncRequest(fetchReturning(response(401)), BASE, TOKEN, validSync))
      .resolves.toEqual({ kind: 'failure', reason: 'auth' })
  })

  it('returns unreachable on a 5xx', async () => {
    await expect(postSyncRequest(fetchReturning(response(502)), BASE, TOKEN, validSync))
      .resolves.toEqual({ kind: 'failure', reason: 'unreachable' })
  })

  it('returns unreachable on a network failure', async () => {
    await expect(postSyncRequest(fetchReturning(new Error('down')), BASE, TOKEN, validSync))
      .resolves.toEqual({ kind: 'failure', reason: 'unreachable' })
  })

  it('fails loud on a non-JSON response body', async () => {
    const bad = { status: 200, ok: true, json: vi.fn(async () => { throw new SyntaxError('bad json') }) }
    await expect(postSyncRequest(fetchReturning(bad), BASE, TOKEN, validSync)).rejects.toThrow(/non-JSON response/)
  })

  it('fails loud when the response body is not an object', async () => {
    await expect(postSyncRequest(fetchReturning(response(200, 'nope')), BASE, TOKEN, validSync))
      .rejects.toThrow(/must be an object/)
  })

  it('fails loud when landedRunIds is missing or malformed', async () => {
    await expect(postSyncRequest(fetchReturning(response(200, {})), BASE, TOKEN, validSync))
      .rejects.toThrow(/landedRunIds/)
    await expect(postSyncRequest(fetchReturning(response(200, { landedRunIds: [1] })), BASE, TOKEN, validSync))
      .rejects.toThrow(/landedRunIds/)
  })

  it('fails loud on an unexpected status', async () => {
    await expect(postSyncRequest(fetchReturning(response(400)), BASE, TOKEN, validSync))
      .rejects.toThrow(/unexpected tracker response status 400/)
  })
})
