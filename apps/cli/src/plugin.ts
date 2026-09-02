/**
 * `shres plugin --profile <name> <args...>` — profile plugin management as a
 * thin pnpm forwarder: initialize the profile on first use, run
 * `pnpm <args...>` in the profile directory, then reconcile the
 * `shres.profile.bundles` layer list against the installed state (a dependency
 * resolving to a package that declares `shres.bundle` joins the layer stack; a
 * removed or bundle-less dependency leaves it). Reconciling by installed
 * state, not by dependency diff, means `update` activates a package that
 * gained its `shres.bundle` declaration in a newer version.
 *
 * Editions are the paid-plugin install path: the profile manifest declares the
 * inventory (`shres.editions.<name>` with its `packages` and `autoProvision`).
 * New web and headless profiles declare Shield with `autoProvision: true`.
 * `enable-edition` selects among declared editions, and profile boot
 * re-provisions a selected edition whose package is missing.
 * @module @shres-code/shres-code/plugin
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_PROFILE_BUNDLES,
  initProfile,
  PROFILE_TEMPLATE_EDITIONS,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveBundleDir,
  resolveProfileDir,
  writeProfileManifest,
  type ProfileManifest,
} from '@shres-code/shres-code-app-boot'

const NAME = 'shres'

/**
 * Absolute path of this app's package.json (both anchors: src/ and lib/ sit
 * one level under apps/cli), the first anchor bundle resolution probes.
 */
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/**
 * Whether a resolved dependency exports a profile patch, i.e. is a bundle.
 * @param packageName - the dependency's package name.
 * @param profileDir - the profile directory (resolution anchor).
 * @returns true when the package manifest declares `shres.bundle`.
 */
function exportsPatch(packageName: string, profileDir: string): boolean {
  let dir: string
  try {
    dir = resolveBundleDir(NAME, packageName, INSTALL_ANCHOR, profileDir)
  } catch {
    return false // pnpm reported success yet the package is unresolvable — treat as plain
  }
  const manifest = readProfileManifest(NAME, dir)
  return manifest.shres?.bundle?.patch !== undefined
}

/**
 * Reconcile `shres.profile.bundles` against the installed state: pnpm has
 * already written the real installed names (so a git/path/tarball/alias spec
 * on the command line reconciles by its true package name) and materialized
 * the packages. A dependency that resolves to a `shres.bundle`-declaring
 * package joins the layer stack (appended in dependency order); a
 * dependency-listed name that no longer does — removed, or the installed
 * version dropped the declaration — leaves it. In-box bundles from the
 * profile template are not dependencies and are never touched. Warns once
 * per newly-added bundle-less dependency (a plain library is fine; the
 * warning is orientation).
 */
function reconcilePlugins(before: ProfileManifest, profileDir: string): void {
  const after = readProfileManifest(NAME, profileDir)
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const dependencies = Object.keys(after.dependencies ?? {})
  const plugins = after.shres?.profile?.bundles ?? []
  let changed = false
  for (const packageName of dependencies) {
    const isBundle = exportsPatch(packageName, profileDir)
    if (isBundle && !plugins.includes(packageName)) {
      plugins.push(packageName)
      changed = true
    } else if (!isBundle && !beforeDeps.has(packageName)) {
      process.stderr.write(
        `${NAME}: warning: ${packageName} declares no shres.bundle — installed as a plain dependency, not a profile layer `
        + '(a later update that gains one activates it automatically)\n',
      )
    }
  }
  const dependencySet = new Set(dependencies)
  for (const packageName of [...plugins]) {
    // Only dependency-managed entries are subject to removal; template
    // bundles (shres-base and friends) are not dependencies.
    const wasDependency = beforeDeps.has(packageName) || dependencySet.has(packageName)
    const stillBundle = dependencySet.has(packageName) && exportsPatch(packageName, profileDir)
    if (wasDependency && !stillBundle) {
      plugins.splice(plugins.indexOf(packageName), 1)
      changed = true
    }
  }
  if (!changed) return
  after.shres = { ...after.shres, profile: { ...after.shres?.profile, bundles: plugins } }
  writeProfileManifest(profileDir, after)
}

/**
 * Rewrite relative filesystem specs against the user's invoking directory.
 * pnpm runs with cwd = the profile directory, so a bare `.` or `../plugin`
 * (or their `file:`/`link:` forms) would silently resolve inside the profile
 * — `add .` from a plugin checkout would self-link the profile. Absolute
 * specs, registry names, and every other pnpm argument pass through
 * untouched.
 * @param argument - one pnpm argument, verbatim from argv.
 * @param cwd - the directory `shres` was invoked from.
 * @returns the argument with a relative path spec anchored to `cwd`.
 */
function anchorPathSpec(argument: string, cwd: string): string {
  const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument)
  if (match?.groups?.path === undefined) return argument
  // A bare path stays bare and a prefixed spec keeps its prefix: pnpm's
  // link-vs-copy semantics differ between `file:` and a plain directory
  // path, and the anchor must not change which one the user asked for.
  const prefix = match.groups.prefix ?? ''
  return `${prefix}${resolve(cwd, match.groups.path)}`
}

/**
 * The base package name of an npm spec, dropping any `@<version>` suffix
 * (kept on the scope for a scoped name).
 * @param spec - an npm spec such as `@shrestech/shres-shield-plugin` or `pkg@^1`.
 * @returns the bare package name.
 */
function npmSpecBase(spec: string): string {
  const at = spec.startsWith('@') ? spec.indexOf('@', 1) : spec.indexOf('@')
  return at === -1 ? spec : spec.slice(0, at)
}

/**
 * Whether an npm spec is currently resolvable from the profile directory's
 * `node_modules` (through the ordinary parent walk to the profiles fallback).
 * @param profileDir - the profile directory.
 * @param spec - the npm spec to probe.
 * @returns true when `require.resolve` finds the package's base name.
 */
function isSpecInstalled(profileDir: string, spec: string): boolean {
  try {
    createRequire(join(profileDir, 'package.json')).resolve(npmSpecBase(spec))
    return true
  } catch {
    return false
  }
}

/**
 * Run `pnpm <args>` in a profile directory and reconcile the bundle layer list
 * on success. Shared by the generic forwarder and the edition ensure path so
 * both install the same way.
 * @param profileDir - the profile directory pnpm runs in.
 * @param before - the profile manifest read before pnpm ran (reconcile base).
 * @param args - pnpm arguments with relative path specs anchored to the invoking directory.
 * @returns the pnpm exit code.
 */
function runPnpmInProfile(profileDir: string, before: ProfileManifest, args: readonly string[]): number {
  // Windows resolves pnpm through its .cmd shim, which spawn() refuses
  // without a shell since the CVE-2024-27980 hardening.
  const result = spawnSync('pnpm', args.map(argument => anchorPathSpec(argument, process.cwd())), {
    cwd: profileDir,
    // Capture pnpm's progress so a successful install never pollutes the CLI's
    // stdout; the captured output is replayed to stderr only on failure.
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      process.stderr.write(`${NAME}: pnpm not found on PATH — install pnpm to manage profile plugins\n`)
      return 127
    }
    throw result.error
  }
  const exitCode = result.status ?? 1
  if (exitCode === 0) {
    reconcilePlugins(before, profileDir)
  } else {
    // Replay pnpm's own diagnostics (captured above) so a failed install still
    // shows its cause, then add the profile-specific hint.
    if (result.stdout.length > 0) process.stderr.write(result.stdout)
    if (result.stderr.length > 0) process.stderr.write(result.stderr)
    writePnpmFailure(profileDir, args)
  }
  return exitCode
}

/**
 * Describe a failed pnpm run: the profile owns `pnpm-workspace.yaml`, and the
 * commonest failure here is pnpm ≥10 blocking a git dependency's prepare
 * (build) script until allowlisted.
 * @param profileDir - the profile directory pnpm ran in.
 * @param args - the pnpm arguments that failed.
 */
function writePnpmFailure(profileDir: string, args: readonly string[]): void {
  process.stderr.write(`${NAME}: pnpm failed in profile directory ${profileDir}\n`)
  if (args.some(argument => /^git\+|^github:|\.git(?:#|$)/.test(argument))) {
    process.stderr.write(
      `${NAME}: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — `
      + `add the exact key pnpm printed above under allowBuilds in ${join(profileDir, 'pnpm-workspace.yaml')}, then re-run\n`,
    )
  }
}

/**
 * Run one `shres plugin` invocation: init if needed, forward to pnpm, reconcile.
 * @param profile - the profile name.
 * @param args - pnpm arguments with relative path specs anchored to the invoking directory.
 * @returns the pnpm exit code.
 */
export function runPlugin(profile: string, args: readonly string[]): number {
  const dir = resolveProfileDir(profile)
  if (!existsSync(join(dir, 'package.json'))) {
    initProfile(dir, PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_BUNDLES, PROFILE_TEMPLATE_EDITIONS[profile])
    process.stderr.write(`${NAME}: initialized profile ${profile} at ${dir}\n`)
  }
  const before = readProfileManifest(NAME, dir)
  return runPnpmInProfile(dir, before, args)
}

/**
 * Select a declared edition: set its `autoProvision` and provision its
 * packages through the same pnpm forwarder, then reconcile. Config declares the
 * inventory; enabling selects among declared editions — an undeclared edition
 * fails loud rather than inventing a package set.
 * @param profile - the profile name.
 * @param edition - the declared edition name under `shres.editions`.
 * @returns the pnpm exit code, or 1 when the edition is not declared.
 */
export function runEnableEdition(profile: string, edition: string): number {
  const dir = resolveProfileDir(profile)
  if (!existsSync(join(dir, 'package.json'))) {
    initProfile(dir, PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_BUNDLES, PROFILE_TEMPLATE_EDITIONS[profile])
    process.stderr.write(`${NAME}: initialized profile ${profile} at ${dir}\n`)
  }
  const before = readProfileManifest(NAME, dir)
  const declared = before.shres?.editions?.[edition]
  if (declared === undefined) {
    process.stderr.write(
      `${NAME}: edition ${JSON.stringify(edition)} is not declared in ${join(dir, 'package.json')} shres.editions; `
      + 'declare the edition (its packages) first — enabling selects among declared editions\n',
    )
    return 1
  }
  if (!declared.autoProvision) {
    before.shres = {
      ...before.shres,
      editions: { ...before.shres?.editions, [edition]: { ...declared, autoProvision: true } },
    }
    writeProfileManifest(dir, before)
  }
  if (declared.packages.length === 0) return 0
  return runPnpmInProfile(dir, before, ['add', ...declared.packages])
}

/**
 * Ensure every enabled (autoProvision) edition's packages are installed: a
 * declared package that is not resolvable from the profile triggers one
 * `pnpm add` for the missing specs plus reconcile. No-op when no edition is
 * selected or every package already resolves. pnpm's own failure diagnostics
 * are written to stderr and reflected in the returned exit code, never silently
 * skipped (misconfiguration fails loud).
 * @param profileDir - the profile directory.
 * @returns 0 when nothing needed installing or every install succeeded;
 *   non-zero when pnpm failed.
 */
export function ensureProfileEditions(profileDir: string): number {
  const before = readProfileManifest(NAME, profileDir)
  const editions = before.shres?.editions
  if (editions === undefined) return 0
  const specs = [...new Set(
    Object.values(editions).filter(edition => edition.autoProvision).flatMap(edition => edition.packages),
  )]
  if (specs.length === 0) return 0
  const missing = specs.filter(spec => !isSpecInstalled(profileDir, spec))
  if (missing.length === 0) return 0
  return runPnpmInProfile(profileDir, before, ['add', ...missing])
}
