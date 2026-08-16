/**
 * Resolve the ACP demo bin's Cordis config. The bin never invents a
 * CWD-relative default. An explicit path is consent to load that file;
 * `!!js` or a relative plugin `name:` is refused unless the file is under
 * `$DSH_HOME` or a first-party / packaged install tree.
 * @module @deepseek-ai/dsh-acp-demo/resolveDemoConfig
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/**
 * YAML `name:` whose value starts with `./` or `../` (quoted or unquoted).
 * Allows optional space before `:`, and a `!!tag` (including `!!str`) before the path.
 */
const RELATIVE_PLUGIN_NAME = /\bname\s*:\s*(?:!!\w+\s+)?['"]?\.\.?(?:\/|\\)/

/** Package names whose on-disk directory is a first-party demo install. */
const DEMO_PACKAGE_NAMES = new Set([
  '@deepseek-ai/dsh-acp-demo',
  '@deepseek-ai/dsh-sdk-jsonrpc-demo',
])

/**
 * Inputs for {@link resolveDemoConfig}.
 */
export interface ResolveDemoConfigOptions {
  /**
   * Explicit `--config` path. An empty string is treated as absent.
   */
  requested?: string | undefined
  /**
   * Optional default used when `requested` is absent. The ACP bin omits this
   * so a missing `--config` stays an error.
   */
  bundledDefault?: string
  /** Diagnostic prefix on thrown errors. */
  binName: string
  /** Directory a relative `requested` path resolves against. */
  cwd?: string
  /** Harness home used for the pre-approval descendant check. */
  home?: string
  /**
   * File or directory used to discover first-party and packaged trusted roots.
   * Defaults to this module, so source launch and the published bin walk from
   * their own install location.
   */
  installAnchor?: string
}

/**
 * Choose the config path the ACP demo bin will boot.
 *
 * With no `requested` path and no bundled default, the call throws. An
 * explicit path must exist; a missing file fails as not found. When the file
 * contains `!!js` or a relative plugin `name:` and is not under `$DSH_HOME`
 * and not inside a first-party checkout or packaged runtime tree, the call
 * throws. The raw-text scan is best-effort; the hard guarantee is that this
 * bin never loads a CWD `cordis.yml` by default.
 * @param options - requested path, optional bundled default, and resolution bases.
 * @returns the absolute config path to pass to {@link resolveConfigPath}.
 * @throws when no path can be chosen, the explicit file is missing or
 * unreadable, or an untrusted construct sits outside every approved location.
 */
export function resolveDemoConfig(options: ResolveDemoConfigOptions): string {
  const cwd = options.cwd ?? process.cwd()
  const home = options.home ?? resolveDshHome()
  const installAnchor = options.installAnchor ?? fileURLToPath(import.meta.url)
  const requested = options.requested !== undefined && options.requested !== ''
    ? options.requested
    : undefined
  if (requested === undefined) {
    if (options.bundledDefault === undefined) {
      throw new Error(
        `${options.binName}: config is required — pass an explicit path; there is no working-directory fallback`,
      )
    }
    return resolve(cwd, options.bundledDefault)
  }
  const absolute = resolve(cwd, requested)
  assertTrustedExplicitConfig(absolute, options.binName, home, installAnchor)
  return absolute
}

/**
 * Read an explicit config and refuse `!!js` or a relative plugin `name:` when
 * the file is not under the Harness home and not first-party or packaged.
 * @param absolute - resolved config path.
 * @param binName - diagnostic prefix.
 * @param home - Harness home used for the descendant check.
 * @param installAnchor - path used to discover first-party / packaged roots.
 */
function assertTrustedExplicitConfig(
  absolute: string, binName: string, home: string, installAnchor: string,
): void {
  let content: string
  try {
    content = readFileSync(absolute, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${binName}: config file not found: ${absolute}`)
    }
    throw new Error(`${binName}: failed to read config ${absolute}: ${String(error)}`)
  }
  const reasons = untrustedConstructs(content)
  if (reasons.length === 0 || isPreapprovedLocation(absolute, home, installAnchor)) return
  throw new Error(
    `${binName}: refused to load ${absolute}: it contains ${reasons.join(' and ')}`
    + ' and is not under $DSH_HOME or a first-party/packaged install tree.'
    + ' Place the file under $DSH_HOME to pre-approve !!js or relative plugin names.',
  )
}

/**
 * List the raw-text constructs that require a pre-approved location.
 * @param content - the file's YAML text.
 * @returns the human-readable construct names found, in check order.
 */
function untrustedConstructs(content: string): string[] {
  const reasons: string[] = []
  if (content.includes('!!js')) reasons.push('!!js')
  if (RELATIVE_PLUGIN_NAME.test(content)) reasons.push('a relative plugin name')
  return reasons
}

/**
 * Whether the file is under `$DSH_HOME` or a first-party / packaged tree.
 * @param filePath - the config path that was read.
 * @param home - the Harness home.
 * @param installAnchor - path used to discover first-party / packaged roots.
 * @returns true when any approved root contains the file.
 */
function isPreapprovedLocation(filePath: string, home: string, installAnchor: string): boolean {
  if (isPathInside(filePath, home)) return true
  for (const root of discoverTrustedRoots(installAnchor)) {
    if (isPathInside(filePath, root)) return true
  }
  return false
}

/**
 * Walk from `anchor` toward the filesystem root and collect first-party and
 * packaged directories that may contain `!!js` compositions.
 * @param anchor - a file or directory inside the bin's install tree.
 * @returns canonical trusted roots, nearest first.
 */
function discoverTrustedRoots(anchor: string): string[] {
  const roots: string[] = []
  let current = startDir(anchor)
  while (true) {
    if (isHarnessSourceRoot(current) || isPackagedRuntimeRoot(current) || isDemoPackageDir(current)) {
      roots.push(canonicalize(current))
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return roots
}

/**
 * Directory at which ancestor walking starts.
 * @param anchor - a file or directory path.
 * @returns the directory to start from.
 */
function startDir(anchor: string): string {
  const resolved = canonicalize(anchor)
  try {
    return statSync(resolved).isDirectory() ? resolved : dirname(resolved)
  } catch {
    // Missing anchor: walk from its spelled parent.
    return dirname(resolve(anchor))
  }
}

/**
 * Whether `dir` is this repository's source checkout.
 * @param dir - a candidate ancestor of the bin.
 * @returns true when the harness workspace markers are present.
 */
function isHarnessSourceRoot(dir: string): boolean {
  return existsSync(join(dir, 'pnpm-workspace.yaml'))
    && existsSync(join(dir, 'examples'))
    && existsSync(join(dir, 'packages', 'examples', 'acp-demo', 'package.json'))
    && existsSync(join(dir, 'packages', 'examples', 'jsonrpc-demo', 'package.json'))
}

/**
 * Whether `dir` is a packaged runtime tree that ships `runtime/cordis.yml`.
 * @param dir - a candidate ancestor of the bin.
 * @returns true when the closed-runtime default config sits here or under `runtime/`.
 */
function isPackagedRuntimeRoot(dir: string): boolean {
  return existsSync(join(dir, 'runtime', 'cordis.yml'))
    || existsSync(join(dir, 'cordis.yml')) && existsSync(join(dir, 'node'))
}

/**
 * Whether `dir` is an installed demo-bin package.
 * @param dir - a candidate ancestor of the bin.
 * @returns true when `package.json` names a demo bin package.
 */
function isDemoPackageDir(dir: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }
    return typeof parsed.name === 'string' && DEMO_PACKAGE_NAMES.has(parsed.name)
  } catch {
    // Missing, unreadable, or non-JSON package.json: this directory is not a demo package.
    return false
  }
}

/**
 * Whether `filePath` is `root` or a descendant after canonicalization.
 * @param filePath - the config path that was read.
 * @param root - an approved directory.
 * @returns true when the canonical file path is the root or sits under it.
 */
function isPathInside(filePath: string, root: string): boolean {
  const realRoot = canonicalize(root)
  const realFile = canonicalize(filePath)
  return realFile === realRoot || realFile.startsWith(`${realRoot}${sep}`)
}

/**
 * Canonicalize a path through `realpath`, falling back to `resolve` when the
 * path is absent or cannot be followed.
 * @param path - the path to canonicalize.
 * @returns the real path, or the spelled absolute path when realpath fails.
 */
function canonicalize(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // Absent path or an unresolvable symlink: compare the spelled absolute path.
    return resolve(path)
  }
}
