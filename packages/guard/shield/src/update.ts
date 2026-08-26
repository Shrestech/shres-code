/**
 * npm registry check and profile install for `@shrestech/shres-shield-plugin`.
 * The seat never vendors the payload; this module only talks to the public
 * registry and `pnpm add` in the boot profile directory.
 * @module @shres-code/shres-code-shield/update
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PAYLOAD_SPECIFIER } from './resolve.ts'

/** Public npm packument URL for the paid payload's `latest` dist-tag. */
export const NPM_PAYLOAD_PACKUMENT = `https://registry.npmjs.org/${PAYLOAD_SPECIFIER}/latest`

/** Hang-safety abort for a registry GET; not a deployment knob. */
const REGISTRY_TIMEOUT_MS = 15_000

const SENSITIVE_ENV = /KEY|SECRET|TOKEN|PASSWORD/i

const NPM_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?$/

/** Outcome of one child spawn used by {@link installPayload}. */
export interface ShieldSpawnResult {
  /** Process exit status, or `null` when spawn failed before exit. */
  status: number | null
  /** `error.code` from a spawn-level failure (`ENOENT`, abort, …). */
  errorCode?: string
  /** Combined stderr text, used as the pane diagnostic. */
  stderr: string
}

/** Injectable `pnpm` (or test double) used to install the payload. */
export type ShieldSpawner = (
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<ShieldSpawnResult>

/**
 * Whether `version` is a concrete npm version this seat will pass to `pnpm add`.
 * Ranges, tags, and paths are rejected so the pane cannot install an arbitrary spec.
 * @param version - candidate from the registry or a caller.
 * @returns true when `pnpm add pkg@version` is safe to run.
 */
export function isNpmVersion(version: string): boolean {
  return NPM_VERSION.test(version)
}

/**
 * Read the paid package's `version` by walking from `entry` toward filesystem
 * root until a `package.json` named {@link PAYLOAD_SPECIFIER} is found.
 * @param entry - absolute path or `file:` URL of the loaded module; a bare
 *   specifier returns `null`.
 * @returns the version string, or `null` when it cannot be read.
 */
export function readPayloadVersion(entry: string): string | null {
  let start = entry
  if (start.startsWith('file:')) {
    try {
      start = fileURLToPath(start)
    /* v8 ignore start -- Node rejects only malformed file: URLs */
    } catch {
      return null
    }
    /* v8 ignore stop */
  }
  if (!isAbsolute(start)) return null
  let dir = dirname(start)
  for (;;) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const raw: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (
          raw !== null
          && typeof raw === 'object'
          && (raw as { name?: unknown }).name === PAYLOAD_SPECIFIER
        ) {
          const version = (raw as { version?: unknown }).version
          return typeof version === 'string' && version.length > 0 ? version : null
        }
      } catch {
        // Unreadable or invalid JSON — keep walking toward root.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function registrySignals(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REGISTRY_TIMEOUT_MS)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/**
 * GET {@link NPM_PAYLOAD_PACKUMENT} and return `version` when it is a
 * concrete semver string. Failures are structured, never thrown, so the
 * pane can show a diagnostic without dropping the seat.
 * @param fetchImpl - `fetch` used for the GET; defaults to global `fetch`.
 * @param signal - optional caller abort, composed with the hang-safety timeout.
 * @returns `latest` or a `registry` block.
 */
export async function queryNpmLatest(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ latest: string | null; blocked?: 'registry'; detail?: string }> {
  let response: Response
  try {
    response = await fetchImpl(NPM_PAYLOAD_PACKUMENT, {
      headers: { accept: 'application/json' },
      signal: registrySignals(signal),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'registry request failed'
    return { latest: null, blocked: 'registry', detail }
  }
  if (!response.ok) {
    return { latest: null, blocked: 'registry', detail: `HTTP ${response.status}` }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { latest: null, blocked: 'registry', detail: 'registry response is not JSON' }
  }
  if (body === null || typeof body !== 'object') {
    return { latest: null, blocked: 'registry', detail: 'registry response is not an object' }
  }
  const version = (body as { version?: unknown }).version
  if (typeof version !== 'string' || !isNpmVersion(version)) {
    return { latest: null, blocked: 'registry', detail: 'registry version is missing or not a semver string' }
  }
  return { latest: version }
}

/**
 * Parent env with credential-shaped keys stripped so `pnpm add` cannot leak
 * harness secrets into the child. Public registry installs do not need a token.
 * @returns a fresh env object safe to pass to spawn.
 */
export function pnpmEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SENSITIVE_ENV.test(key)) env[key] = value
  }
  return env
}

/**
 * Spawn `binary` with `args` and collect stderr. Used by {@link defaultSpawn}
 * (`pnpm`) and by tests that drive a real Node process without hitting npm.
 * @param binary - executable name or path.
 * @param args - argv after the binary.
 * @param options - cwd, env, optional abort.
 * @returns exit status, optional spawn error code, and stderr.
 */
export function spawnBinary(
  binary: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<ShieldSpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows resolves pnpm through its .cmd shim, which spawn() refuses
      // without a shell since the CVE-2024-27980 hardening.
      /* v8 ignore next -- POSIX CI and developer hosts take the false branch */
      shell: process.platform === 'win32',
      signal: options.signal,
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk)
    })
    child.stdout.on('data', () => {
      // Drain so a chatty pnpm cannot fill the pipe and deadlock.
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      /* v8 ignore next -- Node spawn errors always set `code` */
      resolve({ status: null, errorCode: error.code ?? 'spawn', stderr })
    })
    child.on('close', (status) => {
      resolve({ status, stderr })
    })
  })
}

const productionSpawn: ShieldSpawner = (args, options) => spawnBinary('pnpm', args, options)

/**
 * Replaceable `pnpm` spawner. Tests assign `current`; production keeps
 * {@link productionSpawn}. `defaultSpawn` always delegates here so a
 * re-export stays assignable through this object.
 */
export const shieldSpawn: { current: ShieldSpawner } = { current: productionSpawn }

/**
 * Production installer: `pnpm add <spec>` in the profile directory.
 * @param args - pnpm argv after the binary (`add`, spec, …).
 * @param options - cwd, env, optional abort.
 * @returns exit status, optional spawn error code, and stderr.
 */
export const defaultSpawn: ShieldSpawner = (args, options) => shieldSpawn.current(args, options)

/** Restore {@link shieldSpawn} after a test replacement. */
export function restoreDefaultSpawn(): void {
  shieldSpawn.current = productionSpawn
}

/**
 * Install a concrete version of {@link PAYLOAD_SPECIFIER} into `profileDir`
 * via `pnpm add pkg@version`. Refuses ranges and tags.
 * @param profileDir - boot profile directory (`ctx.baseUrl`).
 * @param version - concrete semver from {@link queryNpmLatest}.
 * @param spawnImpl - process spawner; defaults to {@link defaultSpawn}.
 * @param signal - optional abort forwarded to the child.
 * @returns `ok: true` on exit 0, otherwise a diagnostic.
 */
export async function installPayload(
  profileDir: string,
  version: string,
  spawnImpl: ShieldSpawner = defaultSpawn,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; detail: string; errorCode?: string }> {
  if (!isNpmVersion(version)) {
    return { ok: false, detail: `refusing to install non-semver ${JSON.stringify(version)}` }
  }
  const result = await spawnImpl(['add', `${PAYLOAD_SPECIFIER}@${version}`], {
    cwd: profileDir,
    env: pnpmEnv(),
    ...signal === undefined ? {} : { signal },
  })
  if (result.errorCode === 'ENOENT') {
    return { ok: false, detail: 'pnpm not found on PATH', errorCode: 'ENOENT' }
  }
  if (result.status !== 0) {
    const fromErr = result.stderr.trim()
    return {
      ok: false,
      detail: fromErr.length > 0 ? fromErr : `pnpm exited ${result.status ?? 'null'}`,
      ...result.errorCode === undefined ? {} : { errorCode: result.errorCode },
    }
  }
  return { ok: true }
}
