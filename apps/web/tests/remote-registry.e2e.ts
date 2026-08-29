// Web e2e scenario: the shipped composition serves the remote registry through
// the real `remoteControl/list` Remote method — Loader composition row, Typert
// descriptor, HTTP `/api` carrier. Zero model calls. The isolated harness home
// is seeded and mutated between calls to prove the per-call read contract
// (the `shres` CLI is the only writer; the gateway never caches).
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import {
  asRemoteId, asRemotePort, asRemoteTarget, removeEntry, REGISTRY_VERSION, upsertEntry,
} from '@shres-code/shres-code-host-remote-control'

interface RemoteEntryView {
  id: string
  target: string
  remotePort: number
  fingerprint: string | null
  lastConnectedAt: string | null
  createdAt: string
}

interface RemoteListBody {
  result?: { value?: { entries?: RemoteEntryView[] } }
}

function registryPath(scaffold: WebScaffold): string {
  return join(scaffold.harnessHome, 'remote', 'remotes.json')
}

/** One fixture alias written through the package's own writer API. */
function entry(alias: 'lab' | 'prod'): Parameters<typeof upsertEntry>[1] {
  return {
    id: asRemoteId(alias),
    target: asRemoteTarget('ci@remote.example'),
    remotePort: asRemotePort(3080),
    version: REGISTRY_VERSION,
    fingerprint: null,
    createdAt: new Date().toISOString(),
    lastConnectedAt: null,
  }
}

async function listRemotes(scaffold: WebScaffold): Promise<RemoteEntryView[]> {
  const response = await fetch(`${scaffold.baseUrl}/api/remoteControl/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args: {} }),
  })
  expect(response.ok).toBe(true)
  const body = await response.json() as RemoteListBody
  return body.result?.value?.entries ?? []
}

describe('web e2e: remoteControl registry namespace', () => {
  let scaffold: WebScaffold

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
  }, 120_000)

  afterAll(async () => {
    await scaffold?.close()
  })

  it('serves the registry per call through the real composition: empty, seeded, mutated, removed', async () => {
    onTestFailed(() => { void scaffold })

    // Fresh isolated home: no registry file yet, empty snapshot, never an error.
    expect(await listRemotes(scaffold)).toEqual([])

    await upsertEntry(registryPath(scaffold), entry('lab'))
    let entries = await listRemotes(scaffold)
    expect(entries).toEqual([
      { id: 'lab', target: 'ci@remote.example', remotePort: 3080, fingerprint: null, lastConnectedAt: null, createdAt: expect.any(String) },
    ])

    await upsertEntry(registryPath(scaffold), entry('prod'))
    entries = await listRemotes(scaffold)
    expect(entries.map(remoteEntry => remoteEntry.id)).toEqual(['lab', 'prod'])

    expect(await removeEntry(registryPath(scaffold), asRemoteId('lab'))).toBe(true)
    expect((await listRemotes(scaffold)).map(remoteEntry => remoteEntry.id)).toEqual(['prod'])
  })
})
