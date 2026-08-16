/**
 * Resolve the ACP demo bin's Cordis config without ever defaulting to a
 * CWD-relative `cordis.yml`. An explicit path is consent to load that file;
 * `!!js` or a relative plugin `name:` outside `$DSH_HOME` is a hard stop.
 * @module @deepseek-ai/dsh-acp-demo/resolveDemoConfig
 */

import { readFileSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** YAML `name:` whose value starts with `./` or `../` (quoted or unquoted). */
const RELATIVE_PLUGIN_NAME = /\bname:\s*['"]?\.\.?(?:\/|\\)/

/**
 * Inputs for {@link resolveDemoConfig}.
 */
export interface ResolveDemoConfigOptions {
  /**
   * Explicit `--config` path. An empty string is treated as absent so the
   * bundled default is used.
   */
  requested?: string | undefined
  /**
   * Package-owned default used when `requested` is absent. Omit it to require
   * an explicit path.
   */
  bundledDefault?: string
  /** Diagnostic prefix on thrown errors. */
  binName: string
  /** Directory a relative `requested` path resolves against. */
  cwd?: string
  /** Harness home used for the pre-approval descendant check. */
  home?: string
}

/**
 * Absolute path of this package's default composition file. The path is
 * package-relative and never CWD-relative.
 * @param moduleUrl - the module URL the default is resolved beside; tests pass
 * a fixture URL.
 * @returns the absolute default config path.
 */
export function bundledAcpDemoConfigPath(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL('../cordis.yml', moduleUrl))
}

/**
 * Choose the config path the ACP demo bin will boot.
 *
 * With no `requested` path, the bundled default is returned and is not
 * scanned. An explicit path must exist; a missing file fails as not found.
 * When the file sits outside `$DSH_HOME` and its raw text contains `!!js` or a
 * relative plugin `name:`, the call throws and tells the operator to place the
 * file under `$DSH_HOME` to pre-approve those constructs.
 * @param options - requested path, bundled default, and resolution bases.
 * @returns the absolute config path to pass to {@link resolveConfigPath}.
 * @throws when no path can be chosen, the explicit file is missing or
 * unreadable, or an untrusted construct sits outside `$DSH_HOME`.
 */
export function resolveDemoConfig(options: ResolveDemoConfigOptions): string {
  const cwd = options.cwd ?? process.cwd()
  const home = options.home ?? resolveDshHome()
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
  assertTrustedExplicitConfig(absolute, options.binName, home)
  return absolute
}

/**
 * Read an explicit config and refuse `!!js` or a relative plugin `name:` when
 * the file is not under the Harness home.
 * @param absolute - resolved config path.
 * @param binName - diagnostic prefix.
 * @param home - Harness home used for the descendant check.
 */
function assertTrustedExplicitConfig(absolute: string, binName: string, home: string): void {
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
  if (reasons.length === 0 || isPathInsideHome(absolute, home)) return
  throw new Error(
    `${binName}: refused to load ${absolute}: it is outside $DSH_HOME and contains ${reasons.join(' and ')}.`
    + ' Place the file under $DSH_HOME to pre-approve !!js or relative plugin names.',
  )
}

/**
 * List the raw-text constructs that require Harness-home pre-approval.
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
 * Whether `filePath` is the Harness home or a descendant after canonicalization.
 * @param filePath - the config path that was read.
 * @param home - the Harness home.
 * @returns true when the canonical file path is the home or sits under it.
 */
function isPathInsideHome(filePath: string, home: string): boolean {
  const realHome = canonicalize(home)
  const realFile = canonicalize(filePath)
  return realFile === realHome || realFile.startsWith(`${realHome}${sep}`)
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
