import { existsSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import JudgmentDispatch from '@shres-code/shres-code-judgment-dispatch'
import LocalSubprocessRuntime from '@shres-code/shres-code-subprocess-local'
import { remoteMethods } from '@shres-code/shres-code-typert-protocol'
import { SessionId } from '@shres-code/shres-code-session/types'
import { LAYA_ENGINE_DESCRIPTOR, LAYA_ENGINE_ID, LayaGatewayRemote, LayaJudgmentEngine, layaEngineStatus } from '../src/index.ts'
import { alive, cleanup, fakeInstallation, MODEL_ID, REPO, REVISION, tempRuntime, until, writeBehavior } from './helpers.ts'
import type { FakeInstallation } from './helpers.ts'

// laya-mlx is Apple-silicon only; the fake gateway is not, so the host check
// is pinned for these process-level tests.
vi.mock('../src/installation.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/installation.ts')>(),
  currentHost: () => ({ platform: 'darwin', arch: 'arm64' }),
}))

let root: string
let runtimeDir: string
let fake: FakeInstallation
let ctx: Context | undefined

beforeEach(async () => {
  root = await tempRuntime()
  runtimeDir = join(root, 'runtime')
  fake = await fakeInstallation(root)
  await writeBehavior(runtimeDir, { manifestSha256: fake.manifestSha256 })
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await cleanup(root)
})

/** Mount the subprocess runtime, the dispatcher selecting `laya`, and the provider over the fake installation. */
async function mount(): Promise<{ ctx: Context; engine: LayaJudgmentEngine }> {
  ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(JudgmentDispatch, { defaultEngine: 'laya' })
  await ctx.plugin(LayaJudgmentEngine, {
    model: { repo: REPO, revision: REVISION, manifestSha256: fake.manifestSha256 },
    checkpointContext: 1024,
    runtimeDir,
    gatewayProject: fake.gatewayProject,
    uvPath: fake.uvPath,
    startupTimeoutMs: 10_000,
    requestTimeoutMs: 5_000,
    shutdownGraceMs: 500,
    installTimeoutMs: 10_000,
    restart: { maxRestarts: 2, windowMs: 60_000, backoffMs: 20, maxBackoffMs: 40 },
  })
  const engine = ctx.judgmentEngines.get(LAYA_ENGINE_ID)?.engine
  if (!(engine instanceof LayaJudgmentEngine)) throw new Error('the laya engine is not registered')
  return { ctx, engine }
}

const PROCESS_TIMEOUT_MS = 30_000

/** Deployment redactor stub counting its consultations. */
class StubRedactor extends Service {
  static calls = 0

  constructor(ctx: Context) {
    super(ctx, 'judgmentRedactor')
  }

  redactState(state: string): string {
    StubRedactor.calls += 1
    return state.replaceAll('secret', '[redacted]')
  }
}

describe('layaEngineStatus', () => {
  it('reports a stopped gateway as unavailable with its detail and passes every other state through', () => {
    expect(layaEngineStatus({ state: 'stopped', detail: 'stopped for install' })).toEqual({ state: 'unavailable', detail: 'stopped for install' })
    expect(layaEngineStatus({ state: 'ready' })).toEqual({ state: 'ready' })
    expect(layaEngineStatus({ state: 'not-installed', detail: 'run /laya install' })).toEqual({ state: 'not-installed', detail: 'run /laya install' })
    expect(layaEngineStatus({ state: 'unsupported-host', detail: 'needs Apple silicon' })).toEqual({ state: 'unsupported-host', detail: 'needs Apple silicon' })
  })
})

describe('LayaJudgmentEngine', { timeout: PROCESS_TIMEOUT_MS }, () => {
  it('reports not-installed, installs on request, then serves ctx.judgment', async () => {
    const { ctx: mounted, engine } = await mount()
    const entry = mounted.judgmentEngines.get(LAYA_ENGINE_ID)
    expect(LAYA_ENGINE_DESCRIPTOR).toEqual({
      id: 'laya', label: 'Laya (local MLX)', egress: 'none', calibration: 'calibrated', supportsFitting: true, host: 'darwin-arm64',
    })
    expect(entry?.descriptor).toEqual({ ...LAYA_ENGINE_DESCRIPTOR, models: { fast: MODEL_ID, accurate: MODEL_ID } })
    await until(() => engine.status().state === 'not-installed')
    expect(engine.status().detail).toBe('Laya is not installed; run /laya install')
    expect(entry?.status()).toEqual({ state: 'not-installed', detail: 'Laya is not installed; run /laya install' })
    await expect(mounted.judgment.ask({ state: 's', questions: [] })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: 'judgment engine "laya" is not-installed: Laya is not installed; run /laya install',
    })
    await expect(engine.ask({ state: 's', questions: [] })).rejects.toMatchObject({ code: 'UNAVAILABLE' })

    const first = engine.install()
    expect(engine.install()).toBe(first)
    const result = await first
    expect(result.modelDir).toBe(engine.config.modelDir)
    expect((await stat(engine.config.markerPath)).isFile()).toBe(true)
    await until(() => engine.status().state === 'ready')

    const answered = await engine.ask({ state: 'hello', questions: [] })
    expect(answered).toMatchObject({ engine: 'shield', model: MODEL_ID, answers: [] })
    const fitted = await engine.fitting.ask({ states: ['hello'], questions: [] })
    expect(fitted.kind).toBe('answered')
    const dispatched = await mounted.judgment.ask({ state: 'hello', questions: [] })
    expect(dispatched).toMatchObject({ engineId: 'laya', engine: 'shield', model: MODEL_ID })
    const dispatchedFit = await mounted.judgment.fitting!.ask({ states: ['hello'], questions: [] })
    expect(dispatchedFit.kind === 'answered' ? dispatchedFit.result.engineId : undefined).toBe('laya')
  })

  it('reports the gateway stopped for an install as unavailable in the registry and announces each change', async () => {
    await writeFile(join(runtimeDir, 'uv-sync-sleep'), '2')
    const { ctx: mounted, engine } = await mount()
    const entry = mounted.judgmentEngines.get(LAYA_ENGINE_ID)!
    await until(() => engine.status().state === 'not-installed')
    const announced: string[] = []
    mounted.judgmentEngines.subscribe(() => {
      announced.push(entry.status().state)
    })

    const install = engine.install()
    await until(() => engine.status().state === 'stopped')
    expect(entry.status()).toEqual({ state: 'unavailable', detail: 'stopped for install' })
    await expect(mounted.judgment.ask({ state: 's', questions: [] })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: 'judgment engine "laya" is unavailable: stopped for install',
    })

    await install
    await until(() => engine.status().state === 'ready')
    expect(announced[0]).toBe('unavailable')
    expect(announced.at(-1)).toBe('ready')
  })

  it('reports a failed install step and stays not-installed', async () => {
    await writeFile(join(runtimeDir, 'uv-sync-exit'), '7')
    const { engine } = await mount()
    await until(() => engine.status().state === 'not-installed')

    await expect(engine.install()).rejects.toThrow('uv sync failed (exit 7): uv sync: resolution failed')
    await until(() => engine.status().state === 'not-installed')
    expect(engine.status().detail).toBe('Laya is not installed; run /laya install')
  })

  it('withdraws the engine and stops the gateway process when its fiber disposes', async () => {
    const { ctx: mounted, engine } = await mount()
    await engine.install()
    await until(() => engine.status().state === 'ready')
    const events: string[] = []
    engine.onStatus(status => events.push(status.state))
    const pids = await gatewayPids()

    await mounted.fiber.dispose()
    ctx = undefined

    expect(mounted.get('judgmentEngines')).toBeUndefined()
    expect(pids.length).toBeGreaterThan(0)
    expect(pids.every(pid => !alive(pid))).toBe(true)
    expect(events).toEqual([])
    expect(engine.status()).toEqual({ state: 'stopped', detail: 'disposed' })
  })

  it('consults the deployment redactor once before the state leaves the process', async () => {
    const requests = join(root, 'requests.jsonl')
    await writeBehavior(runtimeDir, { manifestSha256: fake.manifestSha256, recordRequestsTo: requests })
    const { ctx: mounted, engine } = await mount()
    await mounted.plugin(StubRedactor)
    await engine.install()
    await until(() => engine.status().state === 'ready')
    StubRedactor.calls = 0

    await engine.ask({
      state: 'a secret plan',
      questions: [],
      correlation: { sessionId: SessionId('session-laya-capture'), consultKey: 'turn:1/step:1' },
    })

    const last = (await readFile(requests, 'utf8')).trim().split('\n').at(-1) ?? '{}'
    const recorded = JSON.parse(last) as { body: Record<string, unknown> }
    expect(recorded.body.state).toBe('a [redacted] plan')
    // Field selection, not a word search: a whole-input dump would leak without
    // naming `correlation` and would add keys beyond the local wire vocabulary.
    expect(Object.keys(recorded.body).sort()).toEqual(['model', 'questions', 'state'])
    expect(JSON.stringify(recorded.body)).not.toContain('sessionId')
    expect(JSON.stringify(recorded.body)).not.toContain('consultKey')
    expect(recorded.body).toEqual({ state: 'a [redacted] plan', model: MODEL_ID, questions: [] })
    expect(StubRedactor.calls).toBe(1)
  })

  it('cancels a running install when disposed and waits for it to settle', async () => {
    await writeFile(join(runtimeDir, 'uv-sync-sleep'), '30')
    const { ctx: mounted, engine } = await mount()
    await until(() => engine.status().state === 'not-installed')
    const install = engine.install().catch((error: unknown) => error)
    await until(() => existsSync(join(runtimeDir, 'uv-sync-started')))

    await mounted.fiber.dispose()
    ctx = undefined

    expect(await install).toMatchObject({ message: 'uv sync was cancelled' })
    expect(engine.status()).toEqual({ state: 'stopped', detail: 'disposed' })
  })

  it('restart() relaunches a gateway whose restart budget is exhausted', async () => {
    await writeBehavior(runtimeDir, { manifestSha256: fake.manifestSha256, exitBeforeReady: 1 })
    const { engine } = await mount()
    await engine.install().catch(() => undefined)
    await until(() => /exhausted/.test(engine.status().detail ?? ''), 20_000)
    expect(engine.lastExit()).toMatchObject({ exitCode: 1 })

    await writeBehavior(runtimeDir, { manifestSha256: fake.manifestSha256 })
    await engine.restart()
    await until(() => engine.status().state === 'ready')
  })
})

describe('the laya Remote', { timeout: PROCESS_TIMEOUT_MS }, () => {
  /** The Remote service the engine mounted. */
  function remote(mounted: Context): LayaGatewayRemote {
    const service: unknown = mounted.get('layaGatewayRemote')
    if (!(service instanceof LayaGatewayRemote)) throw new Error('the laya Remote is not mounted')
    return service
  }

  it('publishes status, install, and restart under the laya namespace', async () => {
    const { ctx: mounted } = await mount()
    const service = remote(mounted)
    expect(service.typertRemote).toMatchObject({ serviceKey: 'layaGatewayRemote', namespace: 'laya' })
    expect(remoteMethods(service).map(method => method.method).sort()).toEqual(['gatewayStatus', 'installGateway', 'restartGateway'])
  })

  it('reports the pin and state, installs, and restarts through the Remote', async () => {
    const { ctx: mounted, engine } = await mount()
    const service = remote(mounted)
    await until(() => engine.status().state === 'not-installed')
    expect(service.gatewayStatus()).toEqual({
      state: 'not-installed',
      detail: 'Laya is not installed; run /laya install',
      modelId: MODEL_ID,
      checkpointContext: 1024,
      dtype: 'float16',
      installing: false,
    })

    const installed = service.installGateway()
    expect(service.gatewayStatus().installing).toBe(true)
    await expect(installed).resolves.toMatchObject({ modelDir: engine.config.modelDir, manifestSha256: fake.manifestSha256 })
    await until(() => engine.status().state === 'ready')
    expect(service.gatewayStatus()).toEqual({ state: 'ready', modelId: MODEL_ID, checkpointContext: 1024, dtype: 'float16', installing: false })

    const restarted = await service.restartGateway()
    expect(restarted).toMatchObject({ modelId: MODEL_ID, installing: false })
    await until(() => engine.status().state === 'ready')
  })

  it('names the last exit while the gateway is not ready', async () => {
    await writeBehavior(runtimeDir, { manifestSha256: fake.manifestSha256, exitBeforeReady: 3 })
    const { ctx: mounted, engine } = await mount()
    await engine.install().catch(() => undefined)
    await until(() => engine.status().state === 'unavailable' && engine.lastExit() !== undefined, 20_000)

    expect(remote(mounted).gatewayStatus()).toMatchObject({
      state: 'unavailable',
      lastExit: { exitCode: 3, signal: null, timedOut: false },
    })
  })
})

/** Process ids of running fake gateways started from this test's runtime. */
async function gatewayPids(): Promise<number[]> {
  const { execFile } = await import('node:child_process')
  const output = await new Promise<string>((resolve) => {
    execFile('pgrep', ['-f', 'fake-gateway.mjs'], (_error, stdout) => {
      resolve(stdout)
    })
  })
  const candidates = output.split('\n').map(Number).filter(pid => pid > 0)
  const owned: number[] = []
  for (const pid of candidates) {
    try {
      const cwd = await new Promise<string>((resolve) => {
        execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], (_error, stdout) => {
          resolve(stdout)
        })
      })
      if (cwd.includes(runtimeDir)) owned.push(pid)
    } catch {
      // A process that exited between pgrep and lsof is not owned.
    }
  }
  return owned
}
