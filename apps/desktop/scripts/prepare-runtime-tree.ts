/**
 * Materialize the packaged runtime tree: a production deployment of the
 * desktop host package's closure (which includes the shres CLI app and every
 * bundle dependency) for electron-builder to copy inside the application.
 * Stage A runs the host child under the Electron binary
 * (ELECTRON_RUN_AS_NODE), so no separate Node runtime ships; plugin installs
 * (and their bundled pnpm) arrive with the plugin manager.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { desktopRuntimeFileExclusion } from './runtime-file-policy.ts'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..')
const TARGET_DIR = join(REPOSITORY_ROOT, 'apps', 'desktop', '.desktop-build', 'targets', 'mac-arm64')
const RUNTIME_DIR = join(TARGET_DIR, 'shres')
const INCOMING_DIR = join(TARGET_DIR, 'shres-incoming')

interface PackageManifest {
  readonly name?: string
  readonly version?: string
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

/** Platform and architecture of the target this tree is built for. */
const TARGET_PLATFORM = 'darwin' as const
const TARGET_ARCH = 'arm64'

/**
 * Drop the paths the runtime file policy excludes, so the shipped tree carries
 * only this target's payload. The walk runs on the materialized tree: pruning
 * the deploy output first leaves dangling virtual-store links and the
 * dereferencing tar step then fails on them.
 * @param nodeModules - absolute node_modules directory of the materialized tree.
 * @returns how many entries were removed.
 */
function pruneNodeModules(nodeModules: string): number {
  let dropped = 0
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const relativePath = relative(nodeModules, path)
      if (desktopRuntimeFileExclusion(relativePath, { platform: TARGET_PLATFORM, arch: TARGET_ARCH }) !== undefined) {
        rmSync(path, { recursive: true, force: true })
        dropped += 1
        continue
      }
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(path)
      } catch {
        // A path that vanished between listing and stat has nothing to walk.
        continue
      }
      if (stat.isDirectory()) walk(path)
    }
  }
  walk(nodeModules)
  return dropped
}

function main(): void {
  const hostManifest = readManifest(join(REPOSITORY_ROOT, 'apps', 'desktop-host', 'package.json'))
  const appManifest = readManifest(join(REPOSITORY_ROOT, 'apps', 'cli', 'package.json'))
  if (hostManifest.name === undefined) throw new Error('desktop packaging: host package has no name')
  mkdirSync(TARGET_DIR, { recursive: true })
  // deploy requires an empty target; repackaging starts from a clean tree.
  rmSync(RUNTIME_DIR, { recursive: true, force: true })
  rmSync(INCOMING_DIR, { recursive: true, force: true })
  // pnpm deploy writes the deployed project at the target root with its
  // production dependency closure under node_modules, the published shape.
  // --legacy: the workspace does not inject workspace packages, so the
  // v10+ injected-deps deploy path does not apply; legacy deploys the
  // published-shape closure of a normal workspace.
  // node-linker=hoisted installs real flat directories (npm layout, no
  // symlink farm): the pnpm virtual store's nested node_modules links form
  // cycles that no after-the-fact materializer (tar -h, rsync --copy-links)
  // can follow without exploding, and macOS codesign rejects every symlink.
  const deployed = spawnSync('pnpm', [
    '--filter', hostManifest.name,
    '--config.nodeLinker=hoisted',
    'deploy',
    '--prod',
    '--legacy',
    INCOMING_DIR,
  ], { cwd: REPOSITORY_ROOT, stdio: 'inherit' })
  if (deployed.status !== 0) throw new Error('desktop packaging: pnpm deploy of the runtime tree failed with ' + String(deployed.status))
  // Legacy deploy lays a pnpm symlink farm (node_modules scope links AND the
  // .pnpm virtual store's internal links); macOS codesign rejects any symlink
  // in a bundle. Materialize with rsync --copy-links: every link becomes a
  // real copy of its target. Bounded linear in store fan-in, and unlike a
  // tar -h round-trip it cannot follow a parent-escaping store link into the
  // output being written (the archive previously packed itself until the
  // disk filled).
  // The hoisted install already holds real files; a plain copy preserves that.
  mkdirSync(RUNTIME_DIR, { recursive: true })
  cpSync(INCOMING_DIR, RUNTIME_DIR, { recursive: true })
  const pruned = pruneNodeModules(join(RUNTIME_DIR, 'node_modules'))
  console.log('desktop packaging: file policy dropped ' + String(pruned) + ' entries')
  // Deploy places the host package at the root; the shell resolves it from
  // node_modules, so self-link exactly like npm's self-referencing installs.
  const selfLink = join(RUNTIME_DIR, 'node_modules', '@shres-code', 'shres-code-desktop-host')
  if (!existsSync(selfLink)) symlinkSync('../..', selfLink, 'junction')
  for (const path of [
    join(selfLink, 'lib', 'index.js'),
    join(RUNTIME_DIR, 'node_modules', '@shres-code', 'shres-code', 'package.json'),
    join(RUNTIME_DIR, 'node_modules', '@shres-code', 'shres-code', 'config', 'agent-presets'),
    join(RUNTIME_DIR, 'node_modules', '@shres-code', 'shres-code-web-frontend', 'dist', 'index.html'),
  ]) {
    if (!existsSync(path)) throw new Error('desktop packaging: runtime tree is missing ' + path)
  }
  writeFileSync(
    join(TARGET_DIR, 'desktop-runtime.json'),
    JSON.stringify({ appVersion: String(appManifest.version ?? ''), runtime: 'shres' }, undefined, 2)
      + String.fromCharCode(10),
  )
  console.log('desktop packaging: runtime tree ready at ' + RUNTIME_DIR)
}

main()
