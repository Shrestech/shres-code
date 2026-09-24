import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JudgmentError, judgmentQuestionId } from '@shres-code/shres-code-judgment'
import { LayaGatewaySupervisor, SMOKE_QUESTION_ID } from '../src/supervisor.ts'
import {
  alive,
  cleanup,
  fakePreflight,
  fakeSupervisor,
  MANIFEST_SHA,
  MODEL_ID,
  recordingLogger,
  tempRuntime,
  testConfig,
  until,
  writeBehavior,
} from './helpers.ts'

const ROUTE = judgmentQuestionId('route')
const CHOICE = {
  kind: 'choice' as const,
  id: ROUTE,
  instructions: 'Which route?',
  options: [{ option: 'keep-current' }, { option: 'flash' }],
}

let runtime: string
let disposers: Array<() => Promise<void>>

beforeEach(async () => {
  runtime = await tempRuntime()
  disposers = []
})

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose()
  await cleanup(runtime)
})

/** Start a supervisor over the fake gateway and dispose it after the test. */
function started(options: Parameters<typeof fakeSupervisor>[1] = {}): ReturnType<typeof fakeSupervisor> {
  const harness = fakeSupervisor(runtime, options)
  disposers.push(() => harness.supervisor.dispose())
  harness.supervisor.start()
  return harness
}

describe('LayaGatewaySupervisor readiness', () => {
  it('publishes ready only after the readiness line, the health check, and a smoke ask', async () => {
    const requests = join(runtime, 'requests.jsonl')
    await writeBehavior(runtime, { readinessDelayMs: 150, recordRequestsTo: requests })
    const { supervisor, statuses } = started()
    await until(() => supervisor.status().state === 'ready')

    expect(statuses.map(status => status.state)).toEqual(['starting', 'ready'])
    const smoke = JSON.parse((await readFile(requests, 'utf8')).trim()) as { path: string; body: { model: string; questions: Array<{ id: string }> } }
    expect(smoke.path).toBe('/v1/judgments')
    expect(smoke.body.model).toBe(MODEL_ID)
    expect(smoke.body.questions.map(question => question.id)).toEqual([SMOKE_QUESTION_ID])
  })

  it('answers asks and fitted asks through the one Shield wire client', async () => {
    await writeBehavior(runtime, { choice: 'flash' })
    const { supervisor } = started()
    await until(() => supervisor.status().state === 'ready')

    const result = await supervisor.ask({ state: 'rename a variable', questions: [CHOICE] })
    expect(result).toMatchObject({ engine: 'shield', model: MODEL_ID, answers: [{ kind: 'choice', option: 'flash' }] })
    const fitted = await supervisor.askFitted({ states: ['rename a variable'], questions: [CHOICE] })
    expect(fitted).toMatchObject({ kind: 'answered', fit: { selectedIndex: 0, limits: { manifestSha256: MANIFEST_SHA } } })
  })

  it('redacts the state once before it leaves the process', async () => {
    const requests = join(runtime, 'requests.jsonl')
    await writeBehavior(runtime, { recordRequestsTo: requests })
    const seen: string[] = []
    const { supervisor } = started({ redact: (state) => { seen.push(state); return state.replace('secret', '[x]') } })
    await until(() => supervisor.status().state === 'ready')
    await supervisor.ask({ state: 'a secret plan', questions: [CHOICE] })

    const bodies = (await readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { body: { state: string } })
    expect(bodies.at(-1)?.body.state).toBe('a [x] plan')
    expect(seen.filter(state => state === 'a secret plan')).toHaveLength(1)
  })

  it('refuses asks with UNAVAILABLE naming the status until ready', async () => {
    await writeBehavior(runtime, { noReadiness: true })
    const { supervisor } = started()
    await until(() => supervisor.status().state === 'starting')

    await expect(supervisor.ask({ state: 's', questions: [] })).rejects.toThrow(/judgment-laya gateway is starting/)
    await expect(supervisor.askFitted({ states: ['s'], questions: [] })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it.each([
    ['a foreign model', { model: 'owner/other@' + 'e'.repeat(40) }, /serves owner\/other/],
    ['a manifest mismatch', { manifestSha256: 'b'.repeat(64) }, /manifest mismatch/],
    ['a checkpoint context mismatch', { maxSequenceTokens: 512 }, /checkpoint context mismatch/],
    ['a readiness line without limits', { readinessLine: JSON.stringify({ ready: true, port: 1, model: MODEL_ID, manifestSha256: MANIFEST_SHA }) }, /manifest mismatch/],
  ])('treats %s as terminal: unavailable with no restart', async (_label, behavior, detail) => {
    const launches = join(runtime, 'launches.txt')
    await writeBehavior(runtime, { ...behavior, recordLaunchesTo: launches })
    const { supervisor } = started()
    await until(() => supervisor.status().state === 'unavailable')

    expect(supervisor.status().detail).toMatch(detail)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect((await readFile(launches, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('does not restart a gateway that exits with the checkpoint-mismatch code', async () => {
    const launches = join(runtime, 'launches.txt')
    await writeBehavior(runtime, { exitBeforeReady: 3, stderr: 'laya-gateway: checkpoint mismatch: model.safetensors', recordLaunchesTo: launches })
    const { supervisor } = started()
    await until(() => supervisor.status().state === 'unavailable')

    expect(supervisor.status().detail).toMatch(/exited with code 3; laya-gateway: checkpoint mismatch/)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect((await readFile(launches, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it.each([
    ['a malformed readiness line', { readinessLine: 'not json' }, /readiness line is not JSON/],
    ['a readiness line without ready', { readinessLine: '{"ready":false}' }, /does not report ready/],
    ['a readiness line without a port', { readinessLine: `{"ready":true,"port":0,"model":"${MODEL_ID}"}` }, /no valid port/],
    ['an oversize readiness line', { readinessRaw: 'x'.repeat(70_000) }, /readiness line exceeds 64 KiB/],
    ['a failed health check', { healthStatus: 500 }, /health check returned HTTP 500/],
    ['a health check naming another model', { healthModel: 'owner/other@x' }, /does not report the pinned model/],
    ['a refused smoke ask', { smokeStatus: 503 }, /HTTP 503/],
  ])('fails startup on %s and restarts within the budget', async (_label, behavior, detail) => {
    await writeBehavior(runtime, behavior)
    const { statuses } = started()
    await until(() => statuses.filter(status => status.state === 'unavailable').length >= 1)

    expect(statuses.find(status => status.state === 'unavailable')?.detail).toMatch(detail)
  })

  it('reassembles a readiness line split across stdout chunks', async () => {
    await writeBehavior(runtime, { readinessSplitMs: 100 })
    const { supervisor } = started()
    await until(() => supervisor.status().state === 'ready')
  })

  it('reports a spawn-level failure of the gateway program', async () => {
    const { supervisor } = started({
      preflight: () => Promise.resolve({ kind: 'launch', plan: { argv: [join(runtime, 'no-such-python')], cwd: runtime, env: {} } }),
    })
    await until(() => supervisor.status().state === 'unavailable')

    expect(supervisor.status().detail).toMatch(/the gateway failed to start: .*ENOENT/)
  })

  it('reports a non-Error preflight rejection as text', async () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the case under test is a non-Error rejection.
    const { supervisor } = started({ preflight: () => Promise.reject('disk gone') })
    await until(() => supervisor.status().state === 'unavailable')
    expect(supervisor.status().detail).toBe('launch preflight failed: disk gone')
  })

  it('ignores a preflight that settles after the attempt was stopped', async () => {
    const { supervisor, statuses } = started({
      preflight: () => new Promise((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('late'))
        }, 100)
      }),
    })
    await supervisor.stop('stopped early')
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(supervisor.status()).toEqual({ state: 'stopped', detail: 'stopped early' })
    expect(statuses.map(status => status.state)).toEqual(['starting', 'stopped'])
  })

  it('does not publish ready when the smoke ask answers after the attempt was stopped', async () => {
    const requests = join(runtime, 'requests.jsonl')
    await writeBehavior(runtime, { smokeDelayMs: 200, ignoreSigterm: true, recordRequestsTo: requests })
    const { supervisor, statuses } = started()
    await until(() => statuses.some(status => status.state === 'starting'))
    await until(() => {
      try {
        return readFileSync(requests, 'utf8').length > 0
      } catch {
        // The fake has not recorded the smoke request yet.
        return false
      }
    })

    await supervisor.stop('stopped during smoke')

    expect(statuses.map(status => status.state)).not.toContain('ready')
    expect(supervisor.status()).toEqual({ state: 'stopped', detail: 'stopped during smoke' })
  })

  it('records a startup timeout independently of the exit facts', async () => {
    await writeBehavior(runtime, { noReadiness: true })
    const { supervisor } = started({ config: testConfig(runtime, { startupTimeoutMs: 200 }) })
    await until(() => supervisor.exit() !== undefined)

    expect(supervisor.exit()).toMatchObject({ timedOut: true, exitCode: null, signal: 'SIGTERM' })
    expect(supervisor.status().detail).toMatch(/no readiness line within startupTimeoutMs 200/)
  })

  it('fails startup when the gateway exits before its readiness line', async () => {
    await writeBehavior(runtime, { exitBeforeReady: 4, stderr: 'laya-gateway: model load failed: RuntimeError: metal' })
    const { supervisor } = started()
    await until(() => supervisor.exit() !== undefined)

    expect(supervisor.exit()).toMatchObject({ exitCode: 4, signal: null, timedOut: false })
    expect(supervisor.exit()?.stderrTail).toContain('model load failed')
  })

  it('reports a preflight that refuses to launch without spawning', async () => {
    const { supervisor, spawner } = started({
      preflight: () => Promise.resolve({ kind: 'unsupported-host', detail: 'laya-mlx runs on Apple silicon (darwin-arm64) only; this host is linux-x64' }),
    })
    await until(() => supervisor.status().state === 'unsupported-host')

    expect(spawner.specs).toHaveLength(0)
    await expect(supervisor.ask({ state: 's', questions: [] })).rejects.toThrow(/unsupported-host: laya-mlx runs on Apple silicon/)
  })

  it('reports a preflight failure as unavailable', async () => {
    const { supervisor } = started({ preflight: () => Promise.reject(new Error('disk unreadable')) })
    await until(() => supervisor.status().state === 'unavailable')

    expect(supervisor.status().detail).toBe('launch preflight failed: disk unreadable')
  })

  it('reports a spawn that throws as unavailable', async () => {
    const harness = fakeSupervisor(runtime)
    disposers.push(() => harness.supervisor.dispose())
    const supervisor = new LayaGatewaySupervisor({
      config: testConfig(runtime),
      preflight: fakePreflight(runtime),
      spawn: () => { throw new Error('EAGAIN') },
      redact: state => state,
      logger: recordingLogger(),
    })
    disposers.push(() => supervisor.dispose())
    supervisor.start()
    await until(() => supervisor.status().state === 'unavailable')

    expect(supervisor.status().detail).toBe('the gateway could not be spawned: EAGAIN')
  })

  it('passes the launch plan environment to the gateway', async () => {
    const envFile = join(runtime, 'env.json')
    await writeBehavior(runtime, { recordEnvTo: envFile })
    const { supervisor } = started({ preflight: fakePreflight(runtime, { HF_HUB_OFFLINE: '1', HOME_MARKER: 'x' }) })
    await until(() => supervisor.status().state === 'ready')

    const env = JSON.parse(await readFile(envFile, 'utf8')) as Record<string, string>
    expect(env).toMatchObject({ HF_HUB_OFFLINE: '1', HOME_MARKER: 'x' })
  })
})

describe('LayaGatewaySupervisor crashes and restarts', () => {
  it('publishes unavailable before scheduling a restart, then recovers', async () => {
    const launches = join(runtime, 'launches.txt')
    await writeBehavior(runtime, { crashAfterMs: 150, recordLaunchesTo: launches })
    const { supervisor, statuses, logger } = started()
    await until(() => statuses.filter(status => status.state === 'ready').length >= 2)

    const states = statuses.map(status => status.state)
    const firstReady = states.indexOf('ready')
    expect(states.slice(firstReady, firstReady + 4)).toEqual(['ready', 'unavailable', 'starting', 'ready'])
    expect(statuses[firstReady + 1]?.detail).toMatch(/exited with code 1/)
    expect(logger.warnings.some(args => String(args[0]).includes('restarting the gateway in 20 ms'))).toBe(true)
    await supervisor.dispose()
  })

  it('exhausts the restart budget and stays unavailable', async () => {
    const launches = join(runtime, 'launches.txt')
    await writeBehavior(runtime, { exitBeforeReady: 1, recordLaunchesTo: launches })
    const { supervisor } = started()
    await until(() => /restart budget of 2 per 60000 ms exhausted; run \/laya restart/.test(supervisor.status().detail ?? ''))

    expect(supervisor.status().state).toBe('unavailable')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect((await readFile(launches, 'utf8')).trim().split('\n')).toHaveLength(3)
  })

  it('restart() resets the budget and relaunches', async () => {
    await writeBehavior(runtime, { exitBeforeReady: 1 })
    const { supervisor } = started()
    await until(() => /exhausted/.test(supervisor.status().detail ?? ''))
    await writeBehavior(runtime)
    await supervisor.restart()
    await until(() => supervisor.status().state === 'ready')

    expect(supervisor.status()).toEqual({ state: 'ready' })
  })

  it('fails an in-flight ask as UNAVAILABLE when the gateway dies during it', async () => {
    await writeBehavior(runtime, { answerDelayMs: 5_000, crashAfterMs: 400 })
    const { supervisor } = started()
    await until(() => supervisor.status().state === 'ready')
    const started_ = Date.now()

    const failure = await supervisor.ask({ state: 's', questions: [CHOICE] }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(JudgmentError)
    expect(failure).toMatchObject({ code: 'UNAVAILABLE' })
    // Whichever the ask observes first — the closed socket or the process
    // exit — it fails as UNAVAILABLE well before the 5 s answer delay.
    expect((failure as Error).message).toMatch(/gateway exited|judgment-laya request to http:\/\/127\.0\.0\.1:\d+ failed/)
    expect(Date.now() - started_).toBeLessThan(4_000)
  })
})

describe('LayaGatewaySupervisor disposal', () => {
  it('clears listeners first, fails in-flight asks, and awaits the process exit', async () => {
    await writeBehavior(runtime, { answerDelayMs: 5_000 })
    const { supervisor, spawner, statuses } = started()
    await until(() => supervisor.status().state === 'ready')
    const pid = spawner.handles[0]?.pid ?? -1
    const inflight = supervisor.ask({ state: 's', questions: [CHOICE] }).catch((error: unknown) => error)
    const before = statuses.length

    await supervisor.dispose()

    expect(alive(pid)).toBe(false)
    expect(statuses).toHaveLength(before)
    expect(await inflight).toMatchObject({ code: 'UNAVAILABLE', message: expect.stringMatching(/was disposed/) as unknown })
    expect(supervisor.status()).toEqual({ state: 'stopped', detail: 'disposed' })
    await expect(supervisor.ask({ state: 's', questions: [] })).rejects.toThrow(/stopped: disposed/)
  })

  it('escalates to SIGKILL for a gateway that ignores SIGTERM', async () => {
    await writeBehavior(runtime, { ignoreSigterm: true })
    const { supervisor, spawner } = started()
    await until(() => supervisor.status().state === 'ready')
    const pid = spawner.handles[0]?.pid ?? -1

    await supervisor.dispose()

    expect(alive(pid)).toBe(false)
    expect(supervisor.exit()?.signal).toBe('SIGKILL')
  })

  it('shares one disposal and never restarts afterwards', async () => {
    await writeBehavior(runtime)
    const { supervisor, spawner } = started()
    await until(() => supervisor.status().state === 'ready')

    await Promise.all([supervisor.dispose(), supervisor.dispose()])
    supervisor.start()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(spawner.specs).toHaveLength(1)
  })

  it('keeps the disposed status when stopped after disposal', async () => {
    await writeBehavior(runtime)
    const { supervisor } = started()
    await supervisor.dispose()
    await supervisor.stop('stopped for install')
    expect(supervisor.status()).toEqual({ state: 'stopped', detail: 'disposed' })
  })

  it('disposes a supervisor that never started', async () => {
    const { supervisor } = fakeSupervisor(runtime)
    await supervisor.dispose()
    expect(supervisor.status()).toEqual({ state: 'stopped', detail: 'disposed' })
  })

  it('stop() during startup abandons the attempt without publishing ready', async () => {
    await writeBehavior(runtime, { readinessDelayMs: 300 })
    const { supervisor, statuses } = started()
    await until(() => supervisor.status().state === 'starting')
    await supervisor.stop('stopped for install')
    await new Promise(resolve => setTimeout(resolve, 500))

    expect(statuses.map(status => status.state)).not.toContain('ready')
    expect(supervisor.status()).toEqual({ state: 'stopped', detail: 'stopped for install' })
  })

  it('contains a failing status listener', async () => {
    await writeBehavior(runtime)
    const harness = started()
    harness.supervisor.onStatus(() => { throw new Error('listener bug') })
    const off = harness.supervisor.onStatus(() => { throw new Error('removed') })
    off()
    await until(() => harness.supervisor.status().state === 'ready')

    expect(harness.logger.errors.map(args => (args[1] as Error).message)).toContain('listener bug')
    expect(harness.logger.errors.map(args => (args[1] as Error).message)).not.toContain('removed')
  })
})
