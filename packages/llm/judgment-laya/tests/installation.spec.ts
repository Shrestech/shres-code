import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSubprocess } from '@shres-code/shres-code-subprocess-local/src/spawn.ts'
import type { ResolvedLayaJudgmentConfig } from '../src/config.ts'
import {
  currentHost,
  gatewayEnv,
  hostSupported,
  installLaya,
  lastLines,
  preflightLaunch,
  sha256File,
  subprocessRunner,
  unsupportedHostDetail,
} from '../src/installation.ts'
import type { CommandRunner, HostFacts } from '../src/installation.ts'
import { cleanup, REVISION, tempRuntime, testConfig } from './helpers.ts'

const APPLE: HostFacts = { platform: 'darwin', arch: 'arm64' }
const LINUX: HostFacts = { platform: 'linux', arch: 'x64' }

let runtime: string
let config: ResolvedLayaJudgmentConfig

/** Write a gateway project with a manifest and lock, and resolve a config pinning that manifest. */
async function project(): Promise<ResolvedLayaJudgmentConfig> {
  const gateway = join(runtime, 'gateway')
  await mkdir(join(gateway, 'manifests'), { recursive: true })
  await writeFile(join(gateway, 'pyproject.toml'), '[project]\nname = "shres-laya-gateway"\n')
  await writeFile(join(gateway, 'uv.lock'), 'version = 1\n')
  const manifest = JSON.stringify({ repo: 'owner/laya-test', revision: REVISION, checkpointContext: 1024, files: {} })
  await writeFile(join(gateway, 'manifests', `${REVISION}.json`), manifest)
  const manifestSha256 = createHash('sha256').update(manifest).digest('hex')
  return testConfig(runtime, {
    model: { repo: 'owner/laya-test', revision: REVISION, manifestSha256 },
    uvPath: 'uv-under-test',
    installTimeoutMs: 5_000,
  })
}

/** One command a recording runner received. */
interface RecordedCommand {
  label: string
  argv: readonly string[]
  env: Readonly<Record<string, string | undefined>>
}

/** A runner that records commands and creates the venv interpreter on `uv venv`. */
function recordingRunner(options: { failAt?: string } = {}): CommandRunner & { calls: RecordedCommand[] } {
  const calls: RecordedCommand[] = []
  const run: CommandRunner = async (label, argv, env) => {
    calls.push({ label, argv, env })
    if (label === options.failAt) throw new Error(`${label} failed (exit 1): boom`)
    if (label === 'uv venv') {
      await mkdir(join(config.venvDir, 'bin'), { recursive: true })
      await writeFile(config.pythonPath, '')
    }
  }
  return Object.assign(run, { calls })
}

const resolveUv = (command: string): Promise<string> => Promise.resolve(`/opt/bin/${command}`)

beforeEach(async () => {
  runtime = await tempRuntime()
  config = await project()
})

afterEach(async () => {
  await cleanup(runtime)
})

describe('host facts', () => {
  it('supports Apple silicon only and explains other hosts', () => {
    expect(hostSupported(APPLE)).toBe(true)
    expect(hostSupported(LINUX)).toBe(false)
    expect(hostSupported({ platform: 'darwin', arch: 'x64' })).toBe(false)
    expect(unsupportedHostDetail(LINUX)).toBe('laya-mlx runs on Apple silicon (darwin-arm64) only; this host is linux-x64')
    expect(currentHost()).toEqual({ platform: process.platform, arch: process.arch })
  })
})

describe('gatewayEnv', () => {
  it('keeps the hub offline for serving and online only for the install download', () => {
    expect(gatewayEnv(config, 'offline')).toEqual({
      HF_HOME: config.hfHome,
      HF_HUB_OFFLINE: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
      TRANSFORMERS_OFFLINE: '1',
      PYTHONNOUSERSITE: '1',
      PYTHONUNBUFFERED: '1',
      PYTHONPATH: undefined,
      PYTHONHOME: undefined,
      VIRTUAL_ENV: undefined,
    })
    expect(gatewayEnv(config, 'online').HF_HUB_OFFLINE).toBe('0')
    expect(gatewayEnv(config, 'online').TRANSFORMERS_OFFLINE).toBe('1')
  })
})

describe('preflightLaunch', () => {
  it('refuses an unsupported host before reading anything', async () => {
    expect(await preflightLaunch(config, LINUX)).toEqual({ kind: 'unsupported-host', detail: unsupportedHostDetail(LINUX) })
  })

  it('reports a missing gateway project', async () => {
    const missing = testConfig(runtime, { gatewayProject: join(runtime, 'nowhere') })
    expect(await preflightLaunch(missing, APPLE)).toMatchObject({ kind: 'not-installed', detail: expect.stringMatching(/gateway project is missing/) as unknown })
  })

  it('reports not-installed until an install writes a matching marker', async () => {
    expect(await preflightLaunch(config, APPLE)).toEqual({ kind: 'not-installed', detail: 'Laya is not installed; run /laya install' })
    await writeFile(config.markerPath, '{')
    expect((await preflightLaunch(config, APPLE)).kind).toBe('not-installed')
    await writeFile(config.markerPath, '{"version":2}')
    expect((await preflightLaunch(config, APPLE)).kind).toBe('not-installed')
    await writeFile(config.markerPath, 'null')
    expect((await preflightLaunch(config, APPLE)).kind).toBe('not-installed')
  })

  it('launches offline with the pinned manifest after a completed install', async () => {
    await installLaya(config, { host: APPLE, resolveExecutable: resolveUv, run: recordingRunner() }, new AbortController().signal)
    const preflight = await preflightLaunch(config, APPLE)
    expect(preflight).toEqual({
      kind: 'launch',
      plan: {
        argv: [
          config.pythonPath, '-m', 'laya_gateway', 'serve',
          '--manifest', config.manifestPath,
          '--model-dir', config.modelDir,
          '--dtype', 'float16',
          '--batch-size', '16',
          '--max-request-bytes', '262144',
        ],
        cwd: runtime,
        env: gatewayEnv(config, 'offline'),
      },
    })
  })

  it('requires a reinstall after the lock or the pin changes, or the environment disappears', async () => {
    await installLaya(config, { host: APPLE, resolveExecutable: resolveUv, run: recordingRunner() }, new AbortController().signal)
    await writeFile(config.lockPath, 'version = 2\n')
    expect(await preflightLaunch(config, APPLE)).toMatchObject({ detail: expect.stringMatching(/dependency lock changed/) as unknown })
    await writeFile(config.lockPath, 'version = 1\n')
    const repinned = testConfig(runtime, { model: { ...config.model, manifestSha256: 'c'.repeat(64) } })
    expect(await preflightLaunch(repinned, APPLE))
      .toMatchObject({ detail: expect.stringMatching(/differs from the configured pin/) as unknown })
    await writeFile(config.pythonPath, '')
    const { rm } = await import('node:fs/promises')
    await rm(config.pythonPath)
    expect(await preflightLaunch(config, APPLE)).toMatchObject({ detail: expect.stringMatching(/environment is missing/) as unknown })
  })
})

describe('installLaya', () => {
  it('creates the environment, syncs the lock, downloads offline-verified weights, and writes the marker last', async () => {
    const run = recordingRunner()
    const result = await installLaya(config, { host: APPLE, resolveExecutable: resolveUv, run }, new AbortController().signal)

    expect(run.calls.map(call => call.label)).toEqual(['uv venv', 'uv sync', 'checkpoint download'])
    expect(run.calls[0]?.argv).toEqual(['/opt/bin/uv-under-test', 'venv', '--python', '3.11', '--allow-existing', config.venvDir])
    expect(run.calls[1]?.argv).toEqual(['/opt/bin/uv-under-test', 'sync', '--frozen', '--project', config.gatewayProject])
    expect(run.calls[1]?.env).toEqual({ UV_CACHE_DIR: config.uvCacheDir, UV_PROJECT_ENVIRONMENT: config.venvDir })
    expect(run.calls[2]?.argv).toEqual([config.pythonPath, '-m', 'laya_gateway', 'install', '--manifest', config.manifestPath, '--dest', config.modelDir])
    expect(run.calls[2]?.env.HF_HUB_OFFLINE).toBe('0')
    const marker = JSON.parse(await readFile(config.markerPath, 'utf8')) as Record<string, unknown>
    expect(marker).toMatchObject({
      version: 1,
      lockSha256: await sha256File(config.lockPath),
      repo: 'owner/laya-test',
      revision: REVISION,
      manifestSha256: config.model.manifestSha256,
      modelDir: config.modelDir,
    })
    expect(result).toEqual({ modelDir: config.modelDir, manifestSha256: config.model.manifestSha256, lockSha256: marker.lockSha256 })
  })

  it('keeps uv\'s package cache inside the runtime directory for every uv command', async () => {
    const run = recordingRunner()
    await installLaya(config, { host: APPLE, resolveExecutable: resolveUv, run }, new AbortController().signal)

    expect(config.uvCacheDir).toBe(join(runtime, 'uv-cache'))
    const uvCalls = run.calls.filter(call => call.argv[0] === '/opt/bin/uv-under-test')
    expect(uvCalls.map(call => call.label)).toEqual(['uv venv', 'uv sync'])
    for (const call of uvCalls) expect(call.env.UV_CACHE_DIR).toBe(join(runtime, 'uv-cache'))
  })

  it('refuses a manifest whose digest differs from the pin before running anything', async () => {
    const run = recordingRunner()
    const wrong = testConfig(runtime, { model: { ...config.model, manifestSha256: 'c'.repeat(64) } })
    await expect(installLaya(wrong, { host: APPLE, resolveExecutable: resolveUv, run }, new AbortController().signal))
      .rejects.toThrow(/model.manifestSha256 pins c{64}/)
    expect(run.calls).toEqual([])
  })

  it('refuses a missing manifest, an unsupported host, and a missing uv', async () => {
    const run = recordingRunner()
    const missing = testConfig(runtime, { model: { ...config.model, revision: 'e'.repeat(40) } })
    await expect(installLaya(missing, { host: APPLE, resolveExecutable: resolveUv, run }, new AbortController().signal))
      .rejects.toThrow(/no manifest pins revision e{40}/)
    await expect(installLaya(config, { host: LINUX, resolveExecutable: resolveUv, run }, new AbortController().signal))
      .rejects.toThrow(/Apple silicon/)
    await expect(installLaya(config, { host: APPLE, resolveExecutable: () => Promise.reject(new Error('ENOENT')), run }, new AbortController().signal))
      .rejects.toThrow(/uv executable "uv-under-test" was not found; install uv from https:\/\/docs.astral.sh\/uv\//)
    expect(run.calls).toEqual([])
  })

  it('writes no marker when a step fails', async () => {
    const run = recordingRunner({ failAt: 'checkpoint download' })
    await expect(installLaya(config, { host: APPLE, resolveExecutable: resolveUv, run }, new AbortController().signal))
      .rejects.toThrow(/checkpoint download failed/)
    expect((await preflightLaunch(config, APPLE)).kind).toBe('not-installed')
  })
})

describe('subprocessRunner', () => {
  const node = (script: string): string[] => [process.execPath, '-e', script]
  const runner = (): CommandRunner => subprocessRunner({ spawn: spec => spawnSubprocess(spec) }, config)

  it('resolves on exit 0', async () => {
    await expect(runner()('noop', node('process.exit(0)'), {}, new AbortController().signal)).resolves.toBeUndefined()
  })

  it('names the step, exit code, and last stderr lines on failure', async () => {
    const noisy = node('console.error("one"); console.error("two"); console.error("three"); console.error("four"); process.exit(2)')
    await expect(runner()('uv sync', noisy, {}, new AbortController().signal))
      .rejects.toThrow('uv sync failed (exit 2): two | three | four')
    await expect(runner()('silent', node('process.exit(5)'), {}, new AbortController().signal))
      .rejects.toThrow('silent failed (exit 5)')
    await expect(runner()('signalled', node('process.kill(process.pid, "SIGKILL")'), {}, new AbortController().signal))
      .rejects.toThrow('signalled failed (SIGKILL)')
  })

  it('passes explicit environment entries', async () => {
    const probe = node('process.exit(process.env.LAYA_PROBE === "yes" ? 0 : 9)')
    await expect(runner()('env', probe, { LAYA_PROBE: 'yes' }, new AbortController().signal)).resolves.toBeUndefined()
  })

  it('distinguishes cancellation from the install deadline', async () => {
    const hang = node('setTimeout(() => {}, 60_000)')
    const controller = new AbortController()
    const cancelled = runner()('download', hang, {}, controller.signal)
    setTimeout(() => {
      controller.abort()
    }, 50)
    await expect(cancelled).rejects.toThrow('download was cancelled')
    const short = subprocessRunner({ spawn: spec => spawnSubprocess(spec) }, testConfig(runtime, { installTimeoutMs: 100 }))
    await expect(short('download', hang, {}, new AbortController().signal)).rejects.toThrow('download exceeded installTimeoutMs 100')
  })
})

describe('lastLines', () => {
  it('keeps the last non-empty trimmed lines', () => {
    expect(lastLines('a\n\n  b  \nc\n', 2)).toBe('b | c')
    expect(lastLines('', 3)).toBe('')
  })
})
