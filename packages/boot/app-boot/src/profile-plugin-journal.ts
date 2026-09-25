/** Shared profile lock and durable metadata recovery for managed plugin operations. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { withFileLock, writeFileAtomic } from '@shres-code/shres-code-atomic-write'
import { optionalText, PLUGIN_SOURCES_DIRECTORY } from './profile-plugin-inspect.ts'
import { ProfilePluginError, type CoreOptions, type RecoveryOutcome, type RollbackReport } from './profile-plugin-types.ts'

const journalSchema = z.object({
  version: z.literal(1), id: z.uuid(), op: z.enum(['install', 'remove']), pid: z.number().int().positive(),
  startedAt: z.iso.datetime(), spec: z.string(), phase: z.enum(['mutating', 'committing']),
  manifestBytes: z.string(), lockfileBytes: z.string().nullable(), committedManifestBytes: z.string().optional(),
  sourcePath: z.string().optional(), stagedPath: z.string().optional(),
}).strict()
/** Validated on-disk transaction state. */
export type PluginJournal = z.infer<typeof journalSchema>
const owners = new Map<string, string>()

async function ownedSourcePath(dir: string, path: string): Promise<string> {
  const normalized = resolve(path)
  const id = basename(normalized)
  const parent = dirname(normalized)
  if (!z.uuid().safeParse(id).success || basename(parent) !== PLUGIN_SOURCES_DIRECTORY
    || await realpath(dirname(parent)) !== await realpath(dir)) throw new Error('Unowned staged path')
  return join(resolve(dir), PLUGIN_SOURCES_DIRECTORY, id)
}
/** Metadata recovery file name; it is not an inventory of installed packages. */
export const PLUGIN_JOURNAL = '.shres-plugin-txn.json'
/**
 * Read and validate a persisted transaction before interpreting any recovery fields.
 * @param dir - profile directory.
 * @returns the validated journal, or null when absent.
 */
export async function readJournal(dir: string): Promise<PluginJournal | null> {
  const bytes = await optionalText(join(dir, PLUGIN_JOURNAL))
  if (bytes === null) return null
  try {
    const journal = journalSchema.parse(JSON.parse(bytes))
    if (journal.stagedPath !== undefined) {
      journal.stagedPath = await ownedSourcePath(dir, journal.stagedPath)
      if (journal.op === 'install' && basename(journal.stagedPath) !== journal.id) throw new Error('Staged path differs from transaction id')
    }
    return journal
  } catch (error) {
    throw new ProfilePluginError('restore-failed', 'Invalid plugin transaction journal at ' + join(dir, PLUGIN_JOURNAL)
      + '. Stop profile writers and inspect package.json and pnpm-lock.yaml before manually repairing or removing this journal. '
      + 'Retain source snapshots referenced by the manifest. Cause: ' + String(error))
  }
}
/**
 * Persist the recovery record before mutating the profile.
 * @param dir - profile directory.
 * @param journal - complete transaction record.
 */
export async function writeJournal(dir: string, journal: PluginJournal): Promise<void> {
  await writeFileAtomic(join(dir, PLUGIN_JOURNAL), JSON.stringify(journal) + '\n', { mode: 0o600, dirMode: 0o700 })
}
/**
 * Delete a settled transaction only after its owned work has completed.
 * @param dir - profile directory.
 */
export async function clearJournal(dir: string): Promise<void> { await rm(join(dir, PLUGIN_JOURNAL), { force: true }) }
/**
 * Determine whether a persisted owner still prevents recovery.
 * @param journal - validated transaction record.
 * @returns whether that process or exact in-process operation remains alive.
 */
export function ownerAlive(journal: PluginJournal): boolean {
  if (journal.pid === process.pid) return [...owners.values()].includes(journal.id)
  try { process.kill(journal.pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    throw error
  }
}
/**
 * Hold the one profile lock for an entire operation, including its consent interval.
 * All in-process writers of this manifest must use this owner; direct withFileLock
 * callers would be indistinguishable from an abandoned same-PID lock.
 * @param dir - profile directory.
 * @param signal - cancellation checked after lock acquisition.
 * @param operation - non-reentrant action receiving its journal owner id.
 * @returns the operation result after releasing the lock.
 */
export async function withProfileLease<T>(dir: string, signal: AbortSignal, operation: (id: string) => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const key = await realpath(resolve(dir))
  if (owners.has(key)) throw new ProfilePluginError('transaction-pending', 'This process already owns a profile operation.', process.pid)
  const id = randomUUID()
  owners.set(key, id)
  try {
    const lockPath = join(key, 'package.json.lock')
    const priorLock = await optionalText(lockPath)
    // Reservation precedes I/O, so no second local operation can reap this lease.
    if (priorLock?.trim() === String(process.pid)) await rm(lockPath, { force: true })
    return await withFileLock(join(key, 'package.json'), async () => {
      signal.throwIfAborted()
      return operation(id)
    })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('atomic-write: timed out waiting for the writer lock')) {
      throw new ProfilePluginError('lock-timeout', error.message)
    }
    throw error
  } finally { owners.delete(key) }
}
/**
 * Restore exact metadata bytes, then attempt a script-disabled offline dependency repair.
 * @param dir - profile directory.
 * @param journal - pre-mutation metadata snapshot.
 * @param options - runner and cancellation owned by this restoration.
 * @returns the metadata and dependency repair outcome; failed metadata writes retain the journal.
 */
export async function restoreInstall(dir: string, journal: PluginJournal, options: CoreOptions): Promise<RollbackReport> {
  try {
    await writeFileAtomic(join(dir, 'package.json'), journal.manifestBytes, { mode: 0o600 })
    if (journal.lockfileBytes === null) await rm(join(dir, 'pnpm-lock.yaml'), { force: true })
    else await writeFileAtomic(join(dir, 'pnpm-lock.yaml'), journal.lockfileBytes, { mode: 0o600 })
  } catch (error) { throw new ProfilePluginError('restore-failed', 'Could not restore profile metadata: ' + String(error)) }
  let report: RollbackReport
  try {
    const result = await options.runner(['install', '--offline', '--ignore-scripts', '--ignore-pnpmfile'], { cwd: dir, signal: options.signal })
    report = result.exitCode === 0 ? { filesRestored: true, reinstall: 'ok' }
      : { filesRestored: true, reinstall: 'failed', detail: result.stderr || result.stdout }
  } catch (error) {
    options.signal.throwIfAborted()
    report = { filesRestored: true, reinstall: 'failed', detail: String(error) }
  }
  // pnpm may rewrite a lockfile even in offline mode; metadata restoration is exact.
  try {
    await writeFileAtomic(join(dir, 'package.json'), journal.manifestBytes, { mode: 0o600 })
    if (journal.lockfileBytes === null) await rm(join(dir, 'pnpm-lock.yaml'), { force: true })
    else await writeFileAtomic(join(dir, 'pnpm-lock.yaml'), journal.lockfileBytes, { mode: 0o600 })
  } catch (error) { throw new ProfilePluginError('restore-failed', 'Could not finalize metadata restoration: ' + String(error)) }
  try {
    await clearStagedSource(dir, journal.stagedPath)
    await clearJournal(dir)
  } catch (error) { throw new ProfilePluginError('restore-failed', 'Metadata restored, but cleanup failed: ' + String(error)) }
  return report
}
/**
 * Recover a journal while the caller holds the profile lock.
 * @param dir - profile directory.
 * @param options - explicit recovery process dependencies.
 * @returns recovered state or a live-owner refusal.
 */
export async function recoverLocked(dir: string, options: CoreOptions): Promise<RecoveryOutcome> {
  const journal = await readJournal(dir)
  if (journal === null) return { kind: 'none' }
  if (ownerAlive(journal)) return { kind: 'owner-alive', pid: journal.pid }
  if (journal.op === 'remove') {
    if (journal.committedManifestBytes === undefined) throw new ProfilePluginError('restore-failed', 'Removal journal lacks its deactivated manifest.')
    await writeFileAtomic(join(dir, 'package.json'), journal.committedManifestBytes, { mode: 0o600 })
    // Metadata remains deactivated if package-manager cleanup fails.
    try {
      const removed = await options.runner(['remove', '--config.ignore-scripts=true', '--config.ignore-pnpmfile=true', '--', journal.spec], { cwd: dir, signal: options.signal })
      if (removed.exitCode === 0) await clearStagedSource(dir, journal.stagedPath)
    } catch (error) {
      options.signal.throwIfAborted()
      throw new ProfilePluginError('restore-failed', 'Removal recovery failed: ' + String(error))
    }
    await clearJournal(dir)
    return { kind: 'recovered', op: 'remove' }
  }
  if (journal.phase === 'committing' && journal.committedManifestBytes !== undefined
    && await optionalText(join(dir, 'package.json')) === journal.committedManifestBytes) {
    await clearJournal(dir)
    return { kind: 'recovered', op: 'install' }
  }
  const rollback = await restoreInstall(dir, journal, options)
  return { kind: 'recovered', op: 'install', rollback }
}

/**
 * Remove only a journaled snapshot below the profile-owned source directory.
 * @param dir - profile directory.
 * @param stagedPath - validated snapshot path, when this operation owns one.
 */
export async function clearStagedSource(dir: string, stagedPath: string | undefined): Promise<void> {
  if (stagedPath === undefined) return
  const path = await ownedSourcePath(dir, stagedPath)
  const parent = dirname(path)
  let info: Awaited<ReturnType<typeof lstat>>
  try { info = await lstat(parent) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ProfilePluginError('restore-failed', 'Plugin source root is not a real directory.')
  const physicalParent = await realpath(parent)
  if (physicalParent !== join(await realpath(dir), PLUGIN_SOURCES_DIRECTORY)) {
    throw new ProfilePluginError('restore-failed', 'Plugin source root resolves outside its profile.')
  }
  await rm(join(physicalParent, basename(path)), { recursive: true, force: true })
}
