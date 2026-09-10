/**
 * Cross-process write-ownership lock for one session's artifact directory,
 * held for the life of the coordinator's writing session state. The arbiter
 * is the kernel: POSIX takes a non-blocking `flock(2)` through koffi on
 * `session.lock` beside the log, and Windows holds a named kernel semaphore
 * derived from that path — never a file lock or handle, so readers, searches,
 * and directory removal proceed freely while the lock is held. Contention
 * maps to `SessionWriteAlreadyOwnedError`; the kernel releases the lock when
 * the holder's descriptor or last object handle closes, including on any
 * process death, so a crashed holder never blocks a successor. A live but
 * wedged holder keeps the lock until its process exits: there is deliberately
 * no expiry that could expropriate a stalled writer whose resumed appends
 * would tear the log.
 * A POSIX lock names an inode, not a path, so after locking the holder
 * verifies the locked inode is still the file at the lock path and retries
 * otherwise: an unlinked-and-recreated lock file carries a fresh inode, and
 * a lock on the orphaned one proves nothing. Removing a live session's lock
 * file therefore forfeits exclusion on POSIX (nothing in the harness does
 * so); Windows has no lock file at all. Readers never touch the lock.
 * The lock is acquired immediately before a session's first materializing
 * write or when a live writer binds to an already-materialized log — an
 * unmaterialized session has no filesystem footprint. Release never removes
 * the POSIX lock file: every acquired lock belongs to a materialized or
 * materializing session, and the surviving file keeps the stable inode later
 * lockers verify against.
 * @module @shres-code/shres-code-session-persistence-jsonl/lease
 */

import { mkdir, open, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { constants as osConstants } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@shres-code/shres-code-session'
import { SessionWriteAlreadyOwnedError } from '@shres-code/shres-code-session-persistence'
import { acquireLockHandleWin32, releaseLockHandleWin32 } from './win32.ts'

/** Base name of the kernel lock file inside a session's directory. */
export const LEASE_FILENAME = 'session.lock'

/** Exclusive non-blocking `flock(2)` operation (`LOCK_EX | LOCK_NB`). */
const LOCK_EX_NB = 2 | 4

/** The held kernel lock: a POSIX descriptor or a Win32 semaphore handle. */
type HeldLock =
  | { readonly kind: 'posix'; readonly handle: FileHandle }
  | { readonly kind: 'win32'; readonly handle: number }

interface KoffiFlock {
  flock: (fd: number, operation: number) => number
  errno: () => number
}

let posixBindings: KoffiFlock | undefined

/** Load libc flock lazily so Windows processes never bind POSIX symbols. */
async function posixFlock(): Promise<KoffiFlock> {
  if (posixBindings !== undefined) return posixBindings
  const koffi = (await import('koffi')).default as {
    load: (name: string) => { func: (signature: string) => (fd: number, operation: number) => number }
    errno: () => number
  }
  const lib = koffi.load(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6')
  const flock = lib.func('int flock(int fd, int operation)')
  posixBindings = {
    flock,
    errno: () => koffi.errno(),
  }
  return posixBindings
}

/** Map a numeric errno onto a Node-style filesystem exception. */
function flockException(errno: number): NodeJS.ErrnoException {
  const name = Object.entries(osConstants.errno)
    .find(([, value]) => value === errno)?.[0] ?? 'EIO'
  const error = new Error(`flock ${name} (errno ${errno})`) as NodeJS.ErrnoException
  error.code = name
  error.errno = errno
  error.syscall = 'flock'
  return error
}

/** Whether a flock failure means another descriptor holds the lock. */
function isLockContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  // flock(2) reports EAGAIN; some libcs spell it EWOULDBLOCK.
  return code === 'EAGAIN' || code === 'EWOULDBLOCK'
}

/**
 * One held write lock. Constructed only by {@link SessionWriteLease.acquire};
 * `release` closes the descriptor or handle, which is what releases the lock.
 */
export class SessionWriteLease {
  private released = false

  private constructor(private readonly held: HeldLock) {}

  /**
   * Acquire the session directory's kernel write lock.
   * @param dir - the session's artifact directory (created if absent).
   * @param id - the session the lock guards, for error identities.
   * @returns the held lock.
   * @throws {SessionWriteAlreadyOwnedError} while another holder keeps the lock.
   */
  static async acquire(dir: string, id: SessionId): Promise<SessionWriteLease> {
    const path = join(dir, LEASE_FILENAME)
    // Owner-only like materializePosix's directories: the lock may create the
    // session directory first, and both creators must agree on the mode.
    await mkdir(dir, { recursive: true, mode: 0o700 })
    /* v8 ignore start -- native Windows coverage exercises this platform branch; POSIX covers the peer */
    if (process.platform === 'win32') {
      let handle: number
      try {
        handle = await acquireLockHandleWin32(path)
      } catch (error: unknown) {
        // Sharing violation: another handle already holds the write exclusion.
        if ((error as NodeJS.ErrnoException | null)?.code === 'EBUSY') throw new SessionWriteAlreadyOwnedError(id)
        throw error
      }
      return new SessionWriteLease({ kind: 'win32', handle })
    }
    /* v8 ignore stop */
    const api = await posixFlock()
    // Bounded retry: locking an inode a releasing creator just unlinked (or a
    // recreated path) re-opens the fresh file; steady state needs one pass.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const handle = await open(path, 'w')
      try {
        try {
          const result = api.flock(handle.fd, LOCK_EX_NB)
          if (result !== 0) throw flockException(api.errno())
        } catch (error: unknown) {
          if (isLockContention(error)) throw new SessionWriteAlreadyOwnedError(id)
          throw error
        }
        const held = await handle.stat({ bigint: true })
        const current = await stat(path, { bigint: true }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
          throw error
        })
        if (current !== undefined && current.ino === held.ino && current.dev === held.dev) {
          return new SessionWriteLease({ kind: 'posix', handle })
        }
      } catch (error: unknown) {
        await handle.close()
        throw error
      }
      // The locked inode is no longer the file at the lock path: start over
      // against whatever now stands there.
      await handle.close()
    }
    throw new SessionWriteAlreadyOwnedError(id)
  }

  /**
   * Release the kernel lock by closing its descriptor or handle. The POSIX
   * lock file is never removed: every acquired lock belongs to a
   * materialized or materializing session, and keeping the file preserves
   * the stable inode later lockers verify against. Idempotent.
   */
  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    /* v8 ignore start -- native Windows coverage exercises this platform branch; POSIX covers the peer */
    if (this.held.kind === 'win32') {
      await releaseLockHandleWin32(this.held.handle)
      return
    }
    /* v8 ignore stop */
    await this.held.handle.close()
  }
}
