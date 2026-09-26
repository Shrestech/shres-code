/**
 * Plugin skill install helpers over plain Node filesystem access.
 *
 * These functions own the `skills-installed` root that the filesystem
 * provider discovers at rank 700. They never touch Cordis: the CLI and the
 * host `pluginAdmin` namespace call them before (or without) a booted
 * context. Every mutation runs under the writer lock from
 * `@shres-code/shres-code-atomic-write`, copies the source into a private
 * staging directory OUTSIDE the discovered root (a sibling under the same
 * Shres home, so the publishing rename stays on one filesystem), and
 * publishes it with one atomic rename, so discovery and the watcher never
 * observe a partially copied skill or a staging directory. Removal
 * deletes only directories carrying the managed provenance file, so a
 * hand-placed or foreign directory is never destroyed.
 *
 * @module @shres-code/shres-code-skill-filesystem/install
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@shres-code/shres-code-atomic-write'
import { resolveShresHome } from '@shres-code/shres-code-home-paths'
import type { SkillSource } from '@shres-code/shres-code-skill'
import { isSkillName } from '@shres-code/shres-code-skill/name'
import { parseSkillDocument } from './parse.ts'

/** Filesystem locations the install helpers scan for already-used skill names. */
export interface SkillInstallRoots {
  /** Shres Code config root holding `skills` and `skills-installed`. */
  readonly shresHome: string
  /** Shared agent config root holding `skills`. */
  readonly agentsHome: string
  /** Project root holding `.shres/skills` and `.agents/skills`. */
  readonly projectRoot?: string
  /** Additional skill roots scanned before the user roots. */
  readonly customSkillDirs?: readonly string[]
}

/** Successful {@link addInstalledSkill} outcome. */
export interface SkillInstalled {
  readonly kind: 'installed'
  /** Frontmatter name the skill was installed under; also the directory name. */
  readonly name: string
  /** Absolute path of the installed skill directory. */
  readonly path: string
  /** Content digest of the installed tree, `sha256-<hex>`. */
  readonly digest: string
}

/** Rejected {@link addInstalledSkill} outcome. */
export interface SkillAddRefused {
  readonly kind: 'refused'
  readonly code: 'invalid-skill' | 'name-taken' | 'escaping-symlink'
  /** Human-readable reason, safe to print. */
  readonly detail: string
  /** Filesystem source that already owns the name; set for `name-taken`. */
  readonly owner?: SkillSource
}

/** Successful {@link removeInstalledSkill} outcome. */
export interface SkillRemoved {
  readonly kind: 'removed'
}

/** Rejected {@link removeInstalledSkill} outcome. */
export interface SkillRemoveRefused {
  readonly kind: 'refused'
  readonly code: 'not-installed' | 'not-managed'
}

/** One managed installed skill as reported by {@link listInstalledSkills}. */
export interface InstalledSkillInfo {
  /** Frontmatter skill name; equals the directory name. */
  readonly name: string
  /** Routing description from the installed frontmatter. */
  readonly description: string
  /** Content digest recorded at install time, `sha256-<hex>`. */
  readonly digest: string
  /** Absolute source directory the skill was copied from. */
  readonly origin: string
  /** Install timestamp, ISO-8601. */
  readonly installedAt: string
}

/** Provenance persisted as `.shres-skill.json` inside every managed skill directory. */
export interface SkillProvenance {
  /** Absolute source directory the skill was copied from. */
  readonly origin: string
  /** Content digest of the installed tree, `sha256-<hex>`. */
  readonly digest: string
  /** Install timestamp, ISO-8601. */
  readonly installedAt: string
}

const PROVENANCE_FILENAME = '.shres-skill.json'
const SKILL_DOCUMENT_FILENAME = 'SKILL.md'
const INSTALLED_DIRNAME = 'skills-installed'
/** Sibling of the installed root that holds in-progress copies; never a discovery root. */
const STAGING_DIRNAME = '.skills-installed-staging'

/**
 * Resolve the default filesystem skill roots for one working directory,
 * mirroring the provider's discovery roots: `$SHRES_HOME`/`~/.shres`,
 * `$SHRES_AGENTS_HOME`/`~/.agents`, and the nearest `.git` ancestor of
 * `cwd` (the cwd itself when no marker exists, like discovery). Custom
 * roots come from provider configuration and have no default here.
 * @param cwd - working directory used to locate the project root.
 * @returns the resolved roots for the name-taken scan and the install target.
 */
export function defaultSkillInstallRoots(cwd: string): SkillInstallRoots {
  return {
    shresHome: resolveShresHome(),
    agentsHome: resolve(process.env.SHRES_AGENTS_HOME ?? join(homedir(), '.agents')),
    projectRoot: findProjectRootSync(resolve(cwd)),
  }
}

/**
 * Install one skill directory into `<shresHome>/skills-installed/<name>`.
 * The source must be a real directory whose `SKILL.md` frontmatter names the
 * skill; the installed directory name is that frontmatter name, whatever the
 * source directory is called. The tree is copied, never linked, and symbolic
 * links are refused instead of followed, so the published tree contains only
 * real copied files. There is no force: a name already provided by any
 * filesystem root (project, custom, user, agents, or installed) is refused
 * with the owning source; runtime and bundled skills are not visible to this
 * scan and remain the caller's check. The install is atomic per directory: a
 * private staging directory is filled, stamped with provenance, and renamed
 * into place under the writer lock. A refused or failed install cleans its
 * staging directory and never touches an existing skill.
 * @param sourceDir - directory containing the `SKILL.md` to install; a
 *   symlinked source path resolves to its target first.
 * @param roots - filesystem roots for the name-taken scan and the install target.
 * @param o - optional abort signal checked between copy steps.
 * @returns the installed skill, or a refusal naming the reason and owner.
 * @throws when the signal aborts mid-install; filesystem errors outside the
 *   refusal cases (permissions, I/O) propagate.
 */
export async function addInstalledSkill(
  sourceDir: string,
  roots: SkillInstallRoots,
  o: { signal?: AbortSignal } = {},
): Promise<SkillInstalled | SkillAddRefused> {
  o.signal?.throwIfAborted()
  let source: string
  try {
    source = await realpath(resolve(sourceDir))
  } catch (error) {
    /* v8 ignore start -- Non-absence realpath failures need a platform permission or I/O fault. */
    if (isAbsentPathError(error)) {
      return refuse('invalid-skill', `source directory does not exist: ${resolve(sourceDir)}`)
    }
    throw error
    /* v8 ignore stop */
  }
  if (!(await stat(source)).isDirectory()) {
    return refuse('invalid-skill', `source is not a directory: ${source}`)
  }
  let raw: string
  try {
    raw = await readFile(join(source, SKILL_DOCUMENT_FILENAME), { encoding: 'utf8', signal: o.signal })
  } catch (error) {
    if (isAbsentPathError(error)) {
      return refuse('invalid-skill', `source has no ${SKILL_DOCUMENT_FILENAME}: ${source}`)
    }
    throw error
  }
  o.signal?.throwIfAborted()
  let document
  try {
    document = parseSkillDocument(raw)
  } catch (error) {
    return refuse('invalid-skill', errorMessage(error))
  }
  // The lock file is a sibling of the installed root, so the root must exist
  // before the lock can be taken; the directory is a valid empty state.
  await mkdir(installedRoot(roots), { recursive: true, mode: 0o700 })
  return await withFileLock(lockFilename(roots), async () => {
    for (const root of scanRoots(roots)) {
      if (await nameOccupied(root.path, document.name)) {
        return refuse(
          'name-taken',
          `${document.name} is already provided by the ${root.owner} skills at ${root.path}`,
          root.owner,
        )
      }
    }
    o.signal?.throwIfAborted()
    // The writer lock serializes installers, so anything left in the staging
    // parent belongs to an interrupted earlier install and is swept here.
    await rm(stagingRoot(roots), { recursive: true, force: true })
    await mkdir(stagingRoot(roots), { mode: 0o700 })
    const staging = join(stagingRoot(roots), randomBytes(6).toString('hex'))
    await mkdir(staging, { mode: 0o700 })
    try {
      const digest = await copySkillTree(source, staging, o.signal)
      const provenance: SkillProvenance = {
        origin: source,
        digest,
        installedAt: new Date().toISOString(),
      }
      await writeFileAtomic(join(staging, PROVENANCE_FILENAME), `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 })
      try {
        await rename(staging, join(installedRoot(roots), document.name))
      } catch (error) {
        /* v8 ignore start -- The name scan under the lock already refuses an
           existing target; this catch only bounds a lock-less writer racing
           the rename, so no test can reach it without bypassing the lock. */
        const code = (error as NodeJS.ErrnoException | null)?.code
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
        await rm(staging, { recursive: true, force: true })
        return refuse(
          'name-taken',
          `${document.name} appeared at ${join(installedRoot(roots), document.name)} during the install`,
          'installed',
        )
        /* v8 ignore stop */
      }
      return { kind: 'installed', name: document.name, path: join(installedRoot(roots), document.name), digest }
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      if (error instanceof SkillInstallRejection) return error.outcome
      throw error
    }
  })
}

/**
 * Remove one managed installed skill directory. Only a real directory inside
 * `skills-installed` that carries the install provenance file is removed; a
 * missing name is refused as not-installed, and anything this package did not
 * install — a hand-placed directory, a symbolic link, a flat file, or a
 * directory with missing or unreadable provenance — is refused as
 * not-managed and left untouched. There is no force.
 * @param name - skill name, which is the installed directory name.
 * @param roots - filesystem roots locating `skills-installed`.
 * @returns removed, or a refusal code; nothing is deleted on a refusal.
 */
export async function removeInstalledSkill(name: string, roots: SkillInstallRoots): Promise<SkillRemoved | SkillRemoveRefused> {
  if (!isSkillName(name)) return { kind: 'refused', code: 'not-installed' }
  const root = installedRoot(roots)
  if (!existsSync(root)) return { kind: 'refused', code: 'not-installed' }
  return await withFileLock(lockFilename(roots), async () => {
    const target = join(root, name)
    const info = await lstat(target).catch((error: unknown) => {
      /* v8 ignore start -- Non-absence lstat failures need a platform permission or I/O fault. */
      if (isAbsentPathError(error)) return undefined
      throw error
      /* v8 ignore stop */
    })
    if (info === undefined) return { kind: 'refused', code: 'not-installed' }
    if (info.isSymbolicLink() || !info.isDirectory()) return { kind: 'refused', code: 'not-managed' }
    if (!(await readProvenance(target))) return { kind: 'refused', code: 'not-managed' }
    await rm(target, { recursive: true })
    return { kind: 'removed' }
  })
}

/**
 * List the managed installed skills: directories inside `skills-installed`
 * that carry valid provenance, whose `SKILL.md` parses, and whose
 * frontmatter name matches the directory name, so every reported entry is
 * addressable by {@link removeInstalledSkill} and discoverable by the
 * provider. Unmanaged or broken directories are skipped rather than reported.
 * @param roots - filesystem roots locating `skills-installed`.
 * @returns managed installed skills sorted by name.
 */
export async function listInstalledSkills(roots: SkillInstallRoots): Promise<InstalledSkillInfo[]> {
  const root = installedRoot(roots)
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    /* v8 ignore start -- Non-absence readdir failures need a platform permission or I/O fault. */
    if (isAbsentPathError(error)) return undefined
    throw error
    /* v8 ignore stop */
  })
  if (entries === undefined) return []
  const skills: InstalledSkillInfo[] = []
  for (const entry of entries) {
    // A symlinked or flat entry is never a managed directory install.
    if (!entry.isDirectory()) continue
    const directory = join(root, entry.name)
    const provenance = await readProvenance(directory)
    if (provenance === undefined) continue
    let document
    try {
      document = parseSkillDocument(await readFile(join(directory, SKILL_DOCUMENT_FILENAME), { encoding: 'utf8' }))
    } catch {
      // A broken or missing skill document is not manageable catalog state.
      continue
    }
    if (document.name !== entry.name) continue
    skills.push({
      name: document.name,
      description: document.description,
      digest: provenance.digest,
      origin: provenance.origin,
      installedAt: provenance.installedAt,
    })
  }
  // Directory names are unique, so the comparator never sees equal names.
  /* v8 ignore next -- Which comparison outcomes run depends on V8's sort call order, not on this code. */
  return skills.sort((left, right) => left.name < right.name ? -1 : 1)
}

/**
 * A refusal raised mid-copy; {@link addInstalledSkill} catches it after
 * staging cleanup and returns its outcome.
 */
class SkillInstallRejection extends Error {
  constructor(readonly outcome: SkillAddRefused) {
    super(outcome.detail)
  }
}

function refuse(code: SkillAddRefused['code'], detail: string, owner?: SkillSource): SkillAddRefused {
  return owner === undefined
    ? { kind: 'refused', code, detail }
    : { kind: 'refused', code, detail, owner }
}

/** Filesystem skill sources in rank order, so the reported owner is the winner. */
function scanRoots(roots: SkillInstallRoots): { path: string; owner: SkillSource }[] {
  const scanned: { path: string; owner: SkillSource }[] = []
  if (roots.projectRoot !== undefined) {
    const projectRoot = resolve(roots.projectRoot)
    scanned.push({ path: join(projectRoot, '.shres', 'skills'), owner: 'project-shres' })
    scanned.push({ path: join(projectRoot, '.agents', 'skills'), owner: 'project-agents' })
  }
  for (const dir of roots.customSkillDirs ?? []) {
    scanned.push({ path: resolve(dir), owner: 'custom' })
  }
  scanned.push({ path: join(resolve(roots.shresHome), 'skills'), owner: 'user-shres' })
  scanned.push({ path: join(resolve(roots.agentsHome), 'skills'), owner: 'user-agents' })
  scanned.push({ path: installedRoot(roots), owner: 'installed' })
  return scanned
}

async function nameOccupied(root: string, name: string): Promise<boolean> {
  for (const candidate of [join(root, name), join(root, `${name}.md`)]) {
    const occupied = await lstat(candidate).then(
      () => true,
      (error: unknown) => {
        /* v8 ignore start -- Non-absence lstat failures need a platform permission or I/O fault. */
        if (isAbsentPathError(error)) return false
        throw error
        /* v8 ignore stop */
      },
    )
    if (occupied) return true
  }
  return false
}

/** Copy the source tree into the staging directory and return its digest. */
async function copySkillTree(source: string, staging: string, signal: AbortSignal | undefined): Promise<string> {
  const files = await collectSkillFiles(source, source, [])
  // Relative paths are unique within one tree, so equality cannot occur.
  /* v8 ignore next -- Which comparison outcomes run depends on V8's sort call order, not on this code. */
  files.sort((left, right) => left.relative < right.relative ? -1 : 1)
  // The skill document is written last, so a staging tree whose copy fails
  // midway never holds a parseable skill.
  const ordered = files.filter(file => file.relative !== SKILL_DOCUMENT_FILENAME)
  ordered.push(...files.filter(file => file.relative === SKILL_DOCUMENT_FILENAME))
  const hash = createHash('sha256')
  for (const file of ordered) {
    signal?.throwIfAborted()
    const destination = join(staging, file.relative)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    const content = await readFile(file.absolute)
    await writeFile(destination, content, { mode: 0o600 })
    hash.update(file.relative)
    hash.update('\0')
    hash.update(content)
  }
  return `sha256-${hash.digest('hex')}`
}

async function collectSkillFiles(
  root: string,
  directory: string,
  inherited: string[],
): Promise<{ relative: string; absolute: string }[]> {
  const files: { relative: string; absolute: string }[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    const segments = [...inherited, entry.name]
    if (entry.isSymbolicLink()) {
      throw new SkillInstallRejection(refuse(
        'escaping-symlink',
        `symbolic link ${segments.join('/')} inside ${root} is not copied; installed skills contain only real files`,
      ))
    }
    if (entry.isDirectory()) {
      files.push(...await collectSkillFiles(root, absolute, segments))
      continue
    }
    /* v8 ignore start -- Non-file, non-directory entries (FIFOs, sockets) are
       platform-specific and have no JavaScript creation API. */
    if (entry.isFile()) {
      files.push({ relative: segments.join('/'), absolute })
      continue
    }
    throw new SkillInstallRejection(refuse(
      'invalid-skill',
      `${segments.join('/')} inside ${root} is neither a file nor a directory`,
    ))
    /* v8 ignore stop */
  }
  return files
}

async function readProvenance(directory: string): Promise<SkillProvenance | undefined> {
  let raw: string
  try {
    raw = await readFile(join(directory, PROVENANCE_FILENAME), { encoding: 'utf8' })
  } catch {
    // No readable provenance file means this directory is not install-managed.
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.origin !== 'string'
    || typeof record.digest !== 'string'
    || typeof record.installedAt !== 'string') {
    return undefined
  }
  return { origin: record.origin, digest: record.digest, installedAt: record.installedAt }
}

function installedRoot(roots: SkillInstallRoots): string {
  return join(resolve(roots.shresHome), INSTALLED_DIRNAME)
}

function stagingRoot(roots: SkillInstallRoots): string {
  return join(resolve(roots.shresHome), STAGING_DIRNAME)
}

function lockFilename(roots: SkillInstallRoots): string {
  return join(installedRoot(roots), '.lock')
}

function findProjectRootSync(start: string): string {
  let current = start
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return start
    current = parent
  }
}

function isAbsentPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function errorMessage(error: unknown): string {
  return String(error)
}
