/**
 * Install packed tarballs into a throwaway consumer outside the repository and
 * drive the installed executable with plain Node.
 *
 * Every tarball the installed tree needs comes from `--from`, so the only
 * registry traffic is for external dependencies. That matters beyond hermetic
 * verification: the harness packages declare the vendored framework as a peer,
 * those packages live in another release sequence, and this job must not depend
 * on the registry already carrying versions that match — one pull request may
 * bump both families before either publishes — so a shres verification passes the
 * vendored family's pack output too, while publishing only its own
 * ([rationale](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)).
 *
 * What this proves is that `files` selected a complete payload, that the
 * published dependency ranges resolve, that the installed executable starts, and
 * that each dependency carrying a prebuilt binary imports its native module. A
 * source build is never the proof: with the platform package missing the deferred
 * koffi script compiles and fails, and with it present the import is what
 * establishes the binary loads. A workspace link or a stale `lib/` in the
 * checkout cannot stand in for a missing file.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { readManifest, releaseFamily } from './families.ts'
import { capture, isEntry } from './process.ts'
import { packedIdentity } from './tarball.ts'

/**
 * Dependencies whose prebuilt binary arrives as an optional platform package,
 * leaving them to compile from source when optional packages are omitted.
 *
 * A listed dependency must load its native module while its own entry evaluates,
 * which is what {@link loadPrebuiltBinaries} exercises: koffi calls `wrapNative`
 * at module scope. One that defers the load to first use makes that check
 * vacuous and needs a native call of its own instead.
 */
const PREBUILT_BINARY_DEPENDENCIES: readonly string[] = ['koffi']

/**
 * A version a platform package can be installed at exactly: no range, tag, or
 * wildcard, because the prebuilt binary has to match the dependency already in
 * the tree.
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

/**
 * Flags every install in the throwaway consumer carries: no audit or funding
 * traffic, no lockfile, no optional packages (the Landlock platform packages need
 * a musl toolchain per architecture), and no build scripts while the prebuilt
 * binary packages are still absent.
 */
const INSTALL_FLAGS: readonly string[] = [
  '--no-audit',
  '--no-fund',
  '--package-lock=false',
  '--omit=optional',
  '--ignore-scripts',
]

/**
 * Flags for the one command that runs the deferred build scripts. Those scripts
 * belong to third-party registry dependencies pulled while the ranges resolve, not
 * to the payloads this repository publishes, and the earlier single `npm install`
 * ran all of them without asking, so this is not a new exposure.
 *
 * It does override a hardening policy an operator may have configured (deny
 * entries or `strict-allow-scripts`), which is what the `dangerously-` prefix
 * concedes on a throwaway tree built once and deleted. npm warns that unknown
 * options stop working in a future major, so a runner whose npm predates this
 * flag fails then, not now.
 */
const REBUILD_FLAGS: readonly string[] = ['--dangerously-allow-all-scripts']

/**
 * Environment for the installed artifact: no host Node hooks, no host DeepSeek
 * Harness home, and no ambient npm user agent that would confuse npm.
 *
 * Dropping `NODE_PATH` and `NODE_OPTIONS` is also load-bearing for the load check:
 * an inherited module path would let a child resolve the checkout's own packages
 * instead of the installed tree it is meant to exercise.
 * @param consumerRoot - the throwaway consumer directory.
 * @returns The child environment.
 */
function consumerEnvironment(consumerRoot: string): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  delete environment.npm_config_user_agent
  delete environment.NPM_CONFIG_USER_AGENT
  delete environment.NODE_OPTIONS
  delete environment.NODE_PATH
  environment.SHRES_HOME = resolve(consumerRoot, '.shres')
  environment.SHRES_AGENTS_HOME = resolve(consumerRoot, '.agents')
  environment.SHRES_TELEMETRY_DISABLED = '1'
  return environment
}

/**
 * Every packed tarball in the given directories, as `file:` dependency entries.
 *
 * The directories are read by their contents rather than a pack order file: a
 * directory here can hold tarballs packed only to satisfy a cross-sequence
 * dependency, which no release order describes.
 * @param directories - absolute directories holding packed tarballs.
 * @returns Package name to tarball file URL, and the version each carries.
 */
function packedDependencies(directories: readonly string[]): Map<string, { url: string; version: string }> {
  const dependencies = new Map<string, { url: string; version: string }>()
  for (const directory of directories) {
    const tarballs = readdirSync(directory).filter(name => name.endsWith('.tgz')).sort()
    if (tarballs.length === 0) throw new Error(`${directory} holds no packed tarball`)
    for (const filename of tarballs) {
      const tarball = join(directory, filename)
      const { name, version } = packedIdentity(tarball)
      dependencies.set(name, { url: pathToFileURL(tarball).href, version })
    }
  }
  return dependencies
}

/**
 * The host key that platform packages are suffixed with, such as `linux-x64`.
 * @param platform - Node platform identifier; exists so tests can drive another host.
 * @param arch - Node architecture identifier; exists so tests can drive another host.
 * @returns The suffixed key.
 */
export function hostPlatformKey(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`
}

/** One prebuilt binary package and the version its dependency pins it to. */
export interface PrebuiltBinaryPackage {
  /** Package name, such as `@koromix/koffi-linux-x64`. */
  readonly name: string
  /** Version the dependency declares for that package. */
  readonly version: string
}

/**
 * Installs of one dependency nested under another package, relative to the
 * consumer root. A tree can carry a second resolved version there, and the
 * packages next to it load that copy.
 * @param consumerRoot - the throwaway consumer directory.
 * @param dependency - package name of the dependency.
 * @returns Each nested manifest path found, relative to the consumer root.
 */
function nestedManifests(consumerRoot: string, dependency: string): readonly string[] {
  const modules = join(consumerRoot, 'node_modules')
  if (!existsSync(modules)) return []
  const found: string[] = []
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const owners = entry.name.startsWith('@')
      ? readdirSync(join(modules, entry.name), { withFileTypes: true })
        .filter(scoped => scoped.isDirectory())
        .map(scoped => join(entry.name, scoped.name))
      : [entry.name]
    for (const owner of owners) {
      const relative = join('node_modules', owner, 'node_modules', ...dependency.split('/'), 'package.json')
      if (existsSync(join(consumerRoot, relative))) found.push(relative)
    }
  }
  return found
}

/**
 * Read one installed dependency's manifest from the top level of the tree.
 *
 * An absent top-level manifest has two causes: the packed payload does not carry
 * the dependency at all, which needs no prebuilt binary, or the dependency sits
 * only under another package, where this script cannot read the version to match.
 * The second cause fails loud instead of leaving the tree to a source build.
 * @param consumerRoot - the throwaway consumer directory.
 * @param dependency - package name of the dependency.
 * @returns The parsed manifest, or undefined when the tree does not carry the dependency.
 * @throws {Error} when the dependency is installed only below another package, when the
 *   file holds no JSON object, or when reading it fails for any reason other than absence.
 */
function dependencyManifest(consumerRoot: string, dependency: string): Record<string, unknown> | undefined {
  const path = join(consumerRoot, 'node_modules', ...dependency.split('/'), 'package.json')
  try {
    return readManifest(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const nested = nestedManifests(consumerRoot, dependency)
  if (nested.length > 0) {
    throw new Error(`${dependency} is installed only under ${nested.join(', ')}; its prebuilt binary package must match the top-level version`)
  }
  return undefined
}

/**
 * Choose the prebuilt binary package one installed dependency declares for the
 * host, reading the names and versions from its own `optionalDependencies`.
 * @param dependency - package name the manifest belongs to, for diagnostics.
 * @param manifest - the dependency's parsed manifest.
 * @param platformKey - host key the package name must end with.
 * @returns The matching package name and its exact declared version.
 * @throws {Error} when `optionalDependencies` is not an object, when the declared version
 *   is not exact, or when the dependency declares no package for this host.
 */
export function prebuiltBinaryPackage(
  dependency: string,
  manifest: Readonly<Record<string, unknown>>,
  platformKey: string,
): PrebuiltBinaryPackage {
  const declared = manifest['optionalDependencies']
  if (declared === undefined) {
    throw new Error(`installed ${dependency} declares no prebuilt binary package for ${platformKey}`)
  }
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
    throw new Error(`installed ${dependency} declares optionalDependencies that is not an object`)
  }
  for (const [name, version] of Object.entries(declared as Record<string, unknown>)) {
    if (!name.endsWith(`-${platformKey}`)) continue
    if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
      throw new Error(`${dependency} declares ${name} as ${JSON.stringify(version)}, which is not the exact version that binary was built for`)
    }
    return { name, version }
  }
  throw new Error(`installed ${dependency} declares no prebuilt binary package for ${platformKey}`)
}

/** Inputs for {@link restorePrebuiltBinaries}. */
export interface PrebuiltBinaryRestore {
  /** The throwaway consumer directory whose installed tree is repaired. */
  readonly consumerRoot: string
  /** Runs one npm command line in that directory; the caller owns cwd, environment, and failure handling. */
  readonly npm: (args: readonly string[]) => void
  /** Host key the platform package must match; defaults to this process's. */
  readonly platformKey?: string
  /** Dependencies to repair; defaults to `PREBUILT_BINARY_DEPENDENCIES`. */
  readonly dependencies?: readonly string[]
}

/**
 * Install, for each dependency the tree carries that needs one, the prebuilt
 * binary platform package that the optional-package omission left behind, at the
 * exact version that dependency declares.
 *
 * The install skips build scripts too, so it only places files; the caller runs
 * the deferred scripts with `npm rebuild` once the binaries are in place.
 * @param restore - consumer tree, npm invocation, and the host and dependencies to match.
 * @returns The package specifications installed, in install order.
 * @throws {Error} when a carried dependency declares no usable package for this host.
 */
export function restorePrebuiltBinaries(restore: PrebuiltBinaryRestore): readonly string[] {
  const platformKey = restore.platformKey ?? hostPlatformKey()
  const installed: string[] = []
  for (const dependency of restore.dependencies ?? PREBUILT_BINARY_DEPENDENCIES) {
    const manifest = dependencyManifest(restore.consumerRoot, dependency)
    if (manifest === undefined) continue
    const { name, version } = prebuiltBinaryPackage(dependency, manifest, platformKey)
    const spec = `${name}@${version}`
    restore.npm(['install', ...INSTALL_FLAGS, spec])
    installed.push(spec)
  }
  return installed
}

/** Inputs for {@link loadPrebuiltBinaries}. */
export interface PrebuiltBinaryLoad {
  /** The throwaway consumer directory whose tree is exercised. */
  readonly consumerRoot: string
  /** Runs one node command line in that directory; the caller owns cwd, environment, and failure handling. */
  readonly node: (args: readonly string[]) => void
  /** Dependencies to load; defaults to `PREBUILT_BINARY_DEPENDENCIES`. */
  readonly dependencies?: readonly string[]
}

/**
 * Load each dependency the tree carries in a child process, which imports it and
 * therefore the native module its platform package supplies.
 *
 * The installed executable's `--version` never touches a native module that a
 * package loads on first use, so a tree with a missing or foreign-architecture
 * binary would otherwise pass. A dependency that compares its own version with
 * the loaded module's, as koffi does, also fails here when the platform package
 * was published at another version.
 * @param load - consumer tree, node invocation, and the dependencies to load.
 * @returns The dependencies loaded, in order.
 * @throws {Error} when a dependency the tree carries cannot be imported, which a missing or mismatched native module always prevents.
 */
export function loadPrebuiltBinaries(load: PrebuiltBinaryLoad): readonly string[] {
  const loaded: string[] = []
  for (const dependency of load.dependencies ?? PREBUILT_BINARY_DEPENDENCIES) {
    if (dependencyManifest(load.consumerRoot, dependency) === undefined) continue
    load.node(['--input-type=module', '-e', `await import(${JSON.stringify(dependency)})`])
    loaded.push(dependency)
  }
  return loaded
}

/** One packed-consumer verification run over an installed tree. */
export interface ConsumerInstallRun {
  /** Directory holding the installed consumer tree. */
  readonly consumerRoot: string
  /** Package that carries the executable. */
  readonly packageName: string
  /** Path to the executable inside that package. */
  readonly binPath: string
  /** Version the packed tarball of that package carries. */
  readonly expectedVersion: string
  /** npm invocation in the consumer directory. */
  readonly npm: (args: readonly string[]) => string
  /** node invocation in the consumer directory. */
  readonly node: (args: readonly string[]) => string
  /** Dependencies whose prebuilt binary arrives as an optional platform package; defaults to `PREBUILT_BINARY_DEPENDENCIES`. */
  readonly dependencies?: readonly string[]
  /** Host key override; defaults to this process's. */
  readonly platformKey?: string
}

/**
 * Install the consumer tree, restore its prebuilt binaries, run the deferred
 * scripts, exercise those binaries, and prove the installed executable reports the
 * packed version.
 *
 * The repair install runs before `npm rebuild`, so build scripts never see a
 * dependency whose prebuilt binary package is still missing.
 * @param run - the installed-tree inputs and the command invocations.
 * @returns The version the installed executable reports.
 * @throws {Error} when a prebuilt binary cannot be matched or loaded, or when the executable reports another version.
 */
export function verifyConsumerInstall(run: ConsumerInstallRun): string {
  const dependencies = run.dependencies ?? PREBUILT_BINARY_DEPENDENCIES
  const platformKey = run.platformKey ?? hostPlatformKey()
  run.npm(['install', ...INSTALL_FLAGS])
  for (const spec of restorePrebuiltBinaries({ consumerRoot: run.consumerRoot, npm: run.npm, platformKey, dependencies })) {
    console.log(`release verify-packed-install: installed prebuilt binary package ${spec}`)
  }
  run.npm(['rebuild', ...REBUILD_FLAGS])
  for (const dependency of loadPrebuiltBinaries({ consumerRoot: run.consumerRoot, node: run.node, dependencies })) {
    console.log(`release verify-packed-install: loaded ${dependency}`)
  }
  const bin = join(run.consumerRoot, 'node_modules', ...run.packageName.split('/'), run.binPath)
  const version = run.node([bin, '--version'])
  if (version !== run.expectedVersion) {
    throw new Error(`installed ${run.packageName} --version reported ${JSON.stringify(version)}, expected ${run.expectedVersion}`)
  }
  return version
}

/** Install every tarball under `--from` and drive the `--family` entry. */
function main(): void {
  const { values } = parseArgs({
    options: { family: { type: 'string' }, from: { type: 'string', multiple: true } },
    allowPositionals: false,
  })
  if (values.family === undefined || values.from === undefined || values.from.length === 0) {
    throw new Error('usage: verify-packed-install.ts --family <shres|vendor> --from <packed directory> [--from ...]')
  }

  const family = releaseFamily(values.family)
  const entry = family.installedEntry
  if (entry === undefined) {
    console.log(`release verify-packed-install: family ${family.id} publishes no executable, nothing to drive`)
    return
  }

  const root = process.cwd()
  const packed = packedDependencies(values.from.map(directory => resolve(root, directory)))
  const expected = packed.get(entry.packageName)
  if (expected === undefined) throw new Error(`${entry.packageName} is not among the packed tarballs`)

  const consumerRoot = mkdtempSync(join(tmpdir(), `shres-packed-${family.id}-`))
  try {
    writeFileSync(join(consumerRoot, 'package.json'), `${JSON.stringify({
      name: `shres-packed-install-${family.id}`,
      version: '0.0.0',
      private: true,
      dependencies: Object.fromEntries([...packed].map(([name, entryPacked]) => [name, entryPacked.url])),
    }, null, 2)}\n`)

    const environment = consumerEnvironment(consumerRoot)
    const npm = (args: readonly string[]): string => capture('npm', args, { cwd: consumerRoot, env: environment })
    const node = (args: readonly string[]): string => capture(process.execPath, args, { cwd: consumerRoot, env: environment })
    console.log(`release verify-packed-install: installing ${String(packed.size)} tarball(s) into ${consumerRoot}`)
    // Optional dependencies are omitted: the Landlock platform packages behind
    // them need a musl toolchain and one build per architecture, and a consumer
    // that cannot install them must still start — which is what optional means
    // here. Their entry package is a plain dependency of shres-sandbox-local, so
    // its tarball is supplied through --from.
    //
    // Build scripts wait as well, because that omission also removes koffi's
    // prebuilt platform packages: without one, koffi's install script compiles
    // the addon from source, which the runner's C++ toolchain rejects, and npm
    // rolls the failed tree back before the prebuilt package could be added.
    const version = verifyConsumerInstall({
      consumerRoot,
      packageName: entry.packageName,
      binPath: entry.binPath,
      expectedVersion: expected.version,
      npm,
      node,
    })
    console.log(`release verify-packed-install: installed ${entry.packageName} reports ${version}`)
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true })
  }
}

if (isEntry(import.meta.url)) main()
