import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSubprocess } from '@shres-code/shres-code-subprocess-local/src/spawn.ts'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@shres-code/shres-code-subprocess'
import { resolveConfig } from '../src/config.ts'
import type { ResolvedLayaJudgmentConfig } from '../src/config.ts'
import { LayaGatewaySupervisor } from '../src/supervisor.ts'
import type { LaunchPreflight, SupervisorLogger } from '../src/supervisor.ts'
import type { LayaGatewayStatus, LayaJudgmentConfig } from '../src/types.ts'

/** Absolute path of the fake gateway script. */
export const FAKE_GATEWAY = fileURLToPath(new URL('./fixtures/fake-gateway.mjs', import.meta.url))
/** Pinned revision used by every test configuration. */
export const REVISION = 'f'.repeat(40)
/** Manifest digest used by every test configuration. */
export const MANIFEST_SHA = 'a'.repeat(64)
/** Repository used by every test configuration. */
export const REPO = 'owner/laya-test'
/** Model id the fake gateway must report. */
export const MODEL_ID = `${REPO}@${REVISION}`

/** Behavior written to fake-behavior.json. */
export interface FakeBehavior {
  model?: string
  manifestSha256?: string
  maxSequenceTokens?: number
  readinessDelayMs?: number
  noReadiness?: boolean
  readinessLine?: string
  exitBeforeReady?: number
  stderr?: string
  healthStatus?: number
  healthModel?: string
  smokeStatus?: number
  smokeDelayMs?: number
  readinessSplitMs?: number
  readinessRaw?: string
  crashAfterMs?: number
  crashExitCode?: number
  answerDelayMs?: number
  choice?: string
  routeProbability?: number
  recordEnvTo?: string
  recordLaunchesTo?: string
  recordRequestsTo?: string
  ignoreSigterm?: boolean
}

/** A temporary runtime directory removed after the test. */
export async function tempRuntime(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'judgment-laya-')))
}

/** Write the fake gateway's behavior file. */
export async function writeBehavior(runtimeDir: string, behavior: FakeBehavior = {}): Promise<void> {
  await mkdir(runtimeDir, { recursive: true })
  await writeFile(join(runtimeDir, 'fake-behavior.json'), JSON.stringify({
    model: MODEL_ID,
    manifestSha256: MANIFEST_SHA,
    maxSequenceTokens: 1024,
    ...behavior,
  }))
}

/** Resolve a test configuration rooted at one runtime directory. */
export function testConfig(runtimeDir: string, overrides: Partial<LayaJudgmentConfig> = {}): ResolvedLayaJudgmentConfig {
  return resolveConfig({
    model: { repo: REPO, revision: REVISION, manifestSha256: MANIFEST_SHA },
    checkpointContext: 1024,
    runtimeDir,
    gatewayProject: join(runtimeDir, 'gateway'),
    startupTimeoutMs: 10_000,
    requestTimeoutMs: 5_000,
    shutdownGraceMs: 500,
    restart: { maxRestarts: 2, windowMs: 60_000, backoffMs: 20, maxBackoffMs: 40 },
    ...overrides,
  })
}

/** A preflight that launches the fake gateway with the runtime directory as its working directory. */
export function fakePreflight(runtimeDir: string, env: Record<string, string | undefined> = {}): () => Promise<LaunchPreflight> {
  return () => Promise.resolve({
    kind: 'launch',
    plan: { argv: [process.execPath, FAKE_GATEWAY], cwd: runtimeDir, env },
  })
}

/** A logger that records messages. */
export function recordingLogger(): SupervisorLogger & { errors: unknown[][]; warnings: unknown[][] } {
  const errors: unknown[][] = []
  const warnings: unknown[][] = []
  return {
    errors,
    warnings,
    error: (...args: unknown[]) => { errors.push(args) },
    warn: (...args: unknown[]) => { warnings.push(args) },
  }
}

/** A spawner that records every spec and handle. */
export interface RecordingSpawner {
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  handles: SubprocessHandle[]
  specs: SubprocessSpawnSpec[]
}

/** Spawner that records every handle it creates. */
export function recordingSpawner(): RecordingSpawner {
  const handles: SubprocessHandle[] = []
  const specs: SubprocessSpawnSpec[] = []
  return {
    handles,
    specs,
    spawn: (spec) => {
      specs.push(spec)
      const handle = spawnSubprocess(spec)
      handles.push(handle)
      return handle
    },
  }
}

/** A supervisor over the fake gateway with recording collaborators. */
export function fakeSupervisor(runtimeDir: string, options: {
  config?: ResolvedLayaJudgmentConfig
  preflight?: () => Promise<LaunchPreflight>
  redact?: (state: string) => string | Promise<string>
} = {}): {
  supervisor: LayaGatewaySupervisor
  spawner: ReturnType<typeof recordingSpawner>
  logger: ReturnType<typeof recordingLogger>
  statuses: LayaGatewayStatus[]
} {
  const spawner = recordingSpawner()
  const logger = recordingLogger()
  const supervisor = new LayaGatewaySupervisor({
    config: options.config ?? testConfig(runtimeDir),
    preflight: options.preflight ?? fakePreflight(runtimeDir),
    spawn: spawner.spawn,
    redact: options.redact ?? (state => state),
    logger,
  })
  const statuses: LayaGatewayStatus[] = []
  supervisor.onStatus(status => statuses.push(status))
  return { supervisor, spawner, logger, statuses }
}

/** Wait until a predicate holds, polling. */
export async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached before the test deadline')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Whether a process id is alive. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH: the process is gone.
    return false
  }
}

/** Remove a temporary directory. */
export async function cleanup(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}
/** A complete fake installation: gateway project, fake `uv`, and a fake interpreter template. */
export interface FakeInstallation {
  /** Gateway project directory holding pyproject, lock, and the pinned manifest. */
  readonly gatewayProject: string
  /** Fake `uv` executable. */
  readonly uvPath: string
  /** SHA-256 of the written manifest bytes. */
  readonly manifestSha256: string
}

/**
 * Build a fake installation under `root`. The fake `uv venv` copies an
 * interpreter script into the venv; that script answers `install` by creating
 * the destination directory and otherwise runs the fake gateway. `uv sync`
 * first creates `uv-sync-started` in the behavior directory, then sleeps for
 * the seconds in `uv-sync-sleep` and exits with the code in `uv-sync-exit`
 * when those files exist.
 */
export async function fakeInstallation(root: string): Promise<FakeInstallation> {
  const { createHash } = await import('node:crypto')
  const { chmod } = await import('node:fs/promises')
  const gatewayProject = join(root, 'gateway')
  await mkdir(join(gatewayProject, 'manifests'), { recursive: true })
  await writeFile(join(gatewayProject, 'pyproject.toml'), '[project]\nname = "shres-laya-gateway"\n')
  await writeFile(join(gatewayProject, 'uv.lock'), 'version = 1\n')
  const manifest = JSON.stringify({ repo: REPO, revision: REVISION, checkpointContext: 1024, files: {} })
  await writeFile(join(gatewayProject, 'manifests', `${REVISION}.json`), manifest)
  const bin = join(root, 'bin')
  await mkdir(bin, { recursive: true })
  const pythonTemplate = join(bin, 'python-template')
  await writeFile(pythonTemplate, [
    '#!/bin/sh',
    'if [ "$3" = "install" ]; then mkdir -p "$7"; echo \'{"ok":true}\'; exit 0; fi',
    `exec "${process.execPath}" "${FAKE_GATEWAY}"`,
    '',
  ].join('\n'))
  const uvPath = join(bin, 'uv')
  await writeFile(uvPath, [
    '#!/bin/sh',
    'case "$1" in',
    `  venv) mkdir -p "$5/bin" && cp "${pythonTemplate}" "$5/bin/python" && chmod 755 "$5/bin/python" ;;`,
    '  sync) : > uv-sync-started; if [ -f uv-sync-sleep ]; then sleep "$(cat uv-sync-sleep)"; fi; if [ -f uv-sync-exit ]; then echo "uv sync: resolution failed" >&2; exit "$(cat uv-sync-exit)"; fi ;;',
    'esac',
    '',
  ].join('\n'))
  await chmod(uvPath, 0o755)
  return { gatewayProject, uvPath, manifestSha256: createHash('sha256').update(manifest).digest('hex') }
}
