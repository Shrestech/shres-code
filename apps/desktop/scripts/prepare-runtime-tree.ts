/**
 * Builds the self-contained production runtime used by the packaged desktop app.
 *
 * The runtime is installed from the package-set tarballs produced by
 * `prepare-package-set.ts`. Keeping this install isolated from the repository
 * workspace prevents development-only packages and links from reaching the
 * shipped application.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import * as yaml from 'js-yaml'

import {
  resolveDesktopBuildTarget,
  resolveDesktopTargetBuildPaths,
} from './desktop-build-paths.ts'
import {
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  type DesktopPackageSet,
} from './prepare-package-set.ts'
import { desktopRuntimeFileExclusion } from './runtime-file-policy.ts'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../..')
const TREE_BYTE_CAP = 6 * 1024 ** 3
const TREE_FILE_CAP = 150_000
const DISK_HEADROOM_BYTES = TREE_BYTE_CAP
const SUBPROCESS_LOCAL_PACKAGE = '@shres-code/shres-code-subprocess-local'
const REQUIRED_MEMBERS = [
  '@shres-code/shres-code',
  '@shres-code/shres-code-desktop-host',
] as const
const REQUIRED_PACKAGES = [
  '@shres-code/shres-code-base',
  '@shres-code/shres-code-browser-bundle',
  '@shres-code/shres-code-web-app',
  '@shres-code/shres-code-web-frontend',
] as const
const REQUIRED_FILES = [
  'node_modules/@shres-code/shres-code-desktop-host/lib/index.js',
  'node_modules/@shres-code/shres-code/package.json',
  'node_modules/@shres-code/shres-code/config/agent-presets',
  'node_modules/@shres-code/shres-code-desktop-host/config/desktop.cordis.patch.yml',
  'node_modules/@shres-code/shres-code-web-frontend/dist/index.html',
] as const

interface PackageManifest {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

interface TreeBudget {
  bytes: number
  files: number
}

interface WorkspacePolicy {
  allowBuilds?: Record<string, boolean>
  patchedDependencies?: Record<string, string>
}

/**
 * Reads the build policy from the repository workspace file.
 */
function readWorkspacePolicy(): WorkspacePolicy {
  const value = yaml.load(readFileSync(join(REPOSITORY_ROOT, 'pnpm-workspace.yaml'), 'utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pnpm-workspace.yaml must contain a mapping')
  }
  const policy = value as WorkspacePolicy
  if (policy.allowBuilds === undefined || policy.patchedDependencies === undefined) {
    throw new Error('pnpm-workspace.yaml must define allowBuilds and patchedDependencies')
  }
  return policy
}

/**
 * Returns the integrity digest used by the package-set descriptor.
 */
function packageIntegrity(path: string): string {
  return `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`
}

/**
 * Loads and validates the package-set descriptor created by the preceding
 * packaging step. A missing descriptor is an error rather than a reason to
 * silently rebuild or reuse an older package set.
 */
function readPackageSet(paths: ReturnType<typeof resolveDesktopTargetBuildPaths>): DesktopPackageSet {
  const descriptorPath = join(paths.packageSet, DESKTOP_PACKAGE_SET_FILE)
  if (!existsSync(descriptorPath)) {
    throw new Error(
      `missing ${descriptorPath}; run the desktop prepare:packages step before prepare:runtime-tree`,
    )
  }

  let value: unknown
  try {
    value = JSON.parse(readFileSync(descriptorPath, 'utf8'))
  } catch (error) {
    throw new Error(`invalid ${descriptorPath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (typeof value !== 'object' || value === null) {
    throw new Error(`invalid ${descriptorPath}: expected an object`)
  }
  const candidate = value as { schemaVersion?: unknown; packages?: unknown }
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.packages) || candidate.packages.length === 0) {
    throw new Error(`invalid ${descriptorPath}: expected schemaVersion 1 and a non-empty package list`)
  }

  const seen = new Set<string>()
  for (const item of candidate.packages) {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`invalid ${descriptorPath}: package records must be objects`)
    }
    const record = item as {
      name?: unknown
      version?: unknown
      file?: unknown
      bytes?: unknown
      integrity?: unknown
    }
    const bytes = record.bytes
    if (
      typeof record.name !== 'string' ||
      typeof record.version !== 'string' ||
      typeof record.file !== 'string' ||
      typeof bytes !== 'number' ||
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      typeof record.integrity !== 'string'
    ) {
      throw new Error(`invalid ${descriptorPath}: malformed package record`)
    }
    if (seen.has(record.name)) {
      throw new Error(`invalid ${descriptorPath}: duplicate package ${record.name}`)
    }
    seen.add(record.name)

    const tarballPath = join(paths.packageSet, DESKTOP_PACKAGES_DIR, record.file)
    if (!existsSync(tarballPath)) {
      throw new Error(`package-set tarball is missing: ${tarballPath}`)
    }
    const size = statSync(tarballPath).size
    if (size !== bytes) {
      throw new Error(
        `package-set tarball size changed for ${record.name}: expected ${bytes}, found ${size}`,
      )
    }
    const integrity = packageIntegrity(tarballPath)
    if (integrity !== record.integrity) {
      throw new Error(`package-set tarball integrity changed for ${record.name}`)
    }
  }

  return candidate as DesktopPackageSet
}

/**
 * Copies the package-set tarballs into the isolated install workspace.
 */
function copyPackageSet(
  paths: ReturnType<typeof resolveDesktopTargetBuildPaths>,
  packageSet: DesktopPackageSet,
  staging: string,
): void {
  const destination = join(staging, DESKTOP_PACKAGES_DIR)
  mkdirSync(destination, { recursive: true })
  for (const record of packageSet.packages) {
    copyFileSync(
      join(paths.packageSet, DESKTOP_PACKAGES_DIR, record.file),
      join(destination, record.file),
    )
  }
}

/**
 * Copies patched dependency files referenced by the workspace policy.
 */
function copyWorkspacePatches(staging: string, patches: Readonly<Record<string, string>>): void {
  for (const relativePath of Object.values(patches)) {
    const source = join(REPOSITORY_ROOT, relativePath)
    if (!existsSync(source)) {
      throw new Error(`workspace patch is missing: ${relativePath}`)
    }
    const destination = join(staging, relativePath)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
  }
}

/**
 * Writes the isolated workspace manifest using the repository's build policy.
 */
function writeStagingWorkspace(packageSet: DesktopPackageSet, staging: string): void {
  const dependencies = Object.fromEntries(
    packageSet.packages.map(record => [record.name, `file:./${DESKTOP_PACKAGES_DIR}/${record.file}`]),
  )
  writeFileSync(
    join(staging, 'package.json'),
    `${JSON.stringify(
      {
        name: '@shres-code/desktop-runtime',
        private: true,
        dependencies,
      },
      null,
      2,
    )}\n`,
  )

  const policy = readWorkspacePolicy()
  const localRecord = packageSet.packages.find(record => record.name === SUBPROCESS_LOCAL_PACKAGE)
  const allowBuilds = Object.fromEntries(
    Object.entries(policy.allowBuilds ?? {})
      .filter(([name]) => !name.startsWith(`${SUBPROCESS_LOCAL_PACKAGE}@file:`) || localRecord !== undefined)
      .map(([name, value]) => [
        localRecord === undefined
          ? name
          : name.replace(
            `${SUBPROCESS_LOCAL_PACKAGE}@file:packages/subprocess/subprocess-local`,
            `${SUBPROCESS_LOCAL_PACKAGE}@file:${DESKTOP_PACKAGES_DIR}/${localRecord.file}`,
          ),
        value,
      ]),
  )
  const patchedDependencies = policy.patchedDependencies ?? {}
  copyWorkspacePatches(staging, patchedDependencies)

  const overrides = Object.fromEntries(
    packageSet.packages.map(record => [record.name, `file:./${DESKTOP_PACKAGES_DIR}/${record.file}`]),
  )
  const workspace = yaml.dump({
    nodeLinker: 'hoisted',
    autoInstallPeers: true,
    allowBuilds,
    patchedDependencies,
    overrides,
  })
  writeFileSync(join(staging, 'pnpm-workspace.yaml'), workspace)
}

/**
 * Rejects repository links in the generated lockfile. The runtime must be
 * installable from the copied tarballs without access to the source tree.
 */
function assertLockfileClosure(lockfile: string): void {
  for (const [index, line] of lockfile.split(/\r?\n/u).entries()) {
    if (line.includes('@shres-code/') && /(https?:\/\/|\blink:|\bworkspace:)/u.test(line)) {
      throw new Error(`desktop runtime lockfile contains a non-packed source reference at line ${index + 1}`)
    }
  }
}

/**
 * Removes package-manager metadata and files that are not needed at runtime.
 */
function pruneNodeModules(
  nodeModules: string,
  target: { readonly platform: NodeJS.Platform; readonly arch: string },
): void {
  if (!existsSync(nodeModules)) throw new Error(`missing installed node_modules: ${nodeModules}`)
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const relativePath = relative(nodeModules, path)
      const isDirectory = entry.isDirectory() && !entry.isSymbolicLink()
      if (desktopRuntimeFileExclusion(relativePath, target, isDirectory) !== undefined) {
        if (entry.isSymbolicLink()) unlinkSync(path)
        else rmSync(path, { recursive: true, force: true })
      } else if (isDirectory) {
        walk(path)
      }
    }
  }
  walk(nodeModules)
}

/**
 * Finds every link left in the staged tree. Links are rejected instead of
 * rewritten so a package with an unexpected layout cannot escape the closure.
 */
function censusSymlinks(root: string): string[] {
  const links: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        links.push(path)
      } else if (entry.isDirectory()) {
        visit(path)
      }
    }
  }
  visit(root)
  return links
}

/**
 * Checks that the installed first-party dependency graph and required bundles
 * are present before the tree is promoted to the runtime directory.
 */
function assertClosureInvariants(nodeModules: string, staging: string): void {
  const scopeDirectory = join(nodeModules, '@shres-code')
  const installed = new Set(readdirSync(scopeDirectory))
  for (const name of REQUIRED_MEMBERS) {
    if (!installed.has(name.slice('@shres-code/'.length))) {
      throw new Error(`desktop runtime is missing ${name}`)
    }
  }
  for (const name of REQUIRED_PACKAGES) {
    if (!installed.has(name.slice('@shres-code/'.length))) {
      throw new Error(`desktop runtime is missing ${name}`)
    }
  }

  for (const packageName of installed) {
    if (packageName.startsWith('.')) continue
    const manifestPath = join(scopeDirectory, packageName, 'package.json')
    if (!existsSync(manifestPath)) throw new Error(`desktop runtime package is missing ${manifestPath}`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest
    for (const dependency of [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]) {
      if (dependency.startsWith('@shres-code/')) {
        const dependencyPath = join(nodeModules, dependency, 'package.json')
        if (!existsSync(dependencyPath)) {
          throw new Error(`${packageName} references absent packed dependency ${dependency}`)
        }
      }
    }
  }

  for (const entry of ['.pnpm', '.bin', '.modules.yaml', '.pnpm-workspace-state-v1.json']) {
    if (existsSync(join(nodeModules, entry))) {
      throw new Error(`desktop runtime retains package-manager residue ${entry}`)
    }
  }

  for (const relativePath of REQUIRED_FILES) {
    if (!existsSync(join(staging, relativePath))) {
      throw new Error(`desktop runtime is missing required file ${relativePath}`)
    }
  }
}

/**
 * Counts the staged tree and rejects unexpectedly large or numerous runtimes.
 */
function assertTreeBudget(root: string): TreeBudget {
  const budget: TreeBudget = { bytes: 0, files: 0 }
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`desktop runtime contains a link: ${path}`)
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      budget.files += 1
      budget.bytes += statSync(path).size
      if (budget.files > TREE_FILE_CAP || budget.bytes > TREE_BYTE_CAP) {
        throw new Error(
          `desktop runtime exceeds its budget (${budget.files} files, ${budget.bytes} bytes)`,
        )
      }
    }
  }
  visit(root)
  return budget
}

/**
 * Validate a staged runtime tree before it is promoted into the app bundle.
 * @param staging - Absolute path to the staged runtime project.
 * @returns The staged tree's file and byte counts.
 */
export function verifyRuntimeTree(staging: string): TreeBudget {
  const links = censusSymlinks(staging)
  if (links.length > 0) {
    throw new Error(
      `desktop runtime contains ${links.length} unexpected link(s): ${links
        .slice(0, 5)
        .map(path => relative(staging, path))
        .join(', ')}`,
    )
  }
  assertClosureInvariants(join(staging, 'node_modules'), staging)
  return assertTreeBudget(staging)
}

/**
 * Executes the package-set install and replaces the completed runtime tree.
 */
function main(): void {
  const target = resolveDesktopBuildTarget()
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || target !== 'mac-arm64') {
    throw new Error(
      `desktop runtime packaging requires mac-arm64 on a darwin-arm64 host; got ${target} on ${process.platform}-${process.arch}`,
    )
  }

  const paths = resolveDesktopTargetBuildPaths()
  const packageSet = readPackageSet(paths)
  const appVersion = JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, 'apps/cli/package.json'), 'utf8'),
  ).version as string

  const filesystem = statfsSync(REPOSITORY_ROOT)
  const freeBytes = filesystem.bavail * filesystem.bsize
  if (freeBytes < DISK_HEADROOM_BYTES) {
    throw new Error(`insufficient disk headroom for desktop runtime (${freeBytes} bytes available)`)
  }

  const staging = join(paths.root, 'runtime-staging')
  mkdirSync(paths.root, { recursive: true })
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  copyPackageSet(paths, packageSet, staging)
  writeStagingWorkspace(packageSet, staging)
  const lockfilePath = join(staging, 'pnpm-lock.yaml')
  // Seed third-party selections from the repository lock; pnpm replaces the
  // workspace importer with the packed dependency closure before installation.
  copyFileSync(join(REPOSITORY_ROOT, 'pnpm-lock.yaml'), lockfilePath)

  const runPnpm = (args: readonly string[]): void => {
    const result = spawnSync('pnpm', args, {
      cwd: staging,
      stdio: 'inherit',
      env: { ...process.env, CI: '1' },
    })
    if (result.status !== 0) {
      throw new Error(`pnpm ${args.join(' ')} failed with status ${result.status ?? 'signal'}`)
    }
  }
  runPnpm(['install', '--prod', '--lockfile-only', '--no-frozen-lockfile'])
  assertLockfileClosure(readFileSync(lockfilePath, 'utf8'))
  runPnpm(['install', '--prod', '--frozen-lockfile'])

  const nodeModules = join(staging, 'node_modules')
  pruneNodeModules(nodeModules, { platform: 'darwin', arch: 'arm64' })
  const budget = verifyRuntimeTree(staging)

  const runtimeDescriptor = {
    appVersion,
    runtime: 'shres',
    packageCount: packageSet.packages.length,
    lockfileSha256: createHash('sha256').update(readFileSync(lockfilePath)).digest('hex'),
    tree: budget,
  }
  writeFileSync(join(staging, 'desktop-runtime.json'), `${JSON.stringify(runtimeDescriptor, null, 2)}\n`)

  rmSync(paths.dsh, { recursive: true, force: true })
  renameSync(staging, paths.dsh)
  writeFileSync(
    join(paths.root, 'desktop-runtime.json'),
    `${JSON.stringify(runtimeDescriptor, null, 2)}\n`,
  )
  console.log(`Prepared desktop runtime at ${paths.dsh}`)
}

if (import.meta.main) main()
