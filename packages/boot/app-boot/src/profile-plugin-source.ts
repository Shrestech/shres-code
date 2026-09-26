/**
 * Stage a local plugin source directory as a private copy before pnpm sees it.
 * pnpm installs a `file:` directory by hard-linking the original files, so a
 * later edit to the source would change the installed plugin without another
 * install or consent. Copying first, into a caller-owned path the transaction
 * journal already records, breaks that link. Staging only copies and reads
 * `package.json` files: it imports no code and runs no scripts.
 * @module @shres-code/shres-code-app-boot/profile-plugin-source
 */

import { cp, lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import npa from 'npm-package-arg'
import { z } from 'zod'

/** Directory names never copied, at any depth: VCS metadata and installed dependencies. */
const EXCLUDED_NAMES = new Set(['.git', 'node_modules'])

/** Dependency sections pnpm installs for a package; dev and peer dependencies are not installed from a dependency. */
const INSTALLED_SECTIONS = ['dependencies', 'optionalDependencies'] as const

/** Spec prefixes that make pnpm follow a live path instead of copying it. */
const LIVE_PATH_PREFIXES = ['link:', 'portal:', 'workspace:']

/** A staged copy's package identity. */
export interface StagedSource {
  kind: 'staged'
  /** Validated package name from the copied manifest. */
  name: string
  /** Validated exact semver version from the copied manifest. */
  version: string
}

/**
 * Why a source cannot be installed as a self-contained copy: `link-spec` for
 * links, special files, live-path or out-of-tree dependencies, and a staging
 * path inside the source; `invalid-spec` for a missing, unparsable, or
 * invalid package manifest.
 */
export interface SourceRefused {
  kind: 'refused'
  refusal: { code: 'link-spec' | 'invalid-spec'; detail: string }
}

const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
}).loose()

/** Thrown inside the copy filter and the validators to end staging with a refusal. */
class SourceRejection extends Error {
  constructor(message: string, readonly code: SourceRefused['refusal']['code'] = 'link-spec') {
    super(message)
  }
}

function refused(detail: string, code: SourceRefused['refusal']['code'] = 'link-spec'): SourceRefused {
  return { kind: 'refused', refusal: { code, detail } }
}

/** Whether `path` is `root` itself or lies below it. */
function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Refuse anything but a regular file or directory, without following links or opening special files. */
async function requirePlainEntry(path: string, display: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new SourceRejection(`${display} is a symbolic link; plugin sources must contain only regular files and directories`)
  if (!info.isFile() && !info.isDirectory()) throw new SourceRejection(`${display} is not a regular file or directory`)
}

/** Re-check the copied tree: the source may have changed while it was being copied. */
async function validateCopiedTree(root: string, directory: string, signal: AbortSignal): Promise<void> {
  for (const entry of await readdir(directory)) {
    signal.throwIfAborted()
    const path = join(directory, entry)
    await requirePlainEntry(path, relative(root, path))
    if ((await lstat(path)).isDirectory()) await validateCopiedTree(root, path, signal)
  }
}

/** Read and validate one copied manifest; the name and version must be what pnpm would accept. */
async function readManifest(directory: string, display: string): Promise<z.infer<typeof manifestSchema>> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  } catch (error) {
    throw new SourceRejection(`${display}/package.json is missing or not JSON: ${String(error)}`, 'invalid-spec')
  }
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) throw new SourceRejection(`${display}/package.json needs string name and version fields`, 'invalid-spec')
  const { name, version } = parsed.data
  let identity: npa.Result
  try {
    identity = npa(`${name}@${version}`)
  } catch (error) {
    throw new SourceRejection(`${display}/package.json has an invalid name or version: ${String(error)}`, 'invalid-spec')
  }
  if (identity.name !== name || identity.type !== 'version') {
    throw new SourceRejection(`${display}/package.json needs a valid package name and an exact semver version`, 'invalid-spec')
  }
  return parsed.data
}

/**
 * Walk the installed dependency sections of one copied manifest. Registry,
 * alias, git, and remote specs are allowed; local directories and tarballs
 * must resolve inside the staged tree, and local directories are walked in
 * turn; live-path protocols and unparseable specs are refused.
 */
async function validateDependencies(
  root: string, directory: string, visited: Set<string>, signal: AbortSignal,
): Promise<z.infer<typeof manifestSchema>> {
  const display = relative(root, directory) || '.'
  const manifest = await readManifest(directory, display)
  visited.add(directory)
  for (const section of INSTALLED_SECTIONS) {
    for (const [dependency, spec] of Object.entries(manifest[section] ?? {})) {
      signal.throwIfAborted()
      const where = `${display}/package.json ${section}.${dependency}`
      if (LIVE_PATH_PREFIXES.some(prefix => spec.startsWith(prefix))) {
        throw new SourceRejection(`${where} uses "${spec}", a live path that pnpm links instead of copying`)
      }
      let parsed: npa.Result
      try {
        parsed = npa.resolve(dependency, spec, directory)
      } catch (error) {
        throw new SourceRejection(`${where} has an unsupported spec "${spec}": ${String(error)}`)
      }
      if (parsed.type !== 'directory' && parsed.type !== 'file') continue
      const target = resolve(String(parsed.fetchSpec))
      if (!within(root, target)) {
        throw new SourceRejection(`${where} points at ${spec}, outside the plugin directory`)
      }
      if (parsed.type === 'directory' && !visited.has(target)) {
        await validateDependencies(root, target, visited, signal)
      }
    }
  }
  return manifest
}

/**
 * Copy one local plugin directory to `stagedPath` and validate the copy.
 * The copy skips `.git` and `node_modules` at any depth and never follows
 * links; a symbolic link or special file anywhere in the copied tree refuses
 * the source. The copied root manifest and every in-tree `file:` dependency
 * reached through `dependencies` or `optionalDependencies` must name only
 * registry, alias, git, remote, or in-tree local specs.
 * @param sourcePath - the operator's local plugin directory; a link to a directory is resolved first.
 * @param stagedPath - absent caller-owned destination recorded in the transaction journal; the caller
 *   removes it on refusal, failure, or abort.
 * @param signal - aborts staging; the partial copy stays for the caller to remove.
 * @returns the staged package identity, or a refusal naming the offending entry.
 * @throws the abort reason when `signal` aborts, or filesystem errors other than the refusal cases.
 */
export async function stagePluginSource(
  sourcePath: string, stagedPath: string, signal: AbortSignal,
): Promise<StagedSource | SourceRefused> {
  signal.throwIfAborted()
  const source = await realpath(resolve(sourcePath))
  if (!(await lstat(source)).isDirectory()) return refused(`${sourcePath} is not a directory`)
  const staged = resolve(stagedPath)
  const stagedParent = await realpath(dirname(staged))
  if (within(source, join(stagedParent, basename(staged)))) {
    return refused(`the staging path ${stagedPath} lies inside the plugin directory ${source}`)
  }
  const existing = await lstat(staged).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (existing !== undefined) throw new Error(`staging path ${stagedPath} already exists; stage into a fresh path`)
  try {
    await cp(source, staged, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
      // The filter sees each entry before it is opened, so a FIFO or socket is
      // refused here instead of blocking the copy on a read.
      filter: async (path) => {
        signal.throwIfAborted()
        if (path !== source && EXCLUDED_NAMES.has(basename(path))) return false
        await requirePlainEntry(path, relative(source, path) || '.')
        return true
      },
    })
    signal.throwIfAborted()
    await validateCopiedTree(staged, staged, signal)
    const manifest = await validateDependencies(staged, staged, new Set(), signal)
    return { kind: 'staged', name: manifest.name, version: manifest.version }
  } catch (error) {
    if (error instanceof SourceRejection) return refused(error.message, error.code)
    throw error
  }
}
