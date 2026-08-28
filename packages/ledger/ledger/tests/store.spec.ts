import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LedgerError, LedgerStore } from '@shres-code/shres-code-ledger'
import type { LedgerEntry, LedgerEntryId } from '@shres-code/shres-code-ledger'
import type { TrackerRunId } from '@shres-code/shres-code-tracker'

function runId(id: string): TrackerRunId {
  return id as TrackerRunId
}

function entry(id: string, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    entryId: id as LedgerEntryId,
    hypothesis: 'h',
    decision: 'accepted',
    evidence: { runIds: [runId('run-1')], artifactUris: [] },
    rationale: 'r',
    recordedAt: 1000,
    ...overrides,
  }
}

/** Create a scratch directory and return a store path inside it. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-store-'))
  return join(dir, 'ledger.jsonl')
}

describe('LedgerStore.append/query', () => {
  it('appends a JSONL entry and queries it back', async () => {
    const path = await scratch()
    const store = new LedgerStore(path)
    const e = entry('entry-1')
    await store.append(e)
    await expect(store.query({})).resolves.toEqual([e])
    await rm(path, { force: true })
  })

  it('queries an absent store as an empty list before any append', async () => {
    const store = new LedgerStore(await scratch())
    await expect(store.query({})).resolves.toEqual([])
  })
})

describe('LedgerStore reload', () => {
  it('round-trips entries through a fresh store instance over the same file', async () => {
    const path = await scratch()
    const first = new LedgerStore(path)
    await first.append(entry('entry-1'))
    await first.append(entry('entry-2', { decision: 'rejected' }))

    const second = new LedgerStore(path)
    await expect(second.query({})).resolves.toEqual([
      entry('entry-1'),
      entry('entry-2', { decision: 'rejected' }),
    ])
    await rm(path, { force: true })
  })
})

describe('LedgerStore.query filters', () => {
  it('filters by decision', async () => {
    const store = new LedgerStore(await scratch())
    await store.append(entry('entry-1'))
    await store.append(entry('entry-2', { decision: 'rejected' }))
    await expect(store.query({ decision: 'rejected' })).resolves.toEqual([
      entry('entry-2', { decision: 'rejected' }),
    ])
  })

  it('filters by hypothesis substring', async () => {
    const store = new LedgerStore(await scratch())
    await store.append(entry('entry-1', { hypothesis: 'alpha beta' }))
    await store.append(entry('entry-2', { hypothesis: 'gamma' }))
    await expect(store.query({ hypothesisSubstring: 'beta' })).resolves.toEqual([
      entry('entry-1', { hypothesis: 'alpha beta' }),
    ])
  })

  it('filters by since epoch milliseconds', async () => {
    const store = new LedgerStore(await scratch())
    await store.append(entry('entry-1', { recordedAt: 1000 }))
    await store.append(entry('entry-2', { recordedAt: 2000 }))
    await expect(store.query({ since: 1500 })).resolves.toEqual([
      entry('entry-2', { recordedAt: 2000 }),
    ])
  })

  it('combines filters', async () => {
    const store = new LedgerStore(await scratch())
    await store.append(entry('entry-1', { hypothesis: 'alpha', recordedAt: 1000 }))
    await store.append(entry('entry-2', { hypothesis: 'alpha', decision: 'rejected', recordedAt: 2000 }))
    await expect(store.query({ decision: 'accepted', hypothesisSubstring: 'alpha', since: 500 })).resolves.toEqual([
      entry('entry-1', { hypothesis: 'alpha', recordedAt: 1000 }),
    ])
  })
})

describe('LedgerStore.has', () => {
  it('reports whether an entry id is present in the loaded index', async () => {
    const store = new LedgerStore(await scratch())
    await store.append(entry('entry-1'))
    expect(store.has('entry-1' as LedgerEntryId)).toBe(true)
    expect(store.has('entry-unknown' as LedgerEntryId)).toBe(false)
  })
})

describe('LedgerStore corrupt lines', () => {
  it('fails loud with the line number on a corrupt store line', async () => {
    const path = await scratch()
    await writeFile(path, `${JSON.stringify(entry('entry-1'))}\nnot-json\n`, 'utf8')
    const store = new LedgerStore(path)
    await expect(store.query({})).rejects.toThrow(LedgerError)
    await expect(store.query({})).rejects.toThrow(/line 2 is corrupt/)
    await rm(path, { force: true })
  })
})

describe('LedgerStore read errors', () => {
  it('rethrows a read error that is not an absent file', async () => {
    // A directory is not a readable file on macOS/Linux (EISDIR).
    const dir = await mkdtemp(join(tmpdir(), 'ledger-store-dir-'))
    const store = new LedgerStore(dir)
    await expect(store.query({})).rejects.toThrow()
    await rm(dir, { recursive: true, force: true })
  })
})
