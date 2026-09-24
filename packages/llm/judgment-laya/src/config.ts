/**
 * Explicit configuration resolution for the local Laya judgment provider.
 *
 * @module @shres-code/shres-code-judgment-laya/config
 */

import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shresHomePath } from '@shres-code/shres-code-home-paths'
import { MAX_TIMER_DELAY_MS } from '@shres-code/shres-code-timeout'
import type { LayaJudgmentConfig, LayaJudgmentModel, LayaRestartPolicy } from './types.ts'

/** Default inference precision; FP16 matched upstream Laya on 63/63 validation questions. */
export const DEFAULT_DTYPE = 'float16'
/** Default `uv` executable, looked up on PATH. */
export const DEFAULT_UV_PATH = 'uv'
/** Default Python version; laya-mlx requires 3.11 or newer. */
export const DEFAULT_PYTHON = '3.11'
/** Default questions per inference batch, laya-mlx's own default. */
export const DEFAULT_BATCH_SIZE = 16
/** Default startup deadline, covering a cold model load and manifest verification. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 120_000
/** Largest accepted startup deadline. */
export const MAX_STARTUP_TIMEOUT_MS = 600_000
/** Default per-request deadline. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 2_000
/** Default SIGTERM-to-SIGKILL grace. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 5_000
/** Default deadline for each install step, including the checkpoint download. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 1_800_000
/** Default request body cap, matching the Shield wire default. */
export const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024
/** Default response body cap, matching the Shield wire default. */
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
/** Default restart budget. */
export const DEFAULT_RESTART: Readonly<Required<LayaRestartPolicy>> = Object.freeze({
  maxRestarts: 5,
  windowMs: 600_000,
  backoffMs: 1_000,
  maxBackoffMs: 30_000,
})

const CONFIG_KEYS = new Set([
  'model', 'checkpointContext', 'dtype', 'runtimeDir', 'hfHome', 'gatewayProject', 'uvPath', 'python',
  'batchSize', 'startupTimeoutMs', 'requestTimeoutMs', 'shutdownGraceMs', 'installTimeoutMs',
  'maxRequestBytes', 'maxResponseBytes', 'restart',
])
const MODEL_KEYS = new Set(['repo', 'revision', 'manifestSha256'])
const RESTART_KEYS = new Set(['maxRestarts', 'windowMs', 'backoffMs', 'maxBackoffMs'])

/** Default locations applied when the composition names none. */
export interface LayaDefaultLocations {
  /** Runtime directory default: `<SHRES_HOME>/runtimes/laya-gateway`. */
  readonly runtimeDir: string
  /** Gateway project default: the repository's `python/laya-gateway`. */
  readonly gatewayProject: string
}

/**
 * Locations used when the composition omits them.
 * @returns the runtime directory under the Shres home and the repository gateway project.
 */
export function defaultLocations(): LayaDefaultLocations {
  return {
    runtimeDir: shresHomePath('runtimes', 'laya-gateway'),
    gatewayProject: fileURLToPath(new URL('../../../../python/laya-gateway', import.meta.url)),
  }
}

/** Facts the provider uses for installation, launch, and every ask. */
export interface ResolvedLayaJudgmentConfig {
  /** The pinned checkpoint. */
  readonly model: Readonly<LayaJudgmentModel>
  /** Artifact id every gateway response must report: `repo@revision`. */
  readonly modelId: string
  /** Token window the gateway must report. */
  readonly checkpointContext: 512 | 1024
  /** Inference precision. */
  readonly dtype: 'float16' | 'float32'
  /** Runtime directory. */
  readonly runtimeDir: string
  /** Hugging Face home. */
  readonly hfHome: string
  /** Gateway project directory. */
  readonly gatewayProject: string
  /** `uv` executable. */
  readonly uvPath: string
  /** Python version. */
  readonly python: string
  /** Questions per inference batch. */
  readonly batchSize: number
  /** Startup deadline. */
  readonly startupTimeoutMs: number
  /** Per-request deadline. */
  readonly requestTimeoutMs: number
  /** Stop grace. */
  readonly shutdownGraceMs: number
  /** Install step deadline. */
  readonly installTimeoutMs: number
  /** Request body cap. */
  readonly maxRequestBytes: number
  /** Response body cap. */
  readonly maxResponseBytes: number
  /** Restart budget. */
  readonly restart: Readonly<Required<LayaRestartPolicy>>
  /** Virtual environment directory: `<runtimeDir>/venv`. */
  readonly venvDir: string
  /** uv package cache used by every install-time uv command: `<runtimeDir>/uv-cache`. */
  readonly uvCacheDir: string
  /** uv-managed CPython installs the virtual environment uses: `<runtimeDir>/python`. */
  readonly pythonInstallDir: string
  /** Virtual environment interpreter. */
  readonly pythonPath: string
  /** Install marker: `<runtimeDir>/install.json`. */
  readonly markerPath: string
  /** Verified checkpoint directory under `<hfHome>/checkpoints`. */
  readonly modelDir: string
  /** Manifest pinning the checkpoint: `<gatewayProject>/manifests/<revision>.json`. */
  readonly manifestPath: string
  /** Hash-locked dependency file: `<gatewayProject>/uv.lock`. */
  readonly lockPath: string
}

/**
 * Resolve and validate the provider configuration.
 *
 * @param config - raw composition configuration.
 * @param locations - defaults for the runtime directory and gateway project.
 * @returns detached facts used by the provider.
 * @throws Error naming an unknown key, a missing or malformed pin, a relative
 *   path, or an out-of-range limit.
 */
export function resolveConfig(
  config: LayaJudgmentConfig,
  locations: LayaDefaultLocations = defaultLocations(),
): ResolvedLayaJudgmentConfig {
  validateKeys(config, CONFIG_KEYS, 'LayaJudgmentConfig')
  const model = resolveModel(config.model)
  // Composition values arrive from YAML, so the typed fields are checked here.
  const checkpointContext: unknown = config.checkpointContext
  if (checkpointContext !== 512 && checkpointContext !== 1024) {
    throw new Error('LayaJudgmentConfig.checkpointContext must be 512 or 1024')
  }
  const dtype: unknown = config.dtype ?? DEFAULT_DTYPE
  if (dtype !== 'float16' && dtype !== 'float32') {
    throw new Error('LayaJudgmentConfig.dtype must be "float16" or "float32"')
  }
  const runtimeDir = absolutePath('runtimeDir', config.runtimeDir ?? locations.runtimeDir)
  const hfHome = absolutePath('hfHome', config.hfHome ?? join(runtimeDir, 'hf'))
  const gatewayProject = absolutePath('gatewayProject', config.gatewayProject ?? locations.gatewayProject)
  const uvPath = config.uvPath ?? DEFAULT_UV_PATH
  if (typeof uvPath !== 'string' || uvPath.length === 0) {
    throw new Error('LayaJudgmentConfig.uvPath must be a non-empty string')
  }
  const python = config.python ?? DEFAULT_PYTHON
  if (typeof python !== 'string' || !/^\d+\.\d+$/.test(python)) {
    throw new Error('LayaJudgmentConfig.python must be a major.minor version such as "3.11"')
  }
  const batchSize = integer('batchSize', config.batchSize ?? DEFAULT_BATCH_SIZE, 64)
  const startupTimeoutMs = integer('startupTimeoutMs', config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, MAX_STARTUP_TIMEOUT_MS)
  const requestTimeoutMs = integer('requestTimeoutMs', config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, MAX_TIMER_DELAY_MS)
  const shutdownGraceMs = integer('shutdownGraceMs', config.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS, MAX_TIMER_DELAY_MS)
  const installTimeoutMs = integer('installTimeoutMs', config.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS, MAX_TIMER_DELAY_MS)
  const maxRequestBytes = integer('maxRequestBytes', config.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES, Number.MAX_SAFE_INTEGER)
  const maxResponseBytes = integer('maxResponseBytes', config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 64 * 1024 * 1024)
  const restart = resolveRestart(config.restart)
  const venvDir = join(runtimeDir, 'venv')
  return {
    model,
    modelId: `${model.repo}@${model.revision}`,
    checkpointContext,
    dtype,
    runtimeDir,
    hfHome,
    gatewayProject,
    uvPath,
    python,
    batchSize,
    startupTimeoutMs,
    requestTimeoutMs,
    shutdownGraceMs,
    installTimeoutMs,
    maxRequestBytes,
    maxResponseBytes,
    restart,
    venvDir,
    uvCacheDir: join(runtimeDir, 'uv-cache'),
    pythonInstallDir: join(runtimeDir, 'python'),
    pythonPath: join(venvDir, 'bin', 'python'),
    markerPath: join(runtimeDir, 'install.json'),
    modelDir: join(hfHome, 'checkpoints', `${model.repo.replace('/', '__')}@${model.revision}`),
    manifestPath: join(gatewayProject, 'manifests', `${model.revision}.json`),
    lockPath: join(gatewayProject, 'uv.lock'),
  }
}

/** Validate and detach the checkpoint pin. */
function resolveModel(value: unknown): Readonly<LayaJudgmentModel> {
  if (!isRecord(value)) throw new Error('LayaJudgmentConfig.model must be an object')
  validateKeys(value, MODEL_KEYS, 'LayaJudgmentConfig.model')
  const { repo, revision, manifestSha256 } = value
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('LayaJudgmentConfig.model.repo must be a Hugging Face owner/name')
  }
  if (typeof revision !== 'string' || !/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error('LayaJudgmentConfig.model.revision must be a 40-character lowercase commit sha')
  }
  if (typeof manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifestSha256)) {
    throw new Error('LayaJudgmentConfig.model.manifestSha256 must be 64 lowercase hexadecimal characters')
  }
  return Object.freeze({ repo, revision, manifestSha256 })
}

/** Validate the restart budget over its defaults. */
function resolveRestart(value: unknown): Readonly<Required<LayaRestartPolicy>> {
  if (value === undefined) return DEFAULT_RESTART
  if (!isRecord(value)) throw new Error('LayaJudgmentConfig.restart must be an object')
  validateKeys(value, RESTART_KEYS, 'LayaJudgmentConfig.restart')
  const policy = { ...DEFAULT_RESTART, ...value as LayaRestartPolicy }
  const resolved = {
    maxRestarts: integer('restart.maxRestarts', policy.maxRestarts, 1_000),
    windowMs: integer('restart.windowMs', policy.windowMs, MAX_TIMER_DELAY_MS),
    backoffMs: integer('restart.backoffMs', policy.backoffMs, MAX_TIMER_DELAY_MS),
    maxBackoffMs: integer('restart.maxBackoffMs', policy.maxBackoffMs, MAX_TIMER_DELAY_MS),
  }
  if (resolved.maxBackoffMs < resolved.backoffMs) {
    throw new Error('LayaJudgmentConfig.restart.maxBackoffMs must be at least restart.backoffMs')
  }
  return Object.freeze(resolved)
}

/** Require one absolute path. */
function absolutePath(name: string, value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error(`LayaJudgmentConfig.${name} must be an absolute path`)
  }
  return value
}

/** Require one positive safe integer no larger than `max`. */
function integer(name: string, value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new Error(`LayaJudgmentConfig.${name} must be a positive integer no greater than ${max}`)
  }
  return value as number
}

/** Reject stale or misspelled config keys before defaults hide them. */
function validateKeys(value: object, keys: ReadonlySet<string>, name: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new Error(`${name}: unknown key "${key}"`)
  }
}

/** Whether a value is a JSON object rather than null or an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
