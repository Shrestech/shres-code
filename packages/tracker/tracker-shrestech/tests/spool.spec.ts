import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TrackerSpool, toMetricSpoolEntry, toSpoolEntry } from '@shres-code/shres-code-tracker-shrestech'
import type { LogRunSpec, TrackerRunId } from '@shres-code/shres-code-tracker'

const spec: LogRunSpec = {
  experiment: 'study',
  hypothesis: 'h',
  decisionRule: 'val_bpb < 1.0',
  dataVersion: 'v3',
  gitSha: 'abc123',
  metrics: [{ name: 'loss', value: 0.5 }],
  artifacts: ['modelstore://a'],
}

function runId(n: number): TrackerRunId {
  return `run-${n}` as TrackerRunId
}

/** Create a scratch directory and return a spool path inside it. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tracker-spool-'))
  return join(dir, 'spool.jsonl')
}

describe('TrackerSpool.enqueue/peek', () => {
  it('appends a JSONL entry and reads it back', async () => {
    const path = await scratch()
    const spool = new TrackerSpool(path)
    const entry = toSpoolEntry(runId(1), spec, 'spooled', '2026-08-24T00:00:00.000Z')
    await spool.enqueue(entry)

    await expect(spool.peek()).resolves.toEqual([entry])
    const text = await readFile(path, 'utf8')
    expect(text).toBe(`${JSON.stringify(entry)}\n`)
    await rm(path, { force: true })
  })

  it('peeks an empty spool as an empty list before any enqueue', async () => {
    const spool = new TrackerSpool(await scratch())
    await expect(spool.peek()).resolves.toEqual([])
  })
})

describe('TrackerSpool.replay', () => {
  it('replays drained entries in order', async () => {
    const spool = new TrackerSpool(await scratch())
    const a = toSpoolEntry(runId(1), spec, 'spooled', '2026-08-24T00:00:00.000Z')
    const b = toSpoolEntry(runId(2), { ...spec, experiment: 'other' }, 'unreachable', '2026-08-24T00:01:00.000Z')
    await spool.enqueue(a)
    await spool.enqueue(b)

    await expect(spool.replay()).resolves.toEqual([a, b])
    // Replay drained the file: a second replay returns nothing.
    await expect(spool.replay()).resolves.toEqual([])
  })

  it('deduplicates by run id keeping the most recent entry', async () => {
    const spool = new TrackerSpool(await scratch())
    const older = toSpoolEntry(runId(1), spec, 'spooled', '2026-08-24T00:00:00.000Z')
    const newer = toSpoolEntry(runId(1), spec, 'unreachable', '2026-08-24T00:01:00.000Z')
    await spool.enqueue(older)
    await spool.enqueue(newer)
    await expect(spool.replay()).resolves.toEqual([newer])
  })

  it('returns an empty list and leaves the spool empty on an empty file', async () => {
    const spool = new TrackerSpool(await scratch())
    await expect(spool.replay()).resolves.toEqual([])
  })
})

describe('TrackerSpool metric spool', () => {
  it('appends a metric entry and reads it back', async () => {
    const path = await scratch()
    const spool = new TrackerSpool(path)
    const entry = toMetricSpoolEntry(runId(1), [{ name: 'loss', value: 0.5 }], '2026-08-24T00:00:00.000Z')
    await spool.enqueueMetrics(entry)
    await expect(spool.peekMetrics()).resolves.toEqual([entry])
    await rm(path, { force: true })
  })

  it('replays drained metric appends deduplicated by run id', async () => {
    const spool = new TrackerSpool(await scratch())
    const older = toMetricSpoolEntry(runId(1), [{ name: 'loss', value: 0.5 }], '2026-08-24T00:00:00.000Z')
    const newer = toMetricSpoolEntry(runId(1), [{ name: 'loss', value: 0.9 }], '2026-08-24T00:01:00.000Z')
    await spool.enqueueMetrics(older)
    await spool.enqueueMetrics(newer)
    await expect(spool.replayMetrics()).resolves.toEqual([newer])
    // Replay drained the metric spool.
    await expect(spool.replayMetrics()).resolves.toEqual([])
  })
})

describe('TrackerSpool read errors', () => {
  it('rethrows a read error that is not an absent file', async () => {
    // A directory is not a readable file on macOS/Linux (EISDIR).
    const dir = await mkdtemp(join(tmpdir(), 'tracker-spool-dir-'))
    const spool = new TrackerSpool(dir)
    await expect(spool.peek()).rejects.toThrow()
    await rm(dir, { recursive: true, force: true })
  })
})
