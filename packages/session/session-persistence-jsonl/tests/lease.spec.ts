/**
 * Cross-process write-lock behavior, exercised through fresh backend
 * instances over one shared root: kernel `flock` locks conflict between two
 * descriptors even inside one process, so a second instance behaves exactly
 * like a second process. Exclusion while a holder is live, immediate
 * admission after close, lock-file residue rules, and the inode verification
 * that defeats an unlinked-and-recreated lock path. Filesystem and flock
 * refusals are injected through the module mocks below: POSIX modes cannot
 * express them on Windows, and an injected error is the only deterministic
 * cross-platform refusal. Real cross-process exclusion and crash release are
 * pinned by lease.two-process.e2e.ts.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { constants as osConstants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionId } from '@shres-code/shres-code-session'
import type { SessionEvent, SessionHeader } from '@shres-code/shres-code-session'
import {
  SessionWriteAlreadyOwnedError,
} from '@shres-code/shres-code-session-persistence'
import type { SessionPersistence } from '@shres-code/shres-code-session-persistence'
import JsonlSessionPersistence from '../src/index.ts'
import { LEASE_FILENAME, SessionWriteLease } from '../src/lease.ts'
import { sessionDir } from '../src/format.ts'

const LOCK = vi.hoisted(() => 'session.lock')

const refuse = vi.hoisted(() => ({
  /** Next open of a lock file fails EACCES (read-only directory). */
  lockOpen: false,
  /** Next flock call fails EACCES (a non-contention kernel refusal). */
  flock: false,
  /** Next flock call fails EWOULDBLOCK (the Windows LockFileEx contention code). */
  flockBusy: false,
  /** Next stat of a lock file fails EACCES (unreadable path). */
  lockStat: false,
  /** For N further lock-path stats: unlink and recreate the file first, so the locked inode is orphaned. */
  swapLockOnStat: 0,
  /** Next lock-path stat: unlink the file first, so the verify read finds nothing. */
  dropLockOnStat: false,
  /** Last injected flock errno, read through the koffi mock's `errno` getter. */
  errno: 0,
}))

vi.mock('koffi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('koffi')>()
  const loaded = actual.default as {
    load: (name: string) => { func: (signature: string) => (fd: number, operation: number) => number }
    errno: () => number
  }
  const nativeErrno = loaded.errno.bind(loaded)
  return {
    default: {
      ...loaded,
      errno: () => refuse.errno !== 0 ? refuse.errno : nativeErrno(),
      load: (name: string) => {
        const lib = loaded.load(name)
        return {
          func: (signature: string) => {
            const fn = lib.func(signature)
            if (!signature.includes('flock')) return fn
            return (fd: number, operation: number) => {
              if (refuse.flock) {
                refuse.flock = false
                refuse.errno = osConstants.errno.EACCES
                return -1
              }
              if (refuse.flockBusy) {
                refuse.flockBusy = false
                refuse.errno = osConstants.errno.EWOULDBLOCK ?? osConstants.errno.EAGAIN
                return -1
              }
              return fn(fd, operation)
            }
          },
        }
      },
    },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const denied = (syscall: string): never => {
    throw Object.assign(new Error(`EACCES: injected ${syscall} refusal`), { code: 'EACCES' })
  }
  return {
    ...actual,
    open: (async (path: unknown, ...rest: never[]) => {
      if (refuse.lockOpen && String(path).endsWith(LOCK)) {
        refuse.lockOpen = false
        denied('open')
      }
      return (actual.open as (path: unknown, ...args: never[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.open,
    stat: (async (path: unknown, ...rest: never[]) => {
      const at = String(path)
      if (at.endsWith(LOCK)) {
        if (refuse.lockStat) {
          refuse.lockStat = false
          denied('stat')
        }
        if (refuse.dropLockOnStat) {
          refuse.dropLockOnStat = false
          await actual.unlink(at)
        } else if (refuse.swapLockOnStat > 0) {
          refuse.swapLockOnStat -= 1
          await actual.unlink(at)
          await actual.writeFile(at, '')
        }
      }
      return (actual.stat as (path: unknown, ...args: never[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.stat,
  }
})

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  refuse.lockOpen = false
  refuse.flock = false
  refuse.flockBusy = false
  refuse.lockStat = false
  refuse.swapLockOnStat = 0
  refuse.dropLockOnStat = false
  refuse.errno = 0
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function meta(id: string, cwd = '/work'): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1_000, cwd }
}

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'shres-jsonl-lease-'))
  dirs.push(root)
  return root
}

async function mount(root: string): Promise<SessionPersistence> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return ctx.sessionPersistence
}

/** Materialize a live session so the kernel lock is held until this context disposes. */
async function holdLive(root: string, id: string): Promise<{ persistence: SessionPersistence; session: Session; ctx: Context }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  let session!: Session
  await ctx.plugin(Object.assign((inner: Context) => {
    session = inner.sessions.create(SessionId(id), { meta: { cwd: '/work' } })
  }, { inject: ['sessions'] }))
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ctx.sessions.flush(session)
  return { persistence: ctx.sessionPersistence, session, ctx }
}

function lockPath(root: string, id: string, cwd = '/work'): string {
  return join(sessionDir(root, cwd, SessionId(id)), LEASE_FILENAME)
}

const EVENTS: SessionEvent[] = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]

describe('cross-process write lock', () => {
  it('excludes a second instance while the holder is live, and admits it after close', async () => {
    const root = await freshRoot()
    const first = await holdLive(root, 'excluded')
    const second = await mount(root)

    await expect(second.create(meta('excluded'))).rejects.toThrow(/already has a persisted log/)
    await expect(second.append(SessionId('excluded'), [
      { type: 'turn/start', seq: 2, time: 3, data: { turn: 2 } },
    ])).rejects.toBeInstanceOf(SessionWriteAlreadyOwnedError)
    const pendingLoser = meta('excluded-pending')
    await second.create(pendingLoser)
    await holdLive(root, 'excluded-pending')
    await expect(second.append(pendingLoser.id, EVENTS)).rejects.toBeInstanceOf(SessionWriteAlreadyOwnedError)

    const reader = await second.load(SessionId('excluded'))
    expect(reader.events.map(event => event.seq)).toEqual([0, 1])
    expect((await second.inspect(SessionId('excluded'))).meta.id).toBe(SessionId('excluded'))
    expect((await second.readFrom(SessionId('excluded'), 0)).events.length).toBeGreaterThan(0)
    expect((await second.list()).some(header => header.id === SessionId('excluded'))).toBe(true)

    await first.ctx.fiber.dispose()
    if (process.platform !== 'win32') expect(existsSync(lockPath(root, 'excluded'))).toBe(true)
    await second.append(SessionId('excluded'), [
      { type: 'turn/start', seq: 2, time: 3, data: { turn: 2 } },
    ])
  })

  it.skipIf(process.platform === 'win32')('removing the lock file forfeits a wedged holder: a fresh inode admits a successor', async () => {
    const root = await freshRoot()
    await holdLive(root, 'wedged')
    const second = await mount(root)

    await unlink(lockPath(root, 'wedged'))
    await second.append(SessionId('wedged'), [
      { type: 'turn/start', seq: 2, time: 3, data: { turn: 2 } },
    ])
  })

  it('a never-materialized create leaves no filesystem footprint at all', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    await backend.create(meta('erased'))
    expect(existsSync(join(lockPath(root, 'erased'), '..'))).toBe(false)
    await contexts[0]?.fiber.dispose()
    expect(existsSync(join(lockPath(root, 'erased'), '..'))).toBe(false)
    await expect(backend.list()).resolves.toEqual([])
  })

  it('materialization publishes the lock before the first log bytes and keeps it on the writing session', async () => {
    const root = await freshRoot()
    const first = await holdLive(root, 'lazy-lock')
    const second = await mount(root)
    if (process.platform !== 'win32') expect(existsSync(lockPath(root, 'lazy-lock'))).toBe(true)
    await expect(second.append(SessionId('lazy-lock'), [
      { type: 'turn/start', seq: 2, time: 3, data: { turn: 2 } },
    ])).rejects.toBeInstanceOf(SessionWriteAlreadyOwnedError)
    first.session.append('turn/start', { turn: 2 })
    first.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await first.ctx.sessions.flush(first.session)
    await first.ctx.fiber.dispose()
    const successor = await mount(root)
    await successor.append(SessionId('lazy-lock'), [
      { type: 'turn/start', seq: 4, time: 5, data: { turn: 3 } },
    ])
  })

  it.skipIf(process.platform === 'win32')('surfaces a filesystem refusal opening the lock file', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    await backend.create(meta('open-blocked'))
    refuse.lockOpen = true
    await expect(backend.append(SessionId('open-blocked'), EVENTS)).rejects.toThrow(/EACCES/)
  })

  it.skipIf(process.platform === 'win32')('surfaces a non-contention flock failure', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    await backend.create(meta('flock-blocked'))
    refuse.flock = true
    await expect(backend.append(SessionId('flock-blocked'), EVENTS)).rejects.toThrow(/EACCES/)
  })

  it.skipIf(process.platform === 'win32')('maps the EWOULDBLOCK contention spelling to already-owned', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    await backend.create(meta('win-contended'))
    refuse.flockBusy = true
    await expect(backend.append(SessionId('win-contended'), EVENTS)).rejects.toBeInstanceOf(SessionWriteAlreadyOwnedError)
  })

  it.skipIf(process.platform === 'win32')('surfaces a lock-path stat refusal from the inode verification', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    await backend.create(meta('stat-blocked'))
    refuse.lockStat = true
    await expect(backend.append(SessionId('stat-blocked'), EVENTS)).rejects.toThrow(/EACCES/)
  })

  it.skipIf(process.platform === 'win32')('retries when the locked inode is no longer the lock path, and wins on a stable pass', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    await backend.create(meta('churned'))
    refuse.swapLockOnStat = 1
    await backend.append(SessionId('churned'), EVENTS)
  })

  it.skipIf(process.platform === 'win32')('retries when the lock path vanishes under the verify read', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    await backend.create(meta('vanished'))
    refuse.dropLockOnStat = true
    await backend.append(SessionId('vanished'), EVENTS)
  })

  it.skipIf(process.platform === 'win32')('gives up as already-owned when the lock path never stabilizes', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    await backend.create(meta('unstable'))
    refuse.swapLockOnStat = 3
    await expect(backend.append(SessionId('unstable'), EVENTS)).rejects.toBeInstanceOf(SessionWriteAlreadyOwnedError)
  })

  it.skipIf(process.platform === 'win32')('release is idempotent and never removes the lock file', async () => {
    const root = await freshRoot()
    const dir = join(root, 'solo')
    const lease = await SessionWriteLease.acquire(dir, SessionId('solo'))
    await lease.release()
    await lease.release()
    expect(existsSync(join(dir, LOCK))).toBe(true)
    const successor = await SessionWriteLease.acquire(dir, SessionId('solo'))
    await successor.release()
    expect(existsSync(join(dir, LOCK))).toBe(true)
  })

  it('keeps distinct sessions independently lockable', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    await backend.create(meta('indep-a'))
    await backend.create(meta('indep-b'))
    await backend.append(SessionId('indep-a'), EVENTS)
    await backend.append(SessionId('indep-b'), EVENTS)
  })

  it('a failing lock release still frees the in-process claim', async () => {
    const root = await freshRoot()
    await holdLive(root, 'release-fails')
    const spy = vi.spyOn(SessionWriteLease.prototype, 'release')
    spy.mockImplementationOnce(async function (this: SessionWriteLease) {
      spy.mockRestore()
      await this.release()
      throw Object.assign(new Error('EIO: injected release failure'), { code: 'EIO' })
    })
    const jsonl = contexts[0]?.sessionPersistence as JsonlSessionPersistence
    await expect(jsonl.releaseWrite(SessionId('release-fails'))).rejects.toThrow(/injected release failure/)
    const second = await mount(root)
    await second.append(SessionId('release-fails'), [
      { type: 'turn/start', seq: 2, time: 3, data: { turn: 2 } },
    ])
  })
})
