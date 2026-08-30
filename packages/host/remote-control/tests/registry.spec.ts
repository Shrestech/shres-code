import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RemoteControlError } from '../src/errors.ts'
import { asRemoteId, asRemoteTarget, loadRegistry, removeEntry, upsertEntry } from '../src/registry.ts'

/** Build one valid entry for the alias test fixture. */
function entry(): ReturnType<typeof fixture> {
  return fixture()
}
function fixture() {
  return {
    id: asRemoteId('lab'),
    target: asRemoteTarget('ci@remote.example'),
    remotePort: 3080,
    version: 1,
    fingerprint: null,
    createdAt: '2026-08-29T00:00:00.000Z',
    lastConnectedAt: null,
  }
}

async function tempRegistry(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'shres-remote-')), 'remotes.json')
}

describe('registry', () => {
  it('round-trips an entry through upsert and load', async () => {
    const path = await tempRegistry()
    await upsertEntry(path, entry())
    const loaded = await loadRegistry(path)
    expect(loaded.get(asRemoteId('lab'))).toEqual(entry())
  })

  it('creates the registry directory on the first write into a fresh home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shres-remote-fresh-'))
    const path = join(root, 'remote', 'remotes.json')
    // An absent registry has nothing to remove and must not materialize state.
    expect(await removeEntry(path, asRemoteId('lab'))).toBe(false)
    await upsertEntry(path, entry())
    expect((await loadRegistry(path)).size).toBe(1)
  })

  it('serializes concurrent reads and writes through one lock file', async () => {
    const path = await tempRegistry()
    await Promise.all([
      upsertEntry(path, entry()),
      (async () => {
        const second = { ...entry(), id: asRemoteId('staging') }
        await upsertEntry(path, second)
      })(),
    ])
    const loaded = await loadRegistry(path)
    expect(loaded.size).toBe(2)
  })

  it('removes entries and reports absence', async () => {
    const path = await tempRegistry()
    await upsertEntry(path, entry())
    expect(await removeEntry(path, asRemoteId('lab'))).toBe(true)
    expect(await removeEntry(path, asRemoteId('lab'))).toBe(false)
    const loaded = await loadRegistry(path)
    expect(loaded.size).toBe(0)
  })

  it('corrupt file content fails loud with a registry-corrupt code', async () => {
    const path = await tempRegistry()
    await upsertEntry(path, entry())
    const raw = await readFile(path, 'utf8')
    const tampered = raw.replace('"version": 1', '"version": 2')
    await (async () => { const { writeFile } = await import('node:fs/promises'); await writeFile(path, tampered) })()
    await expect(loadRegistry(path)).rejects.toMatchObject({ code: 'registry-corrupt' })
  })

  it('a malformed entry fails loud instead of being skipped', async () => {
    const path = await tempRegistry()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, JSON.stringify({ version: 1, entries: [{ id: 'lab', target: 'bad target', remotePort: 1, version: 1, fingerprint: 5, createdAt: 'x', lastConnectedAt: null }] }))
    await expect(loadRegistry(path)).rejects.toMatchObject({ code: 'registry-corrupt' })
  })

  it('validates alias, target, and port shapes loudly', async () => {
    const path = await tempRegistry()
    await expect(upsertEntry(path, { ...entry(), id: 'Loud_Upper' as never })).rejects.toMatchObject({ code: 'invalid-alias' })
    expect(() => asRemoteTarget('no-user-host')).toThrow(RemoteControlError)
    await expect(upsertEntry(path, { ...entry(), remotePort: 70000 })).rejects.toMatchObject({ code: 'invalid-port' })
  })
})
