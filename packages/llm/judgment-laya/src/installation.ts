/**
 * Explicit installation and launch preflight for the local Laya gateway.
 *
 * Installation is the only network-reaching step: it creates a uv-managed
 * virtual environment, syncs the hash-locked gateway project, downloads the
 * pinned checkpoint, verifies every file against the manifest, and writes a
 * marker. The launch preflight reads that marker and never downloads.
 *
 * @module @shres-code/shres-code-judgment-laya/installation
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SubprocessRuntime } from '@shres-code/shres-code-subprocess'
import type { ResolvedLayaJudgmentConfig } from './config.ts'
import type { LaunchPreflight } from './supervisor.ts'
import type { LayaInstallResult } from './types.ts'

/** Operating system and architecture facts the host check reads. */
export interface HostFacts {
  /** `process.platform` value. */
  readonly platform: string
  /** `process.arch` value. */
  readonly arch: string
}

/** Runs one install command to completion or throws with its stderr tail. */
export type CommandRunner = (
  label: string,
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal,
) => Promise<void>

/** What {@link installLaya} needs besides the configuration. */
export interface InstallDependencies {
  /** Host facts for the Apple-silicon check. */
  readonly host: HostFacts
  /** Resolve the configured `uv` executable. */
  readonly resolveExecutable: (command: string, signal: AbortSignal) => Promise<string>
  /** Command runner, normally {@link subprocessRunner}. */
  readonly run: CommandRunner
}

/** The install marker's contents; a launch requires every field to match the configuration. */
interface InstallMarker {
  readonly version: 1
  readonly lockSha256: string
  readonly repo: string
  readonly revision: string
  readonly manifestSha256: string
  readonly modelDir: string
  readonly installedAt: string
}

const COLLECT_BYTES = 64 * 1024

/**
 * Read the current host's facts.
 * @returns `process.platform` and `process.arch`.
 */
export function currentHost(): HostFacts {
  return { platform: process.platform, arch: process.arch }
}

/**
 * Whether laya-mlx can run on the host: Apple silicon only.
 * @param host - platform and architecture.
 * @returns true for darwin-arm64.
 */
export function hostSupported(host: HostFacts): boolean {
  return host.platform === 'darwin' && host.arch === 'arm64'
}

/**
 * Explain an unsupported host.
 * @param host - platform and architecture.
 * @returns the detail naming the host and the requirement.
 */
export function unsupportedHostDetail(host: HostFacts): string {
  return `laya-mlx runs on Apple silicon (darwin-arm64) only; this host is ${host.platform}-${host.arch}`
}

/**
 * Environment entries for the gateway interpreter, merged over the subprocess
 * seam's scrubbed parent environment (which already drops credential-shaped
 * names). Hugging Face and Transformers stay offline unless `network` is
 * `online`, which only the install download uses.
 *
 * @param config - resolved provider configuration.
 * @param network - `offline` for serving, `online` for the install download.
 * @returns explicit entries; `undefined` removes an inherited entry.
 */
export function gatewayEnv(
  config: ResolvedLayaJudgmentConfig,
  network: 'offline' | 'online',
): Record<string, string | undefined> {
  return {
    HF_HOME: config.hfHome,
    HF_HUB_OFFLINE: network === 'offline' ? '1' : '0',
    HF_HUB_DISABLE_TELEMETRY: '1',
    TRANSFORMERS_OFFLINE: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONPATH: undefined,
    PYTHONHOME: undefined,
    VIRTUAL_ENV: undefined,
  }
}

/**
 * Stream one file through SHA-256.
 * @param path - file to hash.
 * @returns the lowercase hexadecimal digest.
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Decide whether the gateway can launch, and how.
 *
 * @param config - resolved provider configuration.
 * @param host - host facts.
 * @returns the launch plan, or `unsupported-host`/`not-installed` with the next action.
 */
export async function preflightLaunch(
  config: ResolvedLayaJudgmentConfig,
  host: HostFacts,
): Promise<LaunchPreflight> {
  if (!hostSupported(host)) return { kind: 'unsupported-host', detail: unsupportedHostDetail(host) }
  if (!await isFile(join(config.gatewayProject, 'pyproject.toml'))) {
    return { kind: 'not-installed', detail: `the gateway project is missing at ${config.gatewayProject}; set gatewayProject` }
  }
  const marker = await readMarker(config.markerPath)
  if (marker === undefined) {
    return { kind: 'not-installed', detail: 'Laya is not installed; run /laya install' }
  }
  if (marker.lockSha256 !== await sha256File(config.lockPath)) {
    return { kind: 'not-installed', detail: 'the gateway dependency lock changed since install; run /laya install' }
  }
  if (marker.repo !== config.model.repo
    || marker.revision !== config.model.revision
    || marker.manifestSha256 !== config.model.manifestSha256
    || marker.modelDir !== config.modelDir) {
    return { kind: 'not-installed', detail: 'the installed checkpoint differs from the configured pin; run /laya install' }
  }
  if (!await isFile(config.pythonPath)) {
    return { kind: 'not-installed', detail: 'the gateway environment is missing; run /laya install' }
  }
  return {
    kind: 'launch',
    plan: {
      argv: [
        config.pythonPath, '-m', 'laya_gateway', 'serve',
        '--manifest', config.manifestPath,
        '--model-dir', config.modelDir,
        '--dtype', config.dtype,
        '--batch-size', String(config.batchSize),
        '--max-request-bytes', String(config.maxRequestBytes),
      ],
      cwd: config.runtimeDir,
      env: gatewayEnv(config, 'offline'),
    },
  }
}

/**
 * Install the gateway environment and the pinned checkpoint.
 *
 * The manifest digest is checked against the configuration before any
 * download. A checkpoint whose files differ from the manifest is deleted by
 * the gateway's own install command. The marker is written last, atomically,
 * so an interrupted install leaves the provider `not-installed`.
 *
 * @param config - resolved provider configuration.
 * @param dependencies - host facts, executable lookup, and command runner.
 * @param signal - cancels the running step.
 * @returns the verified checkpoint directory and the digests recorded in the marker.
 * @throws Error naming the failed step and its stderr tail.
 */
export async function installLaya(
  config: ResolvedLayaJudgmentConfig,
  dependencies: InstallDependencies,
  signal: AbortSignal,
): Promise<LayaInstallResult> {
  if (!hostSupported(dependencies.host)) throw new Error(unsupportedHostDetail(dependencies.host))
  if (!await isFile(config.manifestPath)) {
    throw new Error(`no manifest pins revision ${config.model.revision} at ${config.manifestPath}`)
  }
  const manifestSha256 = await sha256File(config.manifestPath)
  if (manifestSha256 !== config.model.manifestSha256) {
    throw new Error(`manifest ${config.manifestPath} has sha256 ${manifestSha256}; model.manifestSha256 pins ${config.model.manifestSha256}`)
  }
  let uv: string
  try {
    uv = await dependencies.resolveExecutable(config.uvPath, signal)
  } catch (error: unknown) {
    throw new Error(`uv executable "${config.uvPath}" was not found; install uv from https://docs.astral.sh/uv/`, { cause: error })
  }
  await mkdir(config.runtimeDir, { recursive: true, mode: 0o700 })
  await mkdir(config.hfHome, { recursive: true, mode: 0o700 })
  await dependencies.run('uv venv', [uv, 'venv', '--python', config.python, '--allow-existing', config.venvDir], {}, signal)
  await dependencies.run('uv sync', [uv, 'sync', '--frozen', '--project', config.gatewayProject], {
    UV_PROJECT_ENVIRONMENT: config.venvDir,
  }, signal)
  await dependencies.run('checkpoint download', [
    config.pythonPath, '-m', 'laya_gateway', 'install',
    '--manifest', config.manifestPath,
    '--dest', config.modelDir,
  ], gatewayEnv(config, 'online'), signal)
  const lockSha256 = await sha256File(config.lockPath)
  const marker: InstallMarker = {
    version: 1,
    lockSha256,
    repo: config.model.repo,
    revision: config.model.revision,
    manifestSha256,
    modelDir: config.modelDir,
    installedAt: new Date().toISOString(),
  }
  const temporary = `${config.markerPath}.tmp`
  await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, config.markerPath)
  return { modelDir: config.modelDir, manifestSha256, lockSha256 }
}

/**
 * A {@link CommandRunner} over the subprocess seam. Each command gets the
 * configured install deadline; its stderr tail names the failure.
 *
 * @param subprocess - the subprocess service.
 * @param config - resolved provider configuration.
 * @returns the runner.
 */
export function subprocessRunner(
  subprocess: Pick<SubprocessRuntime, 'spawn'>,
  config: ResolvedLayaJudgmentConfig,
): CommandRunner {
  return async (label, argv, env, signal) => {
    const deadline = AbortSignal.timeout(config.installTimeoutMs)
    const handle = subprocess.spawn({
      argv,
      cwd: config.runtimeDir,
      env,
      stdio: { stdin: 'ignore', stdout: { maxBytes: COLLECT_BYTES }, stderr: { maxBytes: COLLECT_BYTES } },
      graceMs: config.shutdownGraceMs,
      signal: AbortSignal.any([signal, deadline]),
    })
    const outcome = await handle.done
    if (signal.aborted) throw new Error(`${label} was cancelled`)
    if (deadline.aborted) throw new Error(`${label} exceeded installTimeoutMs ${config.installTimeoutMs}`)
    if (outcome.exitCode !== 0) {
      /* v8 ignore next -- stderr is always spawned in collect mode, so its reader exists. */
      const tail = lastLines(handle.collected.stderr?.readFrom(0).text ?? '', 3)
      const how = outcome.signal === null ? `exit ${outcome.exitCode}` : outcome.signal
      throw new Error(`${label} failed (${how})${tail === '' ? '' : `: ${tail}`}`)
    }
  }
}

/**
 * Keep the last non-empty lines of a diagnostic stream.
 * @param text - stream text.
 * @param count - lines to keep.
 * @returns the lines joined with " | ".
 */
export function lastLines(text: string, count: number): string {
  return text.split('\n').map(line => line.trim()).filter(line => line.length > 0).slice(-count).join(' | ')
}

/** Read the install marker; an absent or malformed marker means not installed. */
async function readMarker(path: string): Promise<InstallMarker | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    // An unreadable or absent marker is exactly the not-installed state.
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A torn or hand-edited marker is treated as no install at all.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const marker = parsed as Partial<InstallMarker>
  return marker.version === 1 ? marker as InstallMarker : undefined
}

/** Whether a path names a regular file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    // A missing path is simply not a file.
    return false
  }
}
