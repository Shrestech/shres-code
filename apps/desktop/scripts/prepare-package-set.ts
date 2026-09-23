/** Select the workspace package closure a desktop target installs, and record the tarball digests the setup step verifies. */

import { createHash } from 'node:crypto'
import {
  constants,
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  PRIVATE_DESKTOP_PACKAGE_ENTRIES,
  releaseFamily,
  tarballName,
  type ReleaseMember,
} from '../../../scripts/release/families.ts'
import { run } from '../../../scripts/release/process.ts'
import { packedIdentity, tarballFiles } from '../../../scripts/release/tarball.ts'
import { resolveDesktopTargetBuildPaths, type DesktopTargetBuildPaths } from './desktop-build-paths.ts'

/** Diagnostic prefix on every failure and progress line this step emits. */
const NAME = 'shres desktop'

/** Repository root the workspace manifests and packed members are resolved against. */
const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..')

/** Descriptor naming every tarball of a package set, written beside its tarball directory. */
export const DESKTOP_PACKAGE_SET_FILE = 'desktop-packages.json'

/** Package-set directory holding the tarballs the descriptor names. */
export const DESKTOP_PACKAGES_DIR = 'desktop-packages'

/** Private package whose tarball must carry the host entry and patch the packaged tree boots. */
const HOST_PACKAGE = '@shres-code/shres-code-desktop-host'

/** Package closures the packaged runtime tree needs: the shres CLI application, its private host, and the landlock launcher. */
const CLOSURE_ROOTS: readonly string[] = [
  '@shres-code/shres-code',
  '@shres-code/shres-code-desktop-host',
  '@shres-code/node-addon-landlock-run',
]

/** Package-relative host files without which the packaged profile cannot boot: the child entry, and the patch it loads beside itself. */
const HOST_RUNTIME_FILES: readonly string[] = ['lib/index.js', 'config/desktop.cordis.patch.yml']

/** Manifests no release family covers; these packages join the closure as workspace members. */
const FAMILY_FREE_MANIFEST_GLOBS: readonly string[] = [
  'native/landlock-run/packages/*/package.json',
  `${PRIVATE_DESKTOP_PACKAGE_ENTRIES.host.directory}/package.json`,
]

/** Dependency sections every selected member must resolve inside the closure. */
const REQUIRED_DEPENDENCY_SECTIONS: readonly string[] = ['dependencies', 'peerDependencies']

/** Dependency section whose packages join the closure when the workspace carries them. */
const OPTIONAL_DEPENDENCY_SECTION = 'optionalDependencies'

/** Scope of the workspace packages a desktop build packs; any other scope resolves from a registry. */
const WORKSPACE_SCOPE = '@shres-code/'

/** Release families whose manifests describe the packable workspace. */
const RELEASE_FAMILIES: readonly string[] = ['shres', 'vendor']

/** One tarball of a desktop package set. */
export interface DesktopPackageRecord {
  /** Package name the tarball declares. */
  readonly name: string
  /** Package version the tarball declares. */
  readonly version: string
  /** Tarball file name inside {@link DESKTOP_PACKAGES_DIR}. */
  readonly file: string
  /** Tarball size in bytes. */
  readonly bytes: number
  /** `sha512` subresource integrity of the tarball bytes. */
  readonly integrity: string
}

/** Descriptor the setup step installs and verifies, with packages in package-name order. */
export interface DesktopPackageSet {
  /** Descriptor format revision the setup step understands. */
  readonly schemaVersion: 1
  /** Every tarball of this package set. */
  readonly packages: readonly DesktopPackageRecord[]
}

/**
 * Read one manifest as a JSON object.
 * @param path - absolute manifest path.
 * @returns the parsed manifest.
 */
function readManifest(path: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${NAME}: failed to read ${path}: ${String(error)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${NAME}: ${path} is not a JSON object`)
  }
  return value as Record<string, unknown>
}

/**
 * Index every packable workspace manifest by package name.
 * @returns members keyed by package name, including the packages no release family covers.
 */
function workspaceCatalog(): Map<string, ReleaseMember> {
  const catalog = new Map<string, ReleaseMember>()
  for (const family of RELEASE_FAMILIES) {
    for (const member of releaseFamily(family).members(REPOSITORY_ROOT)) {
      if (catalog.has(member.name)) throw new Error(`${NAME}: ${member.name} belongs to two release families`)
      catalog.set(member.name, member)
    }
  }
  for (const manifestPath of FAMILY_FREE_MANIFEST_GLOBS.flatMap(pattern => (
    globSync(pattern, { cwd: REPOSITORY_ROOT })
  )).sort()) {
    const manifest = readManifest(join(REPOSITORY_ROOT, manifestPath))
    const name = manifest.name
    const version = manifest.version
    if (typeof name !== 'string' || name === '' || typeof version !== 'string') {
      throw new Error(`${NAME}: ${manifestPath} declares no package identity`)
    }
    if (catalog.has(name)) throw new Error(`${NAME}: ${name} appears twice in the workspace catalog`)
    catalog.set(name, {
      directory: manifestPath.slice(0, manifestPath.length - '/package.json'.length),
      name,
      version,
      manifest,
    })
  }
  return catalog
}

/**
 * List one manifest's dependencies in a section.
 * @param manifest - the manifest to read.
 * @param section - dependency section name.
 * @returns dependency names, sorted; empty when the section is absent.
 */
function dependencyNames(manifest: Readonly<Record<string, unknown>>, section: string): string[] {
  const value = manifest[section]
  if (value === undefined) return []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${NAME}: ${String(manifest.name)} has an invalid ${section} section`)
  }
  return Object.keys(value).sort()
}

/**
 * Whether one manifest platform restriction admits this build host.
 * A restriction lists platform names; a negated entry is rejected rather than approximated, because it needs package-manager semantics.
 * @param value - the manifest's `os` or `cpu` field.
 * @param candidates - build-host names the field selects among.
 * @param field - field name, reported when the restriction cannot be read.
 * @returns true when the field is absent or lists a candidate.
 */
function admitsHost(value: unknown, candidates: readonly string[], field: string): boolean {
  if (value === undefined) return true
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (typeof entry !== 'string' || entry.startsWith('!')) {
      throw new Error(`${NAME}: unsupported ${field} restriction ${JSON.stringify(entry)}`)
    }
    if (candidates.includes(entry)) return true
  }
  return false
}

/**
 * Whether the package manager installs one package on this build host.
 * @param manifest - candidate manifest, whose optional `os` and `cpu` fields restrict platforms.
 * @returns true when the package is installable here.
 */
function installsOnBuildHost(manifest: Readonly<Record<string, unknown>>): boolean {
  return admitsHost(manifest.os, [process.platform], 'os') && admitsHost(manifest.cpu, [process.arch], 'cpu')
}

/**
 * Select the complete available workspace dependency closure the packaged runtime tree needs.
 * An optional dependency whose manifest excludes this build host stays out of the closure,
 * because the package manager installs no payload for it either.
 * @param available - packable workspace members keyed by package name.
 * @returns selected members sorted by package name.
 */
export function selectDesktopPackageClosure(available: ReadonlyMap<string, ReleaseMember>): ReleaseMember[] {
  const selected = new Map<string, ReleaseMember>()
  const visit = (name: string): void => {
    if (selected.has(name)) return
    const member = available.get(name)
    if (member === undefined) throw new Error(`${NAME}: packable workspace members omit required package ${name}`)
    selected.set(name, member)
    for (const section of REQUIRED_DEPENDENCY_SECTIONS) {
      for (const dependency of dependencyNames(member.manifest, section)) {
        if (available.has(dependency)) visit(dependency)
        else if (dependency.startsWith(WORKSPACE_SCOPE)) {
          throw new Error(`${NAME}: ${name} requires unpackable workspace package ${dependency}`)
        }
      }
    }
    for (const dependency of dependencyNames(member.manifest, OPTIONAL_DEPENDENCY_SECTION)) {
      const optional = available.get(dependency)
      if (optional !== undefined && installsOnBuildHost(optional.manifest)) visit(dependency)
    }
  }
  for (const root of CLOSURE_ROOTS) visit(root)
  return [...selected.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Require every private host file the shell needs before a packaged profile can boot.
 * @param files - tarball paths rooted at `package/`.
 * @returns nothing; throws when a required file is absent.
 */
export function assertDesktopHostRuntimeFiles(files: readonly string[]): void {
  const available = new Set(files)
  const missing = HOST_RUNTIME_FILES.map(file => `package/${file}`).filter(file => !available.has(file))
  if (missing.length > 0) {
    throw new Error(`${NAME}: ${HOST_PACKAGE} tarball omits required file(s): ${missing.join(', ')}`)
  }
}

/**
 * The packed directory holding one member's tarball.
 * @param paths - paths owned by the selected release target.
 * @param member - the packed member.
 * @returns the target's packed directory for that member's part of the workspace.
 */
function packedDirectoryOf(paths: DesktopTargetBuildPaths, member: ReleaseMember): string {
  if (member.directory.startsWith('vendor/')) return paths.packedVendor
  if (member.directory.startsWith('native/')) return paths.packedLandlock
  return paths.packedDsh
}

/**
 * Pack the runtime closure into the target's packed directories.
 * @param paths - paths owned by the selected release target.
 * @returns the packed closure in package-name order.
 */
export function packDesktopPackageClosure(paths: DesktopTargetBuildPaths): ReleaseMember[] {
  const selected = selectDesktopPackageClosure(workspaceCatalog())
  for (const directory of [paths.packedDsh, paths.packedVendor, paths.packedLandlock]) {
    rmSync(directory, { recursive: true, force: true })
    mkdirSync(directory, { recursive: true })
  }
  for (const member of selected) {
    const destination = packedDirectoryOf(paths, member)
    run('pnpm', ['--dir', member.directory, 'pack', '--pack-destination', destination], { cwd: REPOSITORY_ROOT })
    const tarball = join(destination, tarballName(member))
    if (!existsSync(tarball)) throw new Error(`${NAME}: ${member.name} produced no tarball at ${tarball}`)
  }
  return selected
}

/**
 * Copy one packed member's tarball into the package set and measure it.
 * @param paths - paths owned by the selected release target.
 * @param member - the packed member.
 * @param packageDirectory - directory receiving the tarball.
 * @returns the descriptor record for the copied tarball.
 */
function copyDesktopPackage(
  paths: DesktopTargetBuildPaths,
  member: ReleaseMember,
  packageDirectory: string,
): DesktopPackageRecord {
  const source = join(packedDirectoryOf(paths, member), tarballName(member))
  const identity = packedIdentity(source)
  if (identity.name !== member.name || identity.version !== member.version) {
    throw new Error(`${NAME}: ${basename(source)} declares ${identity.name}@${identity.version}, expected ${member.name}@${member.version}`)
  }
  const destination = join(packageDirectory, basename(source))
  copyFileSync(source, destination, constants.COPYFILE_EXCL)
  const body = readFileSync(destination)
  return {
    name: identity.name,
    version: identity.version,
    file: basename(destination),
    bytes: statSync(destination).size,
    integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
  }
}

/**
 * Prepare one target's package set: pack the closure, copy its tarballs, and write the descriptor.
 * @param paths - paths owned by the selected release target.
 * @param output - directory receiving the descriptor and its tarball directory.
 * @returns the written package set.
 */
export function prepareDesktopPackageSet(paths: DesktopTargetBuildPaths, output: string): DesktopPackageSet {
  const selected = packDesktopPackageClosure(paths)
  const host = selected.find(member => member.name === HOST_PACKAGE)
  if (host === undefined) throw new Error(`${NAME}: the selected closure omits ${HOST_PACKAGE}`)
  assertDesktopHostRuntimeFiles(tarballFiles(join(packedDirectoryOf(paths, host), tarballName(host))))
  rmSync(output, { recursive: true, force: true })
  const packageDirectory = join(output, DESKTOP_PACKAGES_DIR)
  mkdirSync(packageDirectory, { recursive: true })
  const packages = selected.map(member => copyDesktopPackage(paths, member, packageDirectory))
  const packageSet: DesktopPackageSet = { schemaVersion: 1, packages }
  writeFileSync(join(output, DESKTOP_PACKAGE_SET_FILE), `${JSON.stringify(packageSet, undefined, 2)}\n`, { mode: 0o600 })
  return packageSet
}

/** Prepare the selected target's package set from its own packed directories. */
function main(): void {
  const paths = resolveDesktopTargetBuildPaths()
  const { values } = parseArgs({ options: { out: { type: 'string' } }, allowPositionals: false })
  const output = values.out === undefined ? paths.packageSet : resolve(REPOSITORY_ROOT, values.out)
  const packageSet = prepareDesktopPackageSet(paths, output)
  console.log(`${NAME}: ${String(packageSet.packages.length)} tarball(s) recorded in ${join(output, DESKTOP_PACKAGE_SET_FILE)}`)
}

if (import.meta.main) {
  try {
    main()
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
