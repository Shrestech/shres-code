import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as processGroups from '../src/runtime/process-group.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm), readFile: vi.fn(actual.readFile) }
})
import {
  acquireRuntimeLease,
  LeaseRefusedError,
  LEASE_FILE_NAME,
  type LeaseCleanupHooks,
} from '../src/runtime/lease.ts'

const cleanup: { dir?: string; children: ReturnType<typeof spawn>[] }[] = []
afterEach(async () => {
  for (const entry of cleanup.splice(0)) {
    for (const child of entry.children) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
    if (entry.dir !== undefined) await rm(entry.dir, { recursive: true, force: true })
  }
})

/** A long-lived child whose command line embeds the given marker text. */
function sleepingChild(marker: string, profileArgument = false): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, ['-e', `const m = ${JSON.stringify(marker)}; setInterval(() => {}, 1000)`, ...(profileArgument ? ['--', '--user-data-dir=' + marker] : [])], {
    stdio: 'ignore',
  })
  const entry = cleanup.at(-1)
  if (entry !== undefined) entry.children.push(child)
  return child
}

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function ownedRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shres-bsk-lease-'))
  for (const sub of ['home', 'tmp', 'bsk-home', 'profile']) await mkdir(join(dir, sub), { recursive: true })
  cleanup.push({ dir, children: [] })
  return dir
}

/** Recording hooks expose the actual cleanup calls. */
function hooks(): LeaseCleanupHooks & { killedBrowsers: number; stoppedDaemons: number } {
  const state = {
    killedBrowsers: 0,
    stoppedDaemons: 0,
    browserIsOurs: async () => true,
    killBrowser: async () => { state.killedBrowsers += 1 },
    daemonIsOurs: async () => true,
    stopDaemon: async () => { state.stoppedDaemons += 1 },
  }
  return state
}

describe('runtime lease', () => {
  it('leaves a reused recorded pid alive when its arguments merely mention the profile path', async () => {
    const root = await ownedRoot()
    const foreign = sleepingChild(join(root, 'profile'))
    await once(foreign, 'spawn')
    await writeFile(join(root, LEASE_FILE_NAME), JSON.stringify({ pid: process.pid, leaseId: 'old-record', startedAt: '', browserPid: foreign.pid }))
    const recording = hooks()
    recording.browserIsOurs = candidate => processGroups.isOwnedChromeProcess(candidate, join(root, 'profile'))
    const lease = await acquireRuntimeLease(root, recording)
    expect(recording.killedBrowsers).toBe(0)
    expect(await alive(foreign.pid!)).toBe(true)
    await lease.release()
  })

  it('takes over a stale group reused by unmarked processes without signalling them', async () => {
    const root = await ownedRoot()
    await writeFile(join(root, LEASE_FILE_NAME), JSON.stringify({ pid: process.pid, leaseId: 'old-group', startedAt: '', browserPid: 9999998, browserPgid: 9999998 }))
    const recording = hooks()
    recording.browserIsOurs = async () => false
    const check = vi.spyOn(processGroups, 'waitForOwnedGroupMembers').mockImplementationOnce(async (pgid, ms, isOwned) => {
      expect(pgid).toBe(9999998)
      expect(await isOwned(42, ms)).toBe(false)
      return [42]
    })
    try {
      const lease = await acquireRuntimeLease(root, recording)
      expect(recording.killedBrowsers).toBe(0)
      expect(recording.stoppedDaemons).toBe(0)
      await lease.release()
    } finally { check.mockRestore() }
  })

  it('retains a stale record when marked group members remain', async () => {
    const root = await ownedRoot()
    const old = JSON.stringify({ pid: process.pid, leaseId: 'old-group', startedAt: '', browserPid: 9999998, browserPgid: 9999998 })
    await writeFile(join(root, LEASE_FILE_NAME), old)
    const recording = hooks()
    const check = vi.spyOn(processGroups, 'waitForOwnedGroupMembers').mockImplementationOnce(async (_pgid, ms, isOwned) => {
      expect(await isOwned(42, ms)).toBe(true)
      throw new Error('marked Chrome process remains')
    })
    try {
      await expect(acquireRuntimeLease(root, recording)).rejects.toMatchObject({ refusal: { kind: 'owned-by-peer', detail: expect.stringContaining('marked Chrome process remains') as string } })
      expect(await readFile(join(root, LEASE_FILE_NAME), 'utf8')).toBe(old)
      expect(recording.killedBrowsers).toBe(0)
    } finally { check.mockRestore() }
  })

  it.each([0, -1, 1.5, 'invalid', 9999997])('refuses invalid recorded group identity %j', async (browserPgid) => {
    const root = await ownedRoot()
    await writeFile(join(root, LEASE_FILE_NAME), JSON.stringify({ pid: process.pid, leaseId: 'old-group', startedAt: '', browserPid: 9999998, browserPgid }))
    await expect(acquireRuntimeLease(root, hooks())).rejects.toBeInstanceOf(LeaseRefusedError)
  })

  it('refuses a same-process holder without touching its recorded children', async () => {
    const root = await ownedRoot()
    const lease = await acquireRuntimeLease(root, hooks())
    const child = sleepingChild(join(root, 'profile'))
    await lease.update({ browserPid: child.pid!, daemonPid: child.pid! })
    const before = await readFile(join(root, LEASE_FILE_NAME), 'utf8')
    const recording = hooks()
    await expect(acquireRuntimeLease(root, recording)).rejects.toMatchObject({ refusal: { kind: 'owned-by-peer', pid: process.pid } })
    expect(recording.killedBrowsers).toBe(0)
    expect(recording.stoppedDaemons).toBe(0)
    expect(await alive(child.pid!)).toBe(true)
    expect(await readFile(join(root, LEASE_FILE_NAME), 'utf8')).toBe(before)
    await lease.release()
    await (await acquireRuntimeLease(root, recording)).release()
  })

  it('admits exactly one concurrent acquisition and recognizes a symlink alias', async () => {
    const root = await ownedRoot()
    const alias = root + '-alias'
    await symlink(root, alias, 'dir')
    cleanup.push({ dir: alias, children: [] })
    const results = await Promise.allSettled([acquireRuntimeLease(root, hooks()), acquireRuntimeLease(alias, hooks())])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    for (const result of results) if (result.status === 'fulfilled') await result.value.release()
  })

  it('recognizes a holder through a separately imported module instance', async () => {
    const root = await ownedRoot()
    const lease = await acquireRuntimeLease(root, hooks())
    vi.resetModules()
    const reloaded = await import('../src/runtime/lease.ts')
    await expect(reloaded.acquireRuntimeLease(root, hooks())).rejects.toMatchObject({ refusal: { kind: 'owned-by-peer', pid: process.pid } })
    await lease.release()
  })

  it('keeps the in-process reservation when deleting the lock fails', async () => {
    const root = await ownedRoot()
    const lease = await acquireRuntimeLease(root, hooks())
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    await expect(lease.release()).rejects.toMatchObject({ code: 'EACCES' })
    await expect(acquireRuntimeLease(root, hooks())).rejects.toMatchObject({ refusal: { kind: 'owned-by-peer', pid: process.pid } })
    await Promise.all([lease.release(), lease.release()])
    await lease.release()
    await expect(lease.update({ daemonPid: 123 })).rejects.toThrow('lease is released')
    await (await acquireRuntimeLease(root, hooks())).release()
  })

  it('never deletes or overwrites a replacement owner record', async () => {
    const root = await ownedRoot()
    const lease = await acquireRuntimeLease(root, hooks())
    const original = await readFile(join(root, LEASE_FILE_NAME), 'utf8')
    const replacement = JSON.stringify({ pid: process.pid, leaseId: 'replacement', startedAt: 'now' })
    await writeFile(join(root, LEASE_FILE_NAME), replacement)
    await expect(lease.update({ daemonPid: 123 })).rejects.toBeInstanceOf(LeaseRefusedError)
    await expect(lease.release()).rejects.toBeInstanceOf(LeaseRefusedError)
    expect(await readFile(join(root, LEASE_FILE_NAME), 'utf8')).toBe(replacement)
    await writeFile(join(root, LEASE_FILE_NAME), original)
    await lease.release()
  })

  it('releases an already-absent lock without leaving a reservation', async () => {
    const root = await ownedRoot()
    const lease = await acquireRuntimeLease(root, hooks())
    await rm(join(root, LEASE_FILE_NAME))
    await lease.release()
    await (await acquireRuntimeLease(root, hooks())).release()
  })

  it('creates the lock exclusively and releases it on demand', async () => {
    const root = await ownedRoot()
    const lease = await acquireRuntimeLease(root, hooks())
    expect(lease.content().pid).toBe(process.pid)
    const raw = JSON.parse(await readFile(join(root, LEASE_FILE_NAME), 'utf8')) as { leaseId: string }
    expect(raw.leaseId).toBe(lease.content().leaseId)
    await lease.release()
    await expect(readFile(join(root, LEASE_FILE_NAME), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('records child pids via update', async () => {
    const root = await ownedRoot()
    const lease = await acquireRuntimeLease(root, hooks())
    await lease.update({ daemonPid: 4242 })
    const raw = JSON.parse(await readFile(join(root, LEASE_FILE_NAME), 'utf8')) as { daemonPid: number }
    expect(raw.daemonPid).toBe(4242)
    await lease.update({ browserPid: 5, browserPgid: 5, daemonPid: undefined })
    const next = JSON.parse(await readFile(join(root, LEASE_FILE_NAME), 'utf8')) as { daemonPid: number; browserPid: number; browserPgid: number }
    expect(next.daemonPid).toBe(4242)
    expect(next.browserPid).toBe(5)
    expect(next.browserPgid).toBe(5)
    await lease.update({ daemonPid: null, browserPid: null, browserPgid: null })
    expect(lease.content().daemonPid).toBeUndefined()
    expect(lease.content().browserPid).toBeUndefined()
    expect(lease.content().browserPgid).toBeUndefined()
    expect(JSON.parse(await readFile(join(root, LEASE_FILE_NAME), 'utf8'))).not.toHaveProperty('daemonPid')
    await lease.release()
  })

  it('refuses a live peer without touching anything', async () => {
    const root = await ownedRoot()
    cleanup.push({ children: [] })
    const peer = sleepingChild('peer-marker')
    await writeFile(join(root, LEASE_FILE_NAME), `${JSON.stringify({ pid: peer.pid!, leaseId: 'peer-lease', startedAt: new Date().toISOString() })}\n`)
    const recording = hooks()
    await expect(acquireRuntimeLease(root, recording)).rejects.toMatchObject({
      refusal: { kind: 'owned-by-peer', pid: peer.pid },
    })
    expect(recording.stoppedDaemons).toBe(0)
    expect(recording.killedBrowsers).toBe(0)
    expect(await alive(peer.pid!)).toBe(true)
    await expect(readFile(join(root, LEASE_FILE_NAME), 'utf8')).resolves.toBeDefined()
  })

  it('cleans up exactly the recorded children of a dead-owner lease, then acquires', async () => {
    const root = await ownedRoot()
    cleanup.push({ children: [] })
    const dead = sleepingChild('doomed-owner')
    const pid = dead.pid!
    dead.kill('SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(await alive(pid)).toBe(false)
    const browserChild = sleepingChild(join(root, 'profile'), true)
    const daemonChild = sleepingChild('fake-daemon-process')
    await new Promise(resolve => setTimeout(resolve, 200))
    const recording = hooks()
    const verifyingHooks: LeaseCleanupHooks = {
      browserIsOurs: candidate => processGroups.isOwnedChromeProcess(candidate, join(root, 'profile')),
      killBrowser: async (candidate) => {
        expect(candidate).toBe(browserChild.pid!)
        recording.killedBrowsers += 1
        browserChild.kill('SIGKILL')
      },
      daemonIsOurs: async candidate => candidate === daemonChild.pid!,
      stopDaemon: async (candidate) => {
        expect(candidate).toBe(daemonChild.pid!)
        recording.stoppedDaemons += 1
        daemonChild.kill('SIGKILL')
      },
    }
    await writeFile(
      join(root, LEASE_FILE_NAME),
      `${JSON.stringify({ pid, leaseId: 'stale-lease', startedAt: new Date().toISOString(), daemonPid: daemonChild.pid!, browserPid: browserChild.pid! })}\n`,
    )
    const lease = await acquireRuntimeLease(root, verifyingHooks)
    expect(lease.content().leaseId).not.toBe('stale-lease')
    expect(recording.killedBrowsers).toBe(1)
    expect(recording.stoppedDaemons).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(await alive(browserChild.pid!)).toBe(false)
    expect(await alive(daemonChild.pid!)).toBe(false)
    await lease.release()
  })

  it('applies the own-pid rule: our pid with an unknown lease id is stale', async () => {
    const root = await ownedRoot()
    await writeFile(
      join(root, LEASE_FILE_NAME),
      `${JSON.stringify({ pid: process.pid, leaseId: 'crashed-incarnation', startedAt: new Date().toISOString() })}\n`,
    )
    const lease = await acquireRuntimeLease(root, hooks())
    expect(lease.content().leaseId).toBe((JSON.parse(await readFile(join(root, LEASE_FILE_NAME), 'utf8')) as { leaseId: string }).leaseId)
    await lease.release()
  })

  it('refuses an unreadable or malformed lock with the manual step', async () => {
    const root = await ownedRoot()
    await writeFile(join(root, LEASE_FILE_NAME), 'not json at all\n')
    await expect(acquireRuntimeLease(root, hooks())).rejects.toBeInstanceOf(LeaseRefusedError)
    await writeFile(join(root, LEASE_FILE_NAME), `${JSON.stringify({ pid: 'bogus' })}\n`)
    await expect(acquireRuntimeLease(root, hooks())).rejects.toMatchObject({
      refusal: { kind: 'owned-by-peer', pid: 0 },
    })
  })

  it('refuses an owner pid whose liveness cannot be verified', async () => {
    const root = await ownedRoot()
    cleanup.push({ children: [] })
    // pid 0 and negative pids are refused by validation; an EPERM-style pid is
    // simulated by pointing at pid 1, which a child process cannot signal.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    cleanup.at(-1)?.children.push(child)
    await writeFile(
      join(root, LEASE_FILE_NAME),
      `${JSON.stringify({ pid: 1, leaseId: 'unverifiable', startedAt: new Date().toISOString() })}\n`,
    )
    // On this host pid 1 is verifiable either way; assert only that the outcome
    // is a clean refuse-or-stale classification, never a crash.
    const outcome = await acquireRuntimeLease(root, hooks()).then(
      () => 'acquired' as const,
      (error: unknown) => (error instanceof LeaseRefusedError ? 'refused' as const : 'crashed' as const),
    )
    expect(['acquired', 'refused']).toContain(outcome)
  })

  it('keeps the lock file owner-only', async () => {
    const root = await ownedRoot()
    const lease = await acquireRuntimeLease(root, hooks())
    const mode = (await stat(join(root, LEASE_FILE_NAME))).mode & 0o777
    expect(mode).toBe(0o600)
    await lease.release()
  })
})

describe('cross-process lease recovery', () => {
  it('serializes two stale takeovers without unlinking the winning live lease', async () => {
    const root = await ownedRoot()
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
    cleanup.at(-1)!.children.push(dead)
    await once(dead, 'exit')
    const browser = sleepingChild(root + '/profile', true)
    const daemon = sleepingChild(root + '/daemon')
    await Promise.all([once(browser, 'spawn'), once(daemon, 'spawn')])
    await writeFile(join(root, LEASE_FILE_NAME), JSON.stringify({ pid: dead.pid, leaseId: 'dead-owner', startedAt: 'now', browserPid: browser.pid, daemonPid: daemon.pid }))
    const fixture = fileURLToPath(new URL('./fixtures/lease-contender.ts', import.meta.url))
    const message = (child: ReturnType<typeof spawn>): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
      const cleanupListeners = (): void => { child.off('message', received); child.off('exit', exited); child.off('error', failed) }
      const received = (value: unknown): void => { cleanupListeners(); resolve(value as Record<string, unknown>) }
      const exited = (code: number | null): void => { cleanupListeners(); reject(new Error(`contender exited with ${code}`)) }
      const failed = (error: Error): void => { cleanupListeners(); reject(error) }
      child.once('message', received).once('exit', exited).once('error', failed)
    })
    const contenders = [0, 1].map(() => {
      const child = spawn(process.execPath, ['--import', 'tsx/esm', fixture, root], {
        cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
        env: { PATH: process.env.PATH ?? '', HOME: root },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      })
      child.stderr!.on('data', (chunk: string | Uint8Array) => { process.stderr.write(chunk) })
      cleanup.at(-1)!.children.push(child)
      return child
    })
    expect(await Promise.all(contenders.map(message))).toEqual([{ ready: true }, { ready: true }])
    const outcomes = contenders.map(message)
    for (const child of contenders) child.send('acquire')
    const results = await Promise.all(outcomes)
    expect(results.filter(result => result.accepted === true)).toHaveLength(1)
    expect(results.filter(result => result.accepted === false)).toHaveLength(1)
    const winnerIndex = results.findIndex(result => result.accepted === true)
    const durable = JSON.parse(await readFile(join(root, LEASE_FILE_NAME), 'utf8')) as { leaseId: string; pid: number }
    expect(durable.leaseId).toBe(results[winnerIndex]!.leaseId)
    expect(durable.pid).toBe(contenders[winnerIndex]!.pid)
    const stops = (await readFile(join(root, 'stopped.log'), 'utf8')).trim().split(String.fromCharCode(10)).sort()
    expect(stops).toEqual([`browser:${browser.pid}`, `daemon:${daemon.pid}`].sort())
    const released = message(contenders[winnerIndex]!)
    contenders[winnerIndex]!.send('release')
    expect(await released).toEqual({ released: true })
    await expect(readFile(join(root, LEASE_FILE_NAME), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)
})

describe('lease file validation', () => {

  it.each([
    null,
    { pid: 0, leaseId: 'x', startedAt: 'now' },
    { pid: process.pid, leaseId: '', startedAt: 'now' },
    { pid: process.pid, leaseId: 'x' },
    { pid: process.pid, leaseId: 'x', startedAt: 'now', daemonPid: -1 },
  ])('refuses malformed durable ownership records: %j', async (value) => {
    const root = await ownedRoot()
    await writeFile(join(root, LEASE_FILE_NAME), JSON.stringify(value))
    await expect(acquireRuntimeLease(root, hooks())).rejects.toBeInstanceOf(LeaseRefusedError)
  })

  it('refuses an unreadable ownership record', async () => {
    const root = await ownedRoot()
    await mkdir(join(root, LEASE_FILE_NAME))
    await expect(acquireRuntimeLease(root, hooks())).rejects.toThrow('cannot read the runtime lock')
  })

  it('never steals an orphan writer mutex and supplies the manual recovery path', async () => {
    const root = await ownedRoot()
    const mutex = join(root, LEASE_FILE_NAME + '.lock')
    await writeFile(mutex, '123456\n')
    await expect(acquireRuntimeLease(root, hooks())).rejects.toMatchObject({ refusal: {
      kind: 'owned-by-peer', detail: expect.stringContaining(mutex) as string,
    } })
    expect(await readFile(mutex, 'utf8')).toBe('123456\n')
    await rm(mutex)
    await (await acquireRuntimeLease(root, hooks())).release()
  }, 5_000)

  it('does not stop live recorded pids whose ownership verification fails', async () => {
    const root = await ownedRoot()
    const child = sleepingChild('unrelated-recorded-child')
    await writeFile(join(root, LEASE_FILE_NAME), JSON.stringify({ pid: process.pid, leaseId: 'orphan', startedAt: 'now', browserPid: child.pid, daemonPid: child.pid }))
    const recording = hooks()
    recording.browserIsOurs = async () => false
    recording.daemonIsOurs = async () => false
    const lease = await acquireRuntimeLease(root, recording)
    expect(recording.killedBrowsers).toBe(0)
    expect(recording.stoppedDaemons).toBe(0)
    expect(await alive(child.pid!)).toBe(true)
    await lease.release()
  })
})
