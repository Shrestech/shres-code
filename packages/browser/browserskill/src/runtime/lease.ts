/**
 * The single-owner runtime lease for one root. Every mutating operation —
 * open, provision, reset, uninstall — holds it, so two Shres hosts can never
 * drive one browser stack. The rules follow the profile-plugin lock pattern:
 * an exclusive writer mutex protects each lease change; the lease records the owner pid and
 * every child pid the owner starts, a live peer refuses without touching
 * anything, a verified-dead owner's leftovers are cleaned up bounded to the
 * pids the stale lease RECORDED, and anything that cannot be verified refuses
 * with the manual step. No scan-and-kill by argument matching; no global pid
 * kills.
 *
 * @module @shres-code/shres-code-browserskill/runtime/lease
 */

import { mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { withFileLock, writeFileAtomic } from '@shres-code/shres-code-atomic-write'
import type { BrowserSkillRefusal } from '../types.ts'
import { waitForOwnedGroupMembers } from './process-group.ts'

/** The lock file name under the root. */
export const LEASE_FILE_NAME = 'runtime.lock'

// A second module instance must recognize a holder created before an HMR reload.
const holdersKey = Symbol.for('shres-code.browserskill.runtimeLeases')
const processState = globalThis as typeof globalThis & { [holdersKey]: Map<string, string> | undefined }
const holders = processState[holdersKey] ??= new Map<string, string>()

/** The lease content persisted beside the exclusive create. */
export interface RuntimeLeaseContent {
  /** The owning process id. */
  pid: number
  /** Fresh id minted per acquisition; distinguishes our own stale locks. */
  leaseId: string
  /** ISO timestamp of the acquisition. */
  startedAt: string
  /** The daemon child pid, recorded once started. */
  daemonPid?: number | undefined
  /** The browser child pid, recorded once started. */
  browserPid?: number | undefined
  /** Observed detached group; never grants post-exit signal authority. */
  browserPgid?: number | undefined
}

/** Why acquisition refused; carries the user-displayable refusal. */
export class LeaseRefusedError extends Error {
  /** Ownership refusal with the concrete recovery detail for display. */
  readonly refusal: Extract<BrowserSkillRefusal, { kind: 'owned-by-peer' }> & { detail: string }

  constructor(refusal: Extract<BrowserSkillRefusal, { kind: 'owned-by-peer' }>, message: string) {
    super(message)
    this.name = 'LeaseRefusedError'
    this.refusal = { ...refusal, detail: message }
  }
}

/** Injected verifiers and stoppers for stale cleanup; the supervisor owns the real ones. */
export interface LeaseCleanupHooks {
  /**
   * Verify a recorded browser pid is ours: the process must be alive AND its
   * command line must reference our owned profile directory.
   */
  browserIsOurs(pid: number, timeoutMs?: number): Promise<boolean>
  /** Kill a verified-ours recorded browser pid. */
  killBrowser(pid: number): Promise<void>
  /** Verify a recorded daemon pid answers our owned BSK_HOME with exactly that pid. */
  daemonIsOurs(pid: number): Promise<boolean>
  /**
   * Stop through the owned BSK_HOME and await confirmed exit without adopting the process.
   * @param pid - the recorded daemon pid whose ownership was verified.
   * @returns once that pid has exited; rejects when exit cannot be confirmed.
   */
  stopDaemon(pid: number): Promise<void>
}

/** Whether a pid is alive. EPERM counts as alive: it cannot be verified dead. */
function pidAlive(pid: number): 'alive' | 'dead' | 'unverified' {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return 'dead'
    return 'unverified'
  }
}

/** Read and validate lease content; malformed content is a refusal, never a guess. */
async function readLease(path: string): Promise<RuntimeLeaseContent> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error
    throw new LeaseRefusedError(
      { kind: 'owned-by-peer', pid: 0 },
      `cannot read the runtime lock at ${path}: ${String(error)}; resolve it manually`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new LeaseRefusedError(
      { kind: 'owned-by-peer', pid: 0 },
      `the runtime lock at ${path} is not valid JSON; resolve it manually`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new LeaseRefusedError({ kind: 'owned-by-peer', pid: 0 }, `the runtime lock at ${path} is malformed; resolve it manually`)
  }
  const wire = parsed as Record<string, unknown>
  const pid = wire.pid
  const leaseId = wire.leaseId
  const startedAt = wire.startedAt
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new LeaseRefusedError({ kind: 'owned-by-peer', pid: 0 }, `the runtime lock at ${path} has an invalid pid; resolve it manually`)
  }
  if (typeof leaseId !== 'string' || leaseId.length === 0 || leaseId.length > 128) {
    throw new LeaseRefusedError({ kind: 'owned-by-peer', pid }, `the runtime lock at ${path} has an invalid leaseId; resolve it manually`)
  }
  if (typeof startedAt !== 'string') {
    throw new LeaseRefusedError({ kind: 'owned-by-peer', pid }, `the runtime lock at ${path} has an invalid startedAt; resolve it manually`)
  }
  const optionalPid = (name: string): number | undefined => {
    const value = wire[name]
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new LeaseRefusedError({ kind: 'owned-by-peer', pid }, `the runtime lock at ${path} has an invalid ${name}; resolve it manually`)
    }
    return value
  }
  const daemonPid = optionalPid('daemonPid')
  const browserPid = optionalPid('browserPid')
  const browserPgid = optionalPid('browserPgid')
  if (browserPgid !== undefined && browserPgid !== browserPid) {
    throw new LeaseRefusedError({ kind: 'owned-by-peer', pid }, 'the recorded Chrome group does not match its leader; resolve the runtime lock manually')
  }
  return {
    pid,
    leaseId,
    startedAt,
    ...(daemonPid === undefined ? {} : { daemonPid }),
    ...(browserPid === undefined ? {} : { browserPid }),
    ...(browserPgid === undefined ? {} : { browserPgid }),
  }
}

/** A held lease: update child pids, release last. */
export interface HeldRuntimeLease {
  /** The content currently persisted. */
  content(): Readonly<RuntimeLeaseContent>
  /** Persist child pids atomically; null clears a pid after confirmed exit. */
  update(children: {
    daemonPid?: number | null | undefined
    browserPid?: number | null | undefined
    browserPgid?: number | null | undefined
  }): Promise<void>
  /** Remove the lock; only the holder may call this. */
  release(): Promise<void>
}

/**
 * Acquire the runtime lease on one root. Existing locks are classified: a
 * live peer refuses untouched, our own pid without our in-memory lease is
 * stale, a verified-dead owner is stale, and anything unverifiable refuses
 * with the manual step. Stale cleanup kills ONLY the processes the stale
 * lease recorded, each verified ours before it is stopped: the recorded
 * browser first, then the recorded daemon through our owned home.
 * @param root - the owned runtime root.
 * @param hooks - verifiers and stoppers for recorded stale children.
 * @returns the held lease.
 * @throws LeaseRefusedError for a live peer, an unreadable lock, or an unverifiable pid.
 */
export async function acquireRuntimeLease(root: string, hooks: LeaseCleanupHooks): Promise<HeldRuntimeLease> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const key = await realpath(root)
  const path = join(key, LEASE_FILE_NAME)
  const leaseId = randomUUID()
  if (holders.has(key)) {
    throw new LeaseRefusedError(
      { kind: 'owned-by-peer', pid: process.pid },
      'another BrowserSkill runtime in this process owns ' + key,
    )
  }
  holders.set(key, leaseId)
  try {
    const content: RuntimeLeaseContent = { pid: process.pid, leaseId, startedAt: new Date().toISOString() }
    await mutateLease(path, async () => {
      let existing: RuntimeLeaseContent | undefined
      try {
        existing = await readLease(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // No durable owner exists; the writer mutex excludes another acquisition.
      }
      if (existing !== undefined) await classifyExistingLease(path, existing, hooks)
      await writeFileAtomic(path, JSON.stringify(content, null, 2) + '\n', { mode: 0o600, dirMode: 0o700 })
    })
    let current = content
    let released = false
    let releasing: Promise<void> | undefined
    const requireOwner = async (): Promise<void> => {
      if (released) throw new Error('BrowserSkill runtime lease is released')
      const stored = await readLease(path)
      if (stored.leaseId !== leaseId || stored.pid !== process.pid) {
        throw new LeaseRefusedError(
          { kind: 'owned-by-peer', pid: stored.pid },
          'the owner of ' + path + ' changed; no files were modified',
        )
      }
    }
    return {
      content: () => current,
      update: children => mutateLease(path, async () => {
        await requireOwner()
        const next: RuntimeLeaseContent = { ...current }
        if (children.daemonPid === null) delete next.daemonPid
        else if (children.daemonPid !== undefined) next.daemonPid = children.daemonPid
        if (children.browserPid === null) delete next.browserPid
        else if (children.browserPid !== undefined) next.browserPid = children.browserPid
        if (children.browserPgid === null) delete next.browserPgid
        else if (children.browserPgid !== undefined) next.browserPgid = children.browserPgid
        await writeFileAtomic(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, dirMode: 0o700 })
        current = next
      }),
      release: () => {
        if (released) return Promise.resolve()
        if (releasing !== undefined) return releasing
        releasing = (async () => {
          try {
            await mutateLease(path, async () => {
              try {
                await requireOwner()
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
                // An already-absent lock needs no deletion; no replacement owner was found.
              }
              await rm(path, { force: true })
            })
            released = true
            /* v8 ignore else -- Only this holder can remove its reserved canonical root. */
            if (holders.get(key) === leaseId) holders.delete(key)
          } finally {
            releasing = undefined
          }
        })()
        return releasing
      },
    }
  } catch (error) {
    /* v8 ignore else -- Failed acquisition retains its reservation until this cleanup. */
    if (holders.get(key) === leaseId) holders.delete(key)
    throw error
  }
}

/** Serialize the lease read/verify/commit, including takeover and release. */
async function mutateLease<T>(path: string, operation: () => Promise<T>): Promise<T> {
  let entered = false
  try {
    return await withFileLock(path, async () => {
      entered = true
      return operation()
    })
  } catch (error) {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Callback entry separates operation errors from lock failures.
    if (entered) throw error
    throw new LeaseRefusedError(
      { kind: 'owned-by-peer', pid: 0 },
      'cannot acquire BrowserSkill writer lock at ' + path + '.lock; if it remains after its owner exits, remove it manually: ' + String(error),
    )
  }
}

/** Classify and, for stale locks, clean up the recorded children. */
async function classifyExistingLease(
  path: string,
  existing: RuntimeLeaseContent,
  hooks: LeaseCleanupHooks,
): Promise<void> {
  if (existing.pid === process.pid) {
    // Own-pid rule: our process holds no in-memory lease with this id, so the
    // lock outlived its holder (crashed previous incarnation) and is stale.
    await cleanStaleLease(existing, hooks)
    return
  }
  const liveness = pidAlive(existing.pid)
  if (liveness === 'alive') {
    throw new LeaseRefusedError(
      { kind: 'owned-by-peer', pid: existing.pid },
      `the runtime at ${path} is owned by a live process (pid ${existing.pid}); nothing was touched`,
    )
  }
  if (liveness === 'dead') {
    await cleanStaleLease(existing, hooks)
    return
  }
  throw new LeaseRefusedError(
    { kind: 'owned-by-peer', pid: existing.pid },
    `cannot verify whether pid ${existing.pid} still owns ${path}; resolve it manually`,
  )
}

/** Stop only verified recorded children while holding the writer mutex. */
async function cleanStaleLease(stale: RuntimeLeaseContent, hooks: LeaseCleanupHooks): Promise<void> {
  if (stale.browserPid !== undefined && (pidAlive(stale.browserPid)) === 'alive') {
    if (await hooks.browserIsOurs(stale.browserPid)) {
      await hooks.killBrowser(stale.browserPid)
    }
  }
  if (stale.browserPgid !== undefined) {
    try { await waitForOwnedGroupMembers(stale.browserPgid, 5_000, (pid, ms) => hooks.browserIsOurs(pid, ms)) }
    catch (error) { throw new LeaseRefusedError({ kind: 'owned-by-peer', pid: stale.pid }, 'cannot recover BrowserSkill ownership: ' + String(error)) }
  }
  if (stale.daemonPid !== undefined && (pidAlive(stale.daemonPid)) === 'alive') {
    if (await hooks.daemonIsOurs(stale.daemonPid)) {
      await hooks.stopDaemon(stale.daemonPid)
    }
  }
}
