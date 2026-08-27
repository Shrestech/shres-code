import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LandedRunsIndex } from '@shres-code/shres-code-tracker-shrestech'
import type { LandedRunRecord } from '@shres-code/shres-code-tracker-shrestech'
import type { TrackerRunId } from '@shres-code/shres-code-tracker'

/** A fully-specified landed run record. */
function record(id: string, landedAt: string): LandedRunRecord {
  return {
    runId: id as TrackerRunId,
    experiment: 'study',
    decisionRule: 'val_bpb < 1.0',
    dataVersion: 'v3',
    gitSha: 'abc123',
    landedAt,
  }
}

async function scratch(): Promise<{ dir: string; indexPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tracker-index-'))
  return { dir, indexPath: join(dir, 'landed.jsonl') }
}

describe('LandedRunsIndex.record/list', () => {
  it('appends a record and reads it back in file order', async () => {
    const { dir, indexPath } = await scratch()
    const index = new LandedRunsIndex(indexPath)
    await index.record(record('run-1', '2026-08-24T00:00:00.000Z'))
    await index.record(record('run-2', '2026-08-24T00:01:00.000Z'))
    await expect(index.list()).resolves.toEqual([
      record('run-1', '2026-08-24T00:00:00.000Z'),
      record('run-2', '2026-08-24T00:01:00.000Z'),
    ])
    await rm(dir, { recursive: true, force: true })
  })

  it('lists an absent index as an empty list', async () => {
    const index = new LandedRunsIndex(await scratch().then(s => s.indexPath))
    await expect(index.list()).resolves.toEqual([])
  })
})

describe('LandedRunsIndex.reset', () => {
  it('wipes the index so it can be re-derived', async () => {
    const { dir, indexPath } = await scratch()
    const index = new LandedRunsIndex(indexPath)
    await index.record(record('run-1', '2026-08-24T00:00:00.000Z'))
    await index.reset()
    await expect(index.list()).resolves.toEqual([])
    await rm(dir, { recursive: true, force: true })
  })
})

describe('LandedRunsIndex read errors', () => {
  it('rethrows a read error that is not an absent file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tracker-index-dir-'))
    const index = new LandedRunsIndex(dir)
    await expect(index.list()).rejects.toThrow()
    await rm(dir, { recursive: true, force: true })
  })
})
