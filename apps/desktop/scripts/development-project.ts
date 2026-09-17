/** Prepare the disposable npm-project view used by an unpackaged Electron shell. */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/** Bundles the development project boots, in layer order. */
const DEVELOPMENT_PROJECT_BUNDLES = ['@shres-code/shres-code-base', '@shres-code/shres-code-web-app']

interface PackageManifest {
  readonly name?: string
  readonly version?: string
}

/** Inputs whose locations differ between the launcher and isolated tests. */
export interface DevelopmentProjectOptions {
  /** Directory replaced with the generated development project. */
  readonly projectDir: string
  /** Current workspace's apps/cli package directory. */
  readonly cliDir: string
  /** Current workspace's private desktop host application directory. */
  readonly hostDir: string
  /** pnpm's workspace-wide virtual-hoist directory. */
  readonly dependencyDir: string
  /** Version the linked cli and host packages must carry. */
  readonly version: string
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

function removeOwnedPath(path: string): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(path)
    return
  }
  if (stat.isDirectory()) {
    rmSync(path, { recursive: true })
    return
  }
  unlinkSync(path)
}

function linkDirectory(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(realpathSync(source), destination, process.platform === 'win32' ? 'junction' : 'dir')
}

function mirrorDependencyLinks(sourceRoot: string, destinationRoot: string): void {
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name === '.bin') continue
    const source = join(sourceRoot, entry.name)
    if (entry.name.startsWith('@') && (entry.isDirectory() || entry.isSymbolicLink())) {
      mkdirSync(join(destinationRoot, entry.name), { recursive: true })
      for (const scoped of readdirSync(source, { withFileTypes: true })) {
        if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue
        linkDirectory(join(source, scoped.name), join(destinationRoot, entry.name, scoped.name))
      }
      continue
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) linkDirectory(source, join(destinationRoot, entry.name))
  }
}

/**
 * Write the development project's profile manifest and pnpm settings. The
 * desktop host reads the profile bundles list from this manifest, so the
 * generated project boots the shipped web composition.
 */
function writeProjectMetadata(projectDir: string, version: string): void {
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
    name: '@shres-code/shres-code-desktop-runtime',
    version,
    private: true,
    dependencies: {},
    shres: { profile: { bundles: [...DEVELOPMENT_PROJECT_BUNDLES] } },
  }, undefined, 2) + '\n')
  writeFileSync(join(projectDir, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
}

/**
 * Replace one disposable project with links to the current built workspace.
 * @param options - project destination, linked packages, dependency mirror source, and version.
 * @returns the absolute project directory supplied by the caller.
 */
export function prepareDevelopmentProject(options: DevelopmentProjectOptions): string {
  const cliManifest = readManifest(join(options.cliDir, 'package.json'))
  if (cliManifest.name !== '@shres-code/shres-code' || cliManifest.version !== options.version) {
    throw new Error(
      'desktop development: apps/cli must be @shres-code/shres-code@' + options.version + ', found '
      + String(cliManifest.name) + '@' + String(cliManifest.version),
    )
  }
  if (!existsSync(options.dependencyDir)) {
    throw new Error('desktop development: workspace dependency links are missing; run pnpm install')
  }
  const hostManifest = readManifest(join(options.hostDir, 'package.json'))
  if (hostManifest.name !== '@shres-code/shres-code-desktop-host' || hostManifest.version !== options.version) {
    throw new Error(
      'desktop development: apps/desktop-host must be @shres-code/shres-code-desktop-host@' + options.version + ', found '
      + String(hostManifest.name) + '@' + String(hostManifest.version),
    )
  }
  if (!existsSync(join(options.hostDir, 'lib', 'index.js'))) {
    throw new Error('desktop development: apps/desktop-host/lib/index.js is missing; run pnpm run build')
  }

  removeOwnedPath(options.projectDir)
  mkdirSync(options.projectDir, { recursive: true })
  writeProjectMetadata(options.projectDir, options.version)
  const destinationModules = join(options.projectDir, 'node_modules')
  mkdirSync(destinationModules, { recursive: true })
  mirrorDependencyLinks(options.dependencyDir, destinationModules)
  const cliLink = join(destinationModules, '@shres-code', 'shres-code')
  removeOwnedPath(cliLink)
  linkDirectory(options.cliDir, cliLink)
  const hostLink = join(destinationModules, '@shres-code', 'shres-code-desktop-host')
  removeOwnedPath(hostLink)
  linkDirectory(options.hostDir, hostLink)
  return options.projectDir
}
