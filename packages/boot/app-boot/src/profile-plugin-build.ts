/**
 * Build-declaring package trees in a profile's node_modules, digested before
 * and after one managed `pnpm add` so the transaction can tell which
 * build-capable package trees it added or changed. Inspection reads files
 * only: it imports no package code, runs no scripts, and never follows a
 * symbolic link inside a package tree; manifests and files are type-checked
 * before they are read. The checks do not make a concurrently modified tree
 * race-free.
 * @module @shres-code/shres-code-app-boot/profile-plugin-build
 */

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

/** Scripts pnpm would run for an installed dependency; their presence marks a package as build-declaring. */
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const

/** Bytes read per file chunk while digesting; files are streamed, never read whole. */
const CHUNK_BYTES = 64 * 1024

const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  scripts: z.record(z.string(), z.unknown()).optional(),
}).loose()

/** One build-declaring package tree and the digest of its contents. */
export interface BuildTree {
  /** `name@version` from the tree's manifest. */
  readonly id: string
  /** SHA-256 over the tree's sorted entries, file contents, and link targets, excluding its root `node_modules`. */
  readonly digest: string
}

/** Build-declaring package trees keyed by their real directory path. */
export type BuildTrees = ReadonlyMap<string, BuildTree>

/**
 * A package tree that inspection refuses to read: a special file (FIFO,
 * socket, device) inside a build-declaring tree, or an entry that changed
 * type while it was read.
 */
export class BuildTreeRejection extends Error {}

/**
 * Collect every build-declaring package tree under a profile's
 * `node_modules`: hoisted, nested, scoped, and `.pnpm` store layouts, each
 * real directory once. A package is build-declaring when its manifest names
 * a lifecycle script or its root holds `binding.gyp`.
 * @param profileDir - the profile directory whose `node_modules` is inspected.
 * @param signal - aborts the walk between entries and file chunks.
 * @returns build-declaring trees keyed by real directory path.
 * @throws {BuildTreeRejection} for a special file inside a build-declaring tree; the abort reason on abort.
 */
export async function collectBuildTrees(profileDir: string, signal: AbortSignal): Promise<BuildTrees> {
  const trees = new Map<string, BuildTree>()
  const seen = new Set<string>()

  async function visitModules(path: string): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries.sort()) {
      signal.throwIfAborted()
      if (entry === '.pnpm') {
        for (const bucket of (await readdir(join(path, entry), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!bucket.isDirectory() && !bucket.isSymbolicLink()) continue
          await visitModules(bucket.name === 'node_modules'
            ? join(path, entry, bucket.name)
            : join(path, entry, bucket.name, 'node_modules'))
        }
      } else if (entry.startsWith('@')) {
        await visitModules(join(path, entry))
      } else if (!entry.startsWith('.')) {
        await visitPackage(join(path, entry))
      }
    }
  }

  async function visitPackage(path: string): Promise<void> {
    let resolved: string
    try {
      resolved = await realpath(path)
    } catch (error) {
      // A dangling package link names no installed tree.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (seen.has(resolved)) return
    seen.add(resolved)
    if (!(await stat(resolved)).isDirectory()) return
    const manifest = await buildManifest(resolved)
    if (manifest !== undefined) {
      trees.set(resolved, { id: manifest.name + '@' + manifest.version, digest: await digestTree(resolved, signal) })
    }
    await visitModules(join(resolved, 'node_modules'))
  }

  await visitModules(join(profileDir, 'node_modules'))
  return trees
}

/**
 * The build-declaring trees a transaction added or changed: a real path
 * absent before, or present with a different digest. Moving an unchanged
 * tree to a new path counts as added, so relocation over-refuses rather than
 * missing a build.
 * @param before - trees collected before `pnpm add`.
 * @param after - trees collected after `pnpm add`.
 * @returns sorted, unique `name@version` ids of added or changed build-declaring trees.
 */
export function changedBuildTrees(before: BuildTrees, after: BuildTrees): string[] {
  const changed = new Set<string>()
  for (const [path, tree] of after) {
    if (before.get(path)?.digest !== tree.digest) changed.add(tree.id)
  }
  return [...changed].sort()
}

/**
 * The manifest of a build-declaring package, or undefined for a directory
 * without one. The manifest is checked with lstat before it is read, so a
 * linked (including dangling) or special-file manifest is rejected instead of
 * followed or opened.
 */
async function buildManifest(directory: string): Promise<z.infer<typeof manifestSchema> | undefined> {
  const text = await readPlainManifest(directory)
  if (text === undefined) return undefined
  const manifest = manifestSchema.parse(JSON.parse(text))
  const scripts = manifest.scripts ?? {}
  if (LIFECYCLE_SCRIPTS.some(key => key in scripts)) return manifest
  try {
    await lstat(join(directory, 'binding.gyp'))
    return manifest
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Read a package root's `package.json` only when it is a regular file.
 * @param directory - the package root.
 * @returns the manifest text, or undefined when the package has no manifest.
 * @throws {BuildTreeRejection} when the manifest is a symbolic link (even a dangling one) or not a regular file.
 */
export async function readPlainManifest(directory: string): Promise<string | undefined> {
  const path = join(directory, 'package.json')
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!info.isFile()) throw new BuildTreeRejection(`${path} is a symbolic link or not a regular file`)
  return readFile(path, 'utf8')
}

/**
 * Digest one package tree: every entry in sorted relative-path order, each
 * regular file's streamed bytes, each symbolic link's target text (never
 * followed), excluding only the tree's own root `node_modules`.
 */
async function digestTree(root: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  async function walk(directory: string, relative: string): Promise<void> {
    const entries = (await readdir(directory)).sort()
    for (const entry of entries) {
      signal.throwIfAborted()
      if (relative === '' && entry === 'node_modules') continue
      const path = join(directory, entry)
      const rel = relative === '' ? entry : relative + '/' + entry
      const info = await lstat(path)
      if (info.isSymbolicLink()) {
        hash.update('L\0' + rel + '\0' + await readlink(path) + '\0')
      } else if (info.isDirectory()) {
        hash.update('D\0' + rel + '\0')
        await walk(path, rel)
      } else if (info.isFile()) {
        // A per-file content digest keeps entry boundaries unambiguous.
        hash.update('F\0' + rel + '\0' + await hashFile(path, rel, signal) + '\0')
      } else {
        throw new BuildTreeRejection(`${root}: ${rel} is not a regular file, directory, or symbolic link`)
      }
    }
  }
  await walk(root, '')
  return hash.digest('hex')
}

/**
 * Digest one regular file by streaming it in bounded chunks. The file is opened without
 * following a link and without blocking, then re-checked, so a path swapped
 * for a FIFO or link after the directory listing is refused rather than read.
 */
async function hashFile(path: string, rel: string, signal: AbortSignal): Promise<string> {
  // Managed installation refuses Windows before inspection, so the POSIX flags are defined.
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  let handle
  try {
    handle = await open(path, flags)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new BuildTreeRejection(`${rel} changed to a symbolic link while it was read`)
    throw error
  }
  try {
    if (!(await handle.stat()).isFile()) throw new BuildTreeRejection(`${rel} changed to a special file while it was read`)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
    for (;;) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}
