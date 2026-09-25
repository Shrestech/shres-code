/**
 * Safe archive extraction for pinned BrowserSkill artifacts, plus the hashing
 * helpers the verification chain shares. The guarantee is stated exactly:
 *
 * - Artifact bytes are fixed by the pinned hash and verified before extraction.
 * - The zip is extracted with `fflate.unzipSync` from memory. fflate's unzip
 *   API exposes no file attributes, so symlink HEADERS are not refused. The
 *   guarantee is instead that fflate never CREATES symlinks: every entry is
 *   written as a regular file under the target, and absolute, `..`,
 *   duplicate, and overlong names are refused. A pin-time test asserts the
 *   pinned zip contains no symlink entries, so a new pin cannot add one.
 * - The tar archive is extracted through the tar filter, which REFUSES
 *   `SymbolicLink`, `Link`, absolute, and `..` entries, allows only
 *   regular files and benign directory entries, and bounds the extracted
 *   total.
 * - `computeTreeDigest` hashes an unpacked tree the same way the manifest
 *   pin was computed: regular files only, links and special files refused.
 *
 * @module @shres-code/shres-code-browserskill/runtime/extract
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

/** Longest single archive entry name accepted. */
const MAX_ENTRY_NAME_LENGTH = 200

/** Refused archive content: the entry name or layout violates the extraction guarantee. */
export class UnsafeArchiveError extends Error {
  constructor(message: string) {
    super(`browserskill extract: ${message}`)
    this.name = 'UnsafeArchiveError'
  }
}

/**
 * SHA-256 of a file's bytes, read once.
 * @param path - file to hash.
 * @returns the lowercase hex digest.
 */
export async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/**
 * SHA-256 of in-memory bytes.
 * @param bytes - content to hash.
 * @returns the lowercase hex digest.
 */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Validate one archive entry name: relative, forward-slash, unique, bounded. */
function assertSafeEntryName(name: string, seen: Set<string>): void {
  if (name.length === 0 || name.length > MAX_ENTRY_NAME_LENGTH) {
    throw new UnsafeArchiveError(`entry name length out of range: ${JSON.stringify(name.slice(0, 64))}`)
  }
  if (name.startsWith('/') || name.includes('\\')) {
    throw new UnsafeArchiveError(`absolute or Windows-path entry refused: ${JSON.stringify(name.slice(0, 64))}`)
  }
  const parts = name.split('/')
  if (parts.includes('..')) {
    throw new UnsafeArchiveError(`parent-traversing entry refused: ${JSON.stringify(name.slice(0, 64))}`)
  }
  if (seen.has(name)) {
    throw new UnsafeArchiveError(`duplicate entry refused: ${JSON.stringify(name.slice(0, 64))}`)
  }
  seen.add(name)
}

/** Result of a successful extraction. */
export interface ExtractionResult {
  /** Relative paths of the regular files written, in archive order. */
  files: readonly string[]
  /** Sum of uncompressed entry bytes written. */
  totalBytes: number
}

/**
 * Extract a zip from memory into `destDir`. Directory entries become
 * directories; every other entry is written as a regular file (mode 0600) —
 * fflate never creates symlinks, and names that could escape the target are
 * refused before anything is written.
 * @param bytes - the verified archive bytes.
 * @param destDir - existing or creatable target directory.
 * @param maxTotalBytes - upper bound on the sum of uncompressed entry sizes.
 * @returns the written files and their total byte count.
 * @throws UnsafeArchiveError on an unsafe or duplicate name or an over-bound archive.
 */
export async function extractZipArchive(bytes: Uint8Array, destDir: string, maxTotalBytes: number): Promise<ExtractionResult> {
  // The archive libraries load lazily: the hashing and validation helpers in
  // this module stay usable in processes that never extract.
  const { unzipSync } = await import('fflate')
  const seen = new Set<string>()
  let total = 0
  const entries = unzipSync(bytes, {
    filter: (entry) => {
      assertSafeEntryName(entry.name, seen)
      total += entry.originalSize
      if (total > maxTotalBytes) throw new UnsafeArchiveError(`archive expands past ${maxTotalBytes} bytes`)
      return true
    },
  })
  const files: string[] = []
  for (const [name, content] of Object.entries(entries)) {
    const target = resolve(destDir, name)
    // Unlike tar, zip carries no entry types: every entry is extracted as a
    // file, so a root-resolving name ('.' or './') cannot be honored as a
    // benign directory and is refused, as is anything outside the target.
    if (target === resolve(destDir) || !target.startsWith(resolve(destDir) + sep)) {
      throw new UnsafeArchiveError(`entry at or outside the target root refused: ${JSON.stringify(name.slice(0, 64))}`)
    }
    if (name.endsWith('/')) {
      await mkdir(target, { recursive: true, mode: 0o700 })
      continue
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, content, { mode: 0o600 })
    files.push(name)
  }
  return { files, totalBytes: total }
}

/**
 * Extract a tar.gz archive into `destDir`, refusing every entry type that can
 * carry a link or escape the target: `SymbolicLink`, `Link`, absolute paths,
 * and `..` segments. Regular files are written with the tar library's own
 * writer under `strict: true`; benign directory entries are created. The
 * summed size of the file entries must stay within `maxTotalBytes`, checked
 * before each file is written.
 * @param archivePath - path of the verified archive file.
 * @param destDir - existing target directory.
 * @param maxTotalBytes - upper bound on the sum of extracted file sizes.
 * @returns the written files and their total byte count.
 * @throws UnsafeArchiveError on a refused entry type or path or an over-bound archive.
 */
export async function extractTarArchive(archivePath: string, destDir: string, maxTotalBytes: number): Promise<ExtractionResult> {
  const { x: tarExtract } = await import('tar')
  const files: string[] = []
  let totalBytes = 0
  let refusal: string | undefined
  // A filter throw escapes the tar parser's data pump as an uncaught
  // exception instead of rejecting the extraction promise, so a refused
  // entry is recorded and skipped here, and the refusal is thrown once the
  // extraction has settled. The refused entry is never written.
  const refuse = (message: string): false => {
    refusal ??= message
    return false
  }
  await tarExtract({
    file: archivePath,
    cwd: destDir,
    strict: true,
    filter: (name, entry) => {
      // The tar filter hands a ReadEntry for extraction decisions; the 'in'
      // guard narrows the declared Stats | ReadEntry union at the boundary.
      /* v8 ignore next -- tar.x always hands a ReadEntry; the guard only narrows the declared union */
      if (!('type' in entry)) {
        return refuse(`tar filter received a stat without an entry type: ${JSON.stringify(name.slice(0, 64))}`)
      }
      if (entry.type !== 'File' && entry.type !== 'Directory') {
        return refuse(`non-regular tar entry refused (${entry.type}): ${JSON.stringify(name.slice(0, 64))}`)
      }
      try {
        assertSafeEntryName(name, new Set())
      } catch (error) {
        return refuse((error as Error).message)
      }
      const target = resolve(destDir, name)
      const atRoot = target === resolve(destDir)
      // A directory entry may claim the target root itself ('./'); a file
      // entry at the root would replace it, and nothing may land outside.
      if (atRoot ? entry.type !== 'Directory' : !target.startsWith(resolve(destDir) + sep)) {
        return refuse(`entry escaped or replaced the target: ${JSON.stringify(name.slice(0, 64))}`)
      }
      if (entry.type === 'File') {
        totalBytes += entry.size
        if (totalBytes > maxTotalBytes) {
          return refuse(`archive expands past ${maxTotalBytes} bytes`)
        }
        files.push(name)
      }
      return true
    },
  })
  if (refusal !== undefined) throw new UnsafeArchiveError(refusal)
  return { files, totalBytes }
}

/**
 * Locate the single executable file an extracted CLI archive must contain.
 * @param files - relative paths returned by an extractor.
 * @returns the sole entry.
 * @throws UnsafeArchiveError when the archive does not hold exactly one file.
 */
export function soleFile(files: readonly string[]): string {
  if (files.length !== 1) {
    throw new UnsafeArchiveError(`expected exactly one file in the CLI archive, got ${files.length}`)
  }
  return (files as readonly [string])[0]
}

/** The artifact tree could not be hashed: it holds a link or special file, or is unreadable. */
export class ArtifactTreeError extends Error {
  constructor(message: string) {
    super(`browserskill artifact tree: ${message}`)
    this.name = 'ArtifactTreeError'
  }
}

/**
 * Compute the integrity digest of an unpacked artifact tree, with the exact
 * record format the manifest pin was computed from: each regular file
 * contributes `<posix-relative-path> NUL <sha256> newline`, records sorted
 * by the UTF-8 bytes of the POSIX-relative paths (Unicode code-point order;
 * no locale), and the digest is the SHA-256 of that concatenation. Directory entries
 * contribute nothing. A symbolic link or special file anywhere in the tree
 * refuses the digest — the tree is then unverified, never partially trusted.
 *
 * The walk verifies contents, not exclusivity: a same-user mutation after
 * this returns is residual, which is why every launch re-verifies.
 * @param dir - the unpacked tree root.
 * @returns the lowercase hex digest.
 * @throws ArtifactTreeError when the tree holds a link or special file, or cannot be read.
 */
export async function computeTreeDigest(dir: string): Promise<string> {
  const records: { path: string; sha256: string }[] = []
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(relative === '' ? dir : join(dir, relative), { withFileTypes: true })
    for (const entry of entries) {
      const childPath = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isSymbolicLink()) {
        throw new ArtifactTreeError(`symbolic link refused in the artifact tree: ${childPath}`)
      }
      if (entry.isFile()) {
        records.push({ path: childPath, sha256: await sha256File(join(dir, childPath)) })
      } else if (entry.isDirectory()) {
        await walk(childPath)
      } else {
        throw new ArtifactTreeError(`special file refused in the artifact tree: ${childPath}`)
      }
    }
  }
  await walk('')
  // Readdir yields unique paths, so byte comparison is a strict total order
  // (UTF-8 byte order matches code-point order, no locale involvement).
  records.sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')))
  const digest = createHash('sha256')
  for (const record of records) digest.update(`${record.path}\0${record.sha256}\n`)
  return digest.digest('hex')
}
