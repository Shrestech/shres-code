/** Download and verify the upstream Node.js runtime and copy the pinned pnpm CLI. */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { chmod, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { extract } from 'tar'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.ts'

const NODE_VERSION = '24.17.0'
const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const RUNTIME_ROOT = BUILD_PATHS.runtime
const DOWNLOAD_ROOT = BUILD_PATHS.downloads

/** pnpm CLI entry candidates inside the copied package, in preference order. */
const PNPM_ENTRY_CANDIDATES = ['bin/pnpm.cjs', 'bin/pnpm.mjs']

type RuntimePlatform = 'darwin'
type RuntimeArch = 'arm64' | 'x64'

function target(): { platform: RuntimePlatform; arch: RuntimeArch } {
  // Stage A ships mac-arm64; the target name already restricts the pair.
  const name = resolveDesktopBuildTarget()
  const platform = name.startsWith('mac-') ? 'darwin' : undefined
  const arch = name.endsWith('arm64') ? 'arm64' : 'x64'
  if (platform === undefined) throw new Error('desktop runtime: unsupported target ' + name)
  return { platform, arch }
}

async function download(url: string, path: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) throw new Error('desktop runtime: ' + url + ' returned HTTP ' + String(response.status))
  writeFileSync(path, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 })
}

async function prepareNode(platform: RuntimePlatform, arch: RuntimeArch): Promise<void> {
  const folder = 'node-v' + NODE_VERSION + '-' + platform + '-' + arch
  const archiveName = folder + '.tar.gz'
  const releaseRoot = 'https://nodejs.org/download/release/v' + NODE_VERSION
  const archive = join(DOWNLOAD_ROOT, archiveName)
  const sums = join(DOWNLOAD_ROOT, 'node-v' + NODE_VERSION + '-SHASUMS256.txt')
  if (!existsSync(archive)) await download(releaseRoot + '/' + archiveName, archive)
  if (!existsSync(sums)) await download(releaseRoot + '/SHASUMS256.txt', sums)
  const line = (await readFile(sums, 'utf8')).split(/\r?\n/u)
    .find(candidate => candidate.endsWith('  ' + archiveName))
  if (line === undefined) throw new Error('desktop runtime: ' + archiveName + ' is absent from Node.js SHASUMS256.txt')
  const expected = line.split(/\s+/u)[0]
  const actual = createHash('sha256').update(await readFile(archive)).digest('hex')
  if (actual !== expected) throw new Error('desktop runtime: checksum mismatch for ' + archiveName)

  const extraction = BUILD_PATHS.nodeExtract
  rmSync(extraction, { recursive: true, force: true })
  mkdirSync(extraction, { recursive: true })
  await extract({ cwd: extraction, file: archive })
  const source = join(extraction, folder, 'bin', 'node')
  const destinationRoot = join(RUNTIME_ROOT, 'node')
  const destination = join(destinationRoot, 'node')
  rmSync(destinationRoot, { recursive: true, force: true })
  mkdirSync(destinationRoot, { recursive: true })
  // A fresh write prevents macOS from retaining invalid code-signature vnode state from a tar-extracted Mach-O clone.
  await pipeline(createReadStream(source), createWriteStream(destination, { flags: 'wx' }))
  await chmod(destination, 0o755)
  const hostCanExecute = platform === process.platform
    && (arch === process.arch || (arch === 'x64' && process.arch === 'arm64'))
  if (hostCanExecute) {
    const result = spawnSync(destination, ['--version'], { encoding: 'utf8' })
    if (result.error !== undefined || result.status !== 0 || result.stdout.trim() !== 'v' + NODE_VERSION) {
      const detail = result.error?.message ?? result.signal ?? result.stderr.trim()
      const outcome = detail === '' ? 'exit ' + String(result.status) : detail
      throw new Error('desktop runtime: prepared Node.js ' + NODE_VERSION + ' failed executable verification: ' + outcome)
    }
  }
  rmSync(extraction, { recursive: true, force: true })
}

/** Resolve the pinned pnpm package root installed beside the desktop app. */
function pnpmPackageRoot(): string {
  const require = createRequire(import.meta.url)
  const path = require.resolve('pnpm')
  const root = dirname(path)
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
  if (manifest.name !== 'pnpm' || typeof manifest.version !== 'string') {
    throw new Error('desktop runtime: resolved pnpm package root does not hold the pnpm manifest')
  }
  return root
}

function preparePnpm(): { version: string, entry: string } {
  const source = pnpmPackageRoot()
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { version: string }
  const destination = join(RUNTIME_ROOT, 'pnpm')
  rmSync(destination, { recursive: true, force: true })
  cpSync(source, destination, { recursive: true })
  const entry = PNPM_ENTRY_CANDIDATES.find(candidate => existsSync(join(destination, candidate)))
  if (entry === undefined) {
    throw new Error('desktop runtime: the pinned pnpm package holds none of ' + PNPM_ENTRY_CANDIDATES.join(', '))
  }
  return { version: manifest.version, entry }
}

async function main(): Promise<void> {
  const { platform, arch } = target()
  mkdirSync(DOWNLOAD_ROOT, { recursive: true })
  mkdirSync(RUNTIME_ROOT, { recursive: true })
  await prepareNode(platform, arch)
  const pnpm = preparePnpm()
  writeFileSync(join(RUNTIME_ROOT, 'versions.json'), JSON.stringify({
    schemaVersion: 1,
    node: NODE_VERSION,
    pnpm: pnpm.version,
    pnpmEntry: pnpm.entry,
  }, undefined, 2) + '\n')
  console.log('desktop runtime: prepared Node.js ' + NODE_VERSION + ' and pnpm ' + pnpm.version + ' in ' + RUNTIME_ROOT)
}

await main()
