/**
 * Profile lease and journal behavior against real temporary files: durable
 * journal round-trips with refused corruption, owner liveness for foreign and
 * own-process journals, lease reservation and reentrancy, restore matrices
 * over a fabricated runner, removal-recovery roll-forward, and staged-source
 * cleanup that only ever touches profile-owned snapshot paths.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** Test-only fault injection: report one path as a real directory to stage a swap after lstat. */
const faults = vi.hoisted(() => ({ lstatAsDirectory: undefined as string | undefined }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (faults.lstatAsDirectory !== undefined && String(args[0]) === faults.lstatAsDirectory) {
        return { isDirectory: () => true, isSymbolicLink: () => false }
      }
      return actual.lstat(...args)
    },
  }
})
import { clearJournal, clearStagedSource, PLUGIN_JOURNAL, ownerAlive, readJournal, recoverLocked, restoreInstall, withProfileLease, writeJournal, type PluginJournal } from '../src/profile-plugin-journal.ts'
import { ProfilePluginError } from '../src/profile-plugin-types.ts'
import type { PnpmRunner } from '../src/profile-pnpm.ts'

const dirs: string[] = []
const children: ReturnType<typeof spawn>[] = []

afterEach(() => {
  faults.lstatAsDirectory = undefined
  vi.restoreAllMocks()
  for (const child of children.splice(0)) child.kill('SIGKILL')
  while (dirs.length > 0) {
    const dir = dirs.pop()!
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shres-plugin-journal-'))
  dirs.push(dir)
  return dir
}

const ok = { exitCode: 0, stdout: '', stderr: '' }

function journalFixture(extra: Partial<PluginJournal> = {}): PluginJournal {
  return {
    version: 1, id: randomUUID(), op: 'install', pid: process.pid, startedAt: new Date().toISOString(),
    spec: 'demo', phase: 'mutating', manifestBytes: '{}\n', lockfileBytes: null, ...extra,
  }
}

const leaseOptions = (runner: Parameters<typeof restoreInstall>[2]['runner'], signal: AbortSignal = new AbortController().signal) => ({ runner, signal, invokingCwd: tmpdir() })

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
  await new Promise<void>(resolve => child.on('close', () => { resolve() }))
  return child.pid!
}

async function livePid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 2147483000)'], { stdio: 'ignore' })
  children.push(child)
  await new Promise<void>(resolve => setTimeout(resolve, 150))
  return child.pid!
}

describe('journal persistence', () => {
  it('round-trips a journal, reports absence, and clears it', async () => {
    const dir = scratch()
    expect(await readJournal(dir)).toBeNull()
    const journal = journalFixture()
    await writeJournal(dir, journal)
    expect(await readJournal(dir)).toEqual(journal)
    await clearJournal(dir)
    expect(await readJournal(dir)).toBeNull()
  })

  it('wraps corruption in a restore-failed error naming the journal path', async () => {
    const dir = scratch()
    writeFileSync(join(dir, PLUGIN_JOURNAL), '{not json')
    await expect(readJournal(dir)).rejects.toThrow(join(dir, PLUGIN_JOURNAL))
    writeFileSync(join(dir, PLUGIN_JOURNAL), JSON.stringify({ ...journalFixture(), version: 2 }))
    await expect(readJournal(dir)).rejects.toBeInstanceOf(ProfilePluginError)
  })

  it('rejects journals whose staged path is not profile-owned or disagrees with the id', async () => {
    const dir = scratch()
    const outside = scratch()
    const id = randomUUID()
    mkdirSync(join(outside, '.shres-plugin-sources', id), { recursive: true })
    await writeJournal(dir, journalFixture({ id, stagedPath: join(outside, '.shres-plugin-sources', id) }))
    await expect(readJournal(dir)).rejects.toThrow('Unowned staged path')
    const other = randomUUID()
    const sources = join(dir, '.shres-plugin-sources')
    mkdirSync(join(sources, other), { recursive: true })
    await writeJournal(dir, journalFixture({ id, stagedPath: join(sources, other) }))
    await expect(readJournal(dir)).rejects.toThrow('Staged path differs from transaction id')
  })
})

describe('ownerAlive', () => {
  it('reports own-pid journals by lease membership', async () => {
    const dir = scratch()
    const unleased = journalFixture({ pid: process.pid })
    expect(ownerAlive(unleased)).toBe(false)
    await withProfileLease(dir, new AbortController().signal, async (id) => {
      expect(ownerAlive(journalFixture({ pid: process.pid, id }))).toBe(true)
      return id
    })
  })

  it('probes foreign owners through the process table', async () => {
    expect(ownerAlive(journalFixture({ pid: await deadPid() }))).toBe(false)
    expect(ownerAlive(journalFixture({ pid: await livePid() }))).toBe(true)
  })

  it('rethrows a probe failure that is neither absence nor permission', () => {
    const failure = Object.assign(new Error('bad pid'), { code: 'EINVAL' })
    vi.spyOn(process, 'kill').mockImplementation(() => { throw failure })
    expect(() => ownerAlive(journalFixture({ pid: process.pid + 1 }))).toThrow(failure)
  })

  it.skipIf(process.getuid?.() === 0)('treats an unprobeable owner as alive', async () => {
    expect(ownerAlive(journalFixture({ pid: 1 }))).toBe(true)
  })
})

describe('withProfileLease', () => {
  it('creates the profile directory, passes a fresh owner id, and rethrows operation errors verbatim', async () => {
    const dir = join(scratch(), 'not-yet-created')
    const first = await withProfileLease(dir, new AbortController().signal, async leased => leased)
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    const second = await withProfileLease(dir, new AbortController().signal, async () => 'again')
    expect(second).toBe('again')
    await expect(withProfileLease(dir, new AbortController().signal, async () => {
      throw new Error('plain operation failure')
    })).rejects.toThrow('plain operation failure')
  })

  it('refuses a second concurrent lease in this process', async () => {
    const dir = scratch()
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = () => { resolve() } })
    const entered = Promise.withResolvers<undefined>()
    const inner = withProfileLease(dir, new AbortController().signal, async () => {
      entered.resolve(undefined)
      await released
      return 'held'
    })
    // The reservation happens after the lease's own awaits; attempt the second
    // lease only once the first one holds it, so the outcome is not a race.
    await entered.promise
    await expect(withProfileLease(dir, new AbortController().signal, async () => 'other'))
      .rejects.toMatchObject({ code: 'transaction-pending', pid: process.pid })
    release()
    await expect(inner).resolves.toBe('held')
  })

  it('reaps a stale reservation left by this pid instead of timing out', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'package.json.lock'), String(process.pid) + '\n')
    const started = Date.now()
    await withProfileLease(dir, new AbortController().signal, async () => 'ok')
    expect(Date.now() - started).toBeLessThan(1500)
  })
})

describe('restoreInstall', () => {
  const manifest = '{"name":"profile-fixture"}\n'
  const lockBytes = 'lockfileVersion: \'9.0\'\n'

  it('restores exact metadata, reruns the dependency install offline, and reports success', async () => {
    const dir = scratch()
    const runnerArgs: string[][] = []
    const runner: PnpmRunner = async (args) => {
      runnerArgs.push([...args])
      return ok
    }
    const report = await restoreInstall(dir, journalFixture({ manifestBytes: manifest, lockfileBytes: null }), leaseOptions(runner))
    expect(report).toEqual({ filesRestored: true, reinstall: 'ok' })
    expect(runnerArgs[0]).toEqual(['install', '--offline', '--ignore-scripts', '--ignore-pnpmfile'])
    expect(await readJournal(dir)).toBeNull()
  })

  it('reports the dependency failure through stderr or stdout without losing restored bytes', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'pnpm-lock.yaml'), lockBytes)
    expect(await restoreInstall(dir, journalFixture({ manifestBytes: manifest, lockfileBytes: lockBytes }),
      leaseOptions(async () => ({ exitCode: 1, stdout: 'fallback-out', stderr: 'boom' }))))
      .toEqual({ filesRestored: true, reinstall: 'failed', detail: 'boom' })
    expect(await restoreInstall(dir, journalFixture({ manifestBytes: manifest, lockfileBytes: lockBytes }),
      leaseOptions(async () => ({ exitCode: 1, stdout: 'fallback-out', stderr: '' }))))
      .toEqual({ filesRestored: true, reinstall: 'failed', detail: 'fallback-out' })
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe(lockBytes)
  })

  it('reports a rejecting runner as a failed reinstall while the signal stays live', async () => {
    const dir = scratch()
    const report = await restoreInstall(dir, journalFixture({ manifestBytes: manifest, lockfileBytes: null }),
      leaseOptions(async () => { throw new Error('runner exploded') }))
    expect(report).toEqual({ filesRestored: true, reinstall: 'failed', detail: 'Error: runner exploded' })
  })

  it('lets an aborted signal surface instead of masking it as a failed reinstall', async () => {
    const dir = scratch()
    const controller = new AbortController()
    controller.abort()
    await expect(restoreInstall(dir, journalFixture({ manifestBytes: manifest, lockfileBytes: null }),
      leaseOptions(async () => { throw new Error('aborted at pnpm') }, controller.signal))).rejects.toThrow(/abort/)
  })

  it('refuses to leave half-restored metadata when a write fails', async () => {
    const dir = scratch()
    mkdirSync(join(dir, 'package.json'))
    await expect(restoreInstall(dir, journalFixture({ manifestBytes: manifest, lockfileBytes: null }), leaseOptions(async () => ok)))
      .rejects.toMatchObject({ code: 'restore-failed' })
  })

  it('fails the finalize pass when the runner corrupts the manifest into a directory', async () => {
    const dir = scratch()
    await expect(restoreInstall(dir, journalFixture({ manifestBytes: manifest, lockfileBytes: null }), leaseOptions(async () => {
      rmSync(join(dir, 'package.json'))
      mkdirSync(join(dir, 'package.json'))
      return ok
    }))).rejects.toThrow('Could not finalize metadata restoration')
  })

  it('keeps the journal when post-restore cleanup fails', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'pnpm-lock.yaml'), lockBytes)
    mkdirSync(join(dir, PLUGIN_JOURNAL))
    await expect(restoreInstall(dir, journalFixture({ manifestBytes: manifest, lockfileBytes: lockBytes }), leaseOptions(async () => ok)))
      .rejects.toThrow('Metadata restored, but cleanup failed')
  })
})

describe('recoverLocked', () => {
  it('rolls a removal forward: restores the deactivated manifest, cleans up, and clears the journal', async () => {
    const dir = scratch()
    const committed = '{"name":"profile-fixture","shres":{"profile":{"bundles":[]}}}\n'
    const sources = join(dir, '.shres-plugin-sources')
    const id = randomUUID()
    mkdirSync(join(sources, id), { recursive: true })
    writeFileSync(join(sources, id, 'staged.txt'), 'staged')
    writeFileSync(join(dir, PLUGIN_JOURNAL), JSON.stringify(journalFixture({
      id, op: 'remove', phase: 'committing', committedManifestBytes: committed,
      stagedPath: join(sources, id), pid: await deadPid(),
    })) + '\n')
    const removeArgs: string[][] = []
    const outcome = await recoverLocked(dir, leaseOptions(async (args) => {
      removeArgs.push([...args])
      return ok
    }))
    expect(outcome).toEqual({ kind: 'recovered', op: 'remove' })
    expect(removeArgs[0]).toEqual(['remove', '--config.ignore-scripts=true', '--config.ignore-pnpmfile=true', '--', 'demo'])
    expect(await readJournal(dir)).toBeNull()
    const { stat } = await import('node:fs/promises')
    await expect(stat(join(sources, id, 'staged.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a removal journal that lacks its deactivated manifest', async () => {
    const dir = scratch()
    await writeJournal(dir, journalFixture({ op: 'remove', phase: 'committing', pid: await deadPid() }))
    await expect(recoverLocked(dir, leaseOptions(async () => ok))).rejects.toThrow('Removal journal lacks its deactivated manifest')
  })

  it('keeps the staged snapshot when removal cleanup fails and reports the failure', async () => {
    const dir = scratch()
    await writeJournal(dir, journalFixture({ op: 'remove', phase: 'committing', committedManifestBytes: '{"name":"x"}\n', pid: await deadPid() }))
    expect(await recoverLocked(dir, leaseOptions(async () => ({ exitCode: 1, stdout: '', stderr: 'cleanup failed' }))))
      .toEqual({ kind: 'recovered', op: 'remove' })
  })

  it('reports a removal recovery whose runner rejected', async () => {
    const dir = scratch()
    await writeJournal(dir, journalFixture({ op: 'remove', phase: 'committing', committedManifestBytes: '{}\n', pid: await deadPid() }))
    await expect(recoverLocked(dir, leaseOptions(async () => { throw new Error('remove exploded') })))
      .rejects.toThrow('Removal recovery failed')
  })

  it('clears a fully committed install journal but rolls back a mismatched one', async () => {
    const dir = scratch()
    const committed = '{"shres":{"profile":{"bundles":["demo"]}}}\n'
    await writeJournal(dir, journalFixture({ phase: 'committing', committedManifestBytes: committed }))
    writeFileSync(join(dir, 'package.json'), committed)
    expect(await recoverLocked(dir, leaseOptions(async () => ok))).toEqual({ kind: 'recovered', op: 'install' })
    expect(await readJournal(dir)).toBeNull()

    await writeJournal(dir, journalFixture({ phase: 'committing', committedManifestBytes: '{"drifted":true}\n' }))
    writeFileSync(join(dir, 'package.json'), '{"touched":true}\n')
    const recovered = await recoverLocked(dir, leaseOptions(async () => ok))
    expect(recovered).toMatchObject({ kind: 'recovered', op: 'install', rollback: { filesRestored: true } })
    expect(await readJournal(dir)).toBeNull()
  })
})

describe('clearStagedSource', () => {
  it('removes a profile-owned snapshot recursively', async () => {
    const dir = scratch()
    const id = randomUUID()
    const staged = join(dir, '.shres-plugin-sources', id)
    mkdirSync(staged, { recursive: true })
    writeFileSync(join(staged, 'deep.txt'), 'x')
    await clearStagedSource(dir, staged)
    const { stat } = await import('node:fs/promises')
    await expect(stat(staged)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('treats a vanished sources directory as already cleaned', async () => {
    const dir = scratch()
    await clearStagedSource(dir, join(dir, '.shres-plugin-sources', randomUUID()))
  })

  it('refuses a sources directory swapped for an outside link after its lstat, deleting nothing', async () => {
    const dir = scratch()
    const outside = scratch()
    const id = randomUUID()
    mkdirSync(join(outside, id))
    writeFileSync(join(outside, id, 'keep.txt'), 'keep')
    const sources = join(dir, '.shres-plugin-sources')
    symlinkSync(outside, sources)
    faults.lstatAsDirectory = sources
    await expect(clearStagedSource(dir, join(sources, id))).rejects.toThrow('resolves outside its profile')
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(join(outside, id, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('refuses a sources path that is a file or a symlink', async () => {
    const dir = scratch()
    const asFile = join(dir, '.shres-plugin-sources')
    writeFileSync(asFile, 'not a directory')
    await expect(clearStagedSource(dir, join(asFile, randomUUID()))).rejects.toThrow('not a real directory')
    rmSync(asFile)
    symlinkSync(scratch(), asFile, 'dir')
    await expect(clearStagedSource(dir, join(asFile, randomUUID()))).rejects.toThrow('not a real directory')
  })

  it.skipIf(process.getuid?.() === 0)('surfaces permission failures from the sources lookup', async () => {
    const dir = scratch()
    const staged = join(dir, '.shres-plugin-sources', randomUUID())
    chmodSync(dir, 0o644)
    await expect(clearStagedSource(dir, staged)).rejects.toMatchObject({ code: 'EACCES' })
  })
})
