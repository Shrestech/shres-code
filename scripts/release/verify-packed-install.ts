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
 * vendored family's pack output too, while publishing only its own.
 *
 * What this proves is that `files` selected a complete payload and that the
 * published dependency ranges resolve. A workspace link or a stale `lib/` in the
 * checkout cannot stand in for a missing file here. The shres family also
 * requires the installed headless bundle manifest to declare judgment-shield,
 * judgment-laya, and model-router, then resolves those packages from that
 * install.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { releaseFamily } from './families.ts'
import { capture, isEntry } from './process.ts'
import { packedIdentity } from './tarball.ts'

/**
 * Environment for the installed artifact: no host Node hooks, no host DeepSeek
 * Harness home, and no ambient npm user agent that would confuse npm.
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
 * Packages the headless bundle declares and that a published shres install
 * must be able to load. They are not the family entry; bundle/headless pulls
 * them in.
 */
export const HEADLESS_CLOSURE = [
  '@shres-code/shres-code-judgment-shield',
  '@shres-code/shres-code-judgment-laya',
  '@shres-code/shres-code-model-router',
] as const

/**
 * Reject an installed headless manifest that dropped one of {@link HEADLESS_CLOSURE}.
 * Node resolution from the consumer root is not enough: every packed tarball is
 * a direct dependency there, so a missing edge on headless would still resolve.
 * @param dependencies - the installed `dependencies` object.
 */
export function assertHeadlessClosure(dependencies: Readonly<Record<string, unknown>> | undefined): void {
  const present = dependencies ?? {}
  const missing = HEADLESS_CLOSURE.filter(name => !Object.hasOwn(present, name))
  if (missing.length > 0) {
    throw new Error(`installed @shres-code/shres-code-headless is missing dependency edges: ${missing.join(', ')}`)
  }
}

/**
 * Read the installed headless manifest, require its closure edges, then resolve
 * each package from that install.
 * @param consumerRoot - the throwaway consumer directory.
 * @param environment - the child environment.
 */
function assertInstalledHeadlessClosure(consumerRoot: string, environment: NodeJS.ProcessEnv): void {
  const headlessPackage = join(consumerRoot, 'node_modules', '@shres-code', 'shres-code-headless', 'package.json')
  if (!existsSync(headlessPackage)) {
    throw new Error(`installed tree is missing ${headlessPackage}`)
  }
  const manifest = JSON.parse(readFileSync(headlessPackage, 'utf8')) as { dependencies?: unknown }
  const dependencies = manifest.dependencies
  assertHeadlessClosure(
    dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)
      ? dependencies as Record<string, unknown>
      : undefined,
  )
  const script = [
    "import { createRequire } from 'node:module'",
    `const require = createRequire(${JSON.stringify(headlessPackage)})`,
    `const names = ${JSON.stringify(HEADLESS_CLOSURE)}`,
    'for (const name of names) require.resolve(name)',
  ].join('\n')
  capture(process.execPath, ['--input-type=module', '--eval', script], { cwd: consumerRoot, env: environment })
  console.log(`release verify-packed-install: headless closure resolves ${HEADLESS_CLOSURE.join(', ')}`)
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
    console.log(`release verify-packed-install: installing ${String(packed.size)} tarball(s) into ${consumerRoot}`)
    // Optional dependencies are omitted: the Landlock platform packages behind
    // them need a musl toolchain and one build per architecture, and a consumer
    // that cannot install them must still start — which is what optional means
    // here. Their entry package is a plain dependency of shres-sandbox-local, so
    // its tarball is supplied through --from.
    capture('npm', ['install', '--no-audit', '--no-fund', '--package-lock=false', '--omit=optional'],
      { cwd: consumerRoot, env: environment })

    const bin = join(consumerRoot, 'node_modules', ...entry.packageName.split('/'), entry.binPath)
    const version = capture(process.execPath, [bin, '--version'], { cwd: consumerRoot, env: environment })
    if (version !== expected.version) {
      throw new Error(`installed ${entry.packageName} --version reported ${JSON.stringify(version)}, expected ${expected.version}`)
    }
    console.log(`release verify-packed-install: installed ${entry.packageName} reports ${version}`)
    if (family.id === 'shres') assertInstalledHeadlessClosure(consumerRoot, environment)
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true })
  }
}

if (isEntry(import.meta.url)) main()
