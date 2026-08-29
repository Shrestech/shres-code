/**
 * Durable remote-alias registry persisted at `$SHRES_HOME/remote/remotes.json`
 * (path explicit at call time). Single-writer serialized through
 * `withFileLock`, committed with `writeFileAtomic` at mode 0600/0700, and
 * schema-validated on every read: unknown on-disk formats fail loud.
 * @module @shres-code/shres-code-host-remote-control
 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic, withFileLock } from '@shres-code/shres-code-atomic-write'
import type { RemoteEntry, RemoteId, RemoteTarget } from './types.ts'
import { RemoteControlError } from './errors.ts'

/** Current on-disk registry schema version; bumped only with a format break. */
export const REGISTRY_VERSION = 1

/**
 * Validate an alias and brand it; the registry is a durable file boundary, so
 * charset validation re-runs on every read entry.
 * @param alias - candidate alias.
 * @returns the branded remote id.
 */
export function asRemoteId(alias: string): RemoteId {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(alias)) {
    throw new RemoteControlError('invalid-alias', `invalid remote alias "${alias}": use lowercase letters, digits, and dashes, starting with a letter or digit`)
  }
  return alias as RemoteId
}

/**
 * Validate and brand a `user@host` connect target.
 * @param target - candidate target string.
 * @returns the branded remote target.
 */
export function asRemoteTarget(target: string): RemoteTarget {
  if (!/^[A-Za-z0-9._~-]+@[A-Za-z0-9._-]+$/.test(target)) {
    throw new RemoteControlError('invalid-target', `invalid remote target "${target}": expected user@host`)
  }
  return target as RemoteTarget
}

/**
 * Validate the remote daemon port.
 * @param port - candidate port number.
 * @returns the same port.
 */
export function asRemotePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RemoteControlError('invalid-port', `invalid daemon port ${String(port)}: expected 1..65535`)
  }
  return port
}

/**
 * Load and validate the registry; a missing file is an empty registry.
 * @param path - registry file path.
 * @returns parsed entries keyed by alias.
 */
export async function loadRegistry(path: string): Promise<Map<RemoteId, RemoteEntry>> {
  let raw: string | null = null
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    // A registry path that cannot be read unlike a fresh miss must surface: IO failure is not emptiness.
    throw new RemoteControlError('registry-corrupt', `cannot read remote registry at ${path}: ${String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new RemoteControlError('registry-corrupt', `remote registry at ${path} is not valid JSON; refusing to guess`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new RemoteControlError('registry-corrupt', `remote registry at ${path} is not a registry document`)
  }
  const document = parsed as { version?: unknown; entries?: unknown }
  if (document.version !== REGISTRY_VERSION) {
    throw new RemoteControlError('registry-corrupt', `remote registry at ${path} declares schema version ${String(document.version)}; this build reads version ${String(REGISTRY_VERSION)}`)
  }
  if (!Array.isArray(document.entries)) {
    throw new RemoteControlError('registry-corrupt', `remote registry at ${path} has no entries array`)
  }
  const entries = new Map<RemoteId, RemoteEntry>()
  for (const candidate of document.entries) {
    const entry = validateEntry(candidate)
    if (entry === null) continue
    if (entries.has(entry.id)) {
      throw new RemoteControlError('registry-corrupt', `remote registry at ${path} declares alias "${entry.id}" twice`)
    }
    entries.set(entry.id, entry)
  }
  return entries
}

/**
 * Validate one parsed registry candidate against the durable schema.
 * @param candidate - untyped parsed value.
 * @returns the entry, or `null` for a malformed (corrupt) entry.
 */
function validateEntry(candidate: unknown): RemoteEntry | null {
  if (typeof candidate !== 'object' || candidate === null) return null
  const record = candidate as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : null
  const target = typeof record.target === 'string' ? record.target : null
  const remotePort = record.remotePort
  if (id === null || target === null || typeof remotePort !== 'number') return null
  try {
    const fingerprint = record.fingerprint === null || typeof record.fingerprint === 'string' ? record.fingerprint as string | null : null as string | null
    const createdAt = typeof record.createdAt === 'string' ? record.createdAt : null
    const lastConnectedAt = record.lastConnectedAt === null || typeof record.lastConnectedAt === 'string' ? record.lastConnectedAt as string | null : null
    if (createdAt === null) return null
    return {
      id: asRemoteId(id),
      target: asRemoteTarget(target),
      remotePort: asRemotePort(remotePort),
      version: REGISTRY_VERSION,
      fingerprint,
      createdAt,
      lastConnectedAt,
    }
  } catch {
    return null
  }
}

/**
 * Commit the registry atomically under the portlock-or-file lock; corrupt
 * knowledge never overwrites the file.
 * @param path - registry file path.
 * @param entries - complete next entry set.
 */
export async function saveRegistry(path: string, entries: Map<RemoteId, RemoteEntry>): Promise<void> {
  const content = JSON.stringify({ version: REGISTRY_VERSION, entries: [...entries.values()] } satisfies RegistryFile, null, 2) + '\n'
  try {
    await withFileLock(`${path}.lock`, async () => writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 }))
  } catch (error) {
    if (error instanceof RemoteControlError) throw error
    throw new RemoteControlError('registry-corrupt', `cannot write remote registry at ${path}: ${String(error)}`)
  }
}

/** On-disk registry document. */
export interface RegistryFile {
  /** Schema version; readers reject other values. */
  version: number
  /** All alias entries. */
  entries: RemoteEntry[]
}

/**
 * Validate every writable field of an entry at its write operation, so a bad
 * caller value never reaches the file.
 * @param entry - candidate entry.
 * @returns the same entry after validation.
 */
function validateEntryStrict(entry: RemoteEntry): RemoteEntry {
  const id = asRemoteId(entry.id)
  const target = asRemoteTarget(entry.target)
  const remotePort = asRemotePort(entry.remotePort)
  return { ...entry, id, target, remotePort }
}

/**
 * Insert or replace one entry under a read-modify-write lock that reloads
 * current state first, so two `remote add` calls never lose each other.
 * @param path - registry file path.
 * @param entry - entry to persist (replaces by id).
 */
export async function upsertEntry(path: string, entry: RemoteEntry): Promise<void> {
  const validated = validateEntryStrict(entry)
  await withFileLock(`${path}.lock`, async () => {
    const current = await loadRegistry(path)
    current.set(validated.id, validated)
    await writeFileAtomic(path, JSON.stringify({ version: REGISTRY_VERSION, entries: [...current.values()] } satisfies RegistryFile, null, 2) + '\n', { mode: 0o600, dirMode: 0o700 })
  })
}

/**
 * Remove one alias under the same read-modify-write lock as insert.
 * @param path - registry file path.
 * @param id - alias to remove.
 * @returns true when an entry was removed.
 */
export async function removeEntry(path: string, id: RemoteId): Promise<boolean> {
  return withFileLock(`${path}.lock`, async () => {
    const current = await loadRegistry(path)
    if (!current.delete(id)) return false
    await writeFileAtomic(path, JSON.stringify({ version: REGISTRY_VERSION, entries: [...current.values()] } satisfies RegistryFile, null, 2) + '\n', { mode: 0o600, dirMode: 0o700 })
    return true
  })
}
