import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import { SettingsFieldError } from '@shres-code/shres-code-settings'
import { FileSettingsProvider } from '@shres-code/shres-code-settings-file'
import {
  declareJudgmentConsumer,
  JUDGMENT_SETTINGS_NAMESPACE,
  JudgmentError,
  judgmentConsumerId,
  judgmentEngineId,
} from '@shres-code/shres-code-judgment'
import JudgmentDispatch, { resolveConfig } from '../src/index.ts'
import { FakeEngine } from './fake-engine.ts'
import type { FakeEngineConfig } from './fake-engine.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** A root context that is disposed after the test. */
function root(): Context {
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  return ctx
}

/** Attach the real file-backed settings provider in a fresh directory. */
async function withSettings(ctx: Context): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'shres-judgment-dispatch-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
}

/** Mount one fake engine and return it. */
async function engine(ctx: Context, config: FakeEngineConfig): Promise<FakeEngine> {
  let created: FakeEngine | undefined
  await ctx.plugin({
    name: `fake-${config.id}`,
    inject: ['judgmentEngines'],
    apply: (inner: Context) => {
      created = new FakeEngine(inner, config)
    },
  })
  if (created === undefined) throw new Error('the fake engine did not mount')
  return created
}

/**
 * Mount one consumer plugin that declares its consumer id.
 * @returns the consumer's fiber, whose disposal ends the declaration.
 */
async function consumer(ctx: Context, id: string): Promise<{ dispose(): Promise<unknown> }> {
  return ctx.plugin({
    name: `consumer-${id}`,
    apply: (inner: Context) => {
      declareJudgmentConsumer(inner, judgmentConsumerId(id))
    },
  })
}

/** Commit a document the settings provider observed in storage, as a file reload does. */
function publish(ctx: Context, doc: Record<string, unknown>): void {
  ;(ctx.settings as unknown as { publish(document: Record<string, unknown>): void }).publish(doc)
}

/** The failure an operation rejected with, asserted to be a judgment failure. */
async function failure(operation: () => Promise<unknown>): Promise<JudgmentError> {
  try {
    await operation()
  } catch (error: unknown) {
    if (error instanceof JudgmentError) return error
    throw error
  }
  throw new Error('the operation resolved instead of failing')
}

const ASK = { state: 'state', questions: [] }

describe('configuration', () => {
  it('requires a defaultEngine and rejects unknown keys by name', () => {
    expect(() => resolveConfig({} as never)).toThrow(/defaultEngine must name the registry id/)
    expect(() => resolveConfig({ defaultEngine: '' })).toThrow(/defaultEngine must name the registry id/)
    expect(() => resolveConfig({ defaultEngine: 'laya', extra: 1 } as never)).toThrow(/unknown key "extra"/)
    expect(resolveConfig({ defaultEngine: 'laya' })).toEqual({ defaultEngine: 'laya' })
  })

  it('fails a direct mount that names no config', async () => {
    const ctx = root()
    await expect(ctx.plugin(JudgmentDispatch)).rejects.toThrow(/defaultEngine/)
  })

  it('seeds the settings section from defaultEngine without a settings service', async () => {
    const ctx = root()
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'alpha' })

    expect(ctx.judgment.settings()).toEqual({ enabled: true, engine: 'alpha' })
    expect(ctx.judgment).toBeInstanceOf(JudgmentDispatch)
  })
})

describe('routing', () => {
  it('routes every ask to the selected engine and stamps its registry id', async () => {
    const ctx = root()
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'alpha' })
    const alpha = await engine(ctx, { id: 'alpha' })
    const beta = await engine(ctx, { id: 'beta' })

    const result = await ctx.judgment.ask(ASK)

    expect(result).toEqual({ answers: [], engine: 'fake-alpha', model: 'alpha-1', latencyMs: 1, engineId: 'alpha' })
    expect(alpha.asks).toHaveLength(1)
    expect(beta.asks).toHaveLength(0)
  })

  it('fails UNCONFIGURED for an unregistered selection and logs it once', async () => {
    const ctx = root()
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => ctx.logger)
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'missing' })
    await engine(ctx, { id: 'beta' })

    const first = await failure(() => ctx.judgment.ask(ASK))
    const second = await failure(() => ctx.judgment.ask(ASK))

    expect(first.code).toBe('UNCONFIGURED')
    expect(first.message).toBe('judgment engine "missing" is not composed')
    expect(second.code).toBe('UNCONFIGURED')
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]?.[1])).toBe('missing')
  })

  it('fails UNAVAILABLE with the status detail and never falls back to another engine', async () => {
    const ctx = root()
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'local' })
    const local = await engine(ctx, { id: 'local', status: { state: 'not-installed', detail: 'run the install action' } })
    const remote = await engine(ctx, { id: 'remote' })

    const failed = await failure(() => ctx.judgment.ask(ASK))

    expect(failed.code).toBe('UNAVAILABLE')
    expect(failed.message).toBe('judgment engine "local" is not-installed: run the install action')
    expect(local.asks).toHaveLength(0)
    expect(remote.asks).toHaveLength(0)

    local.setStatus({ state: 'starting' })
    expect((await failure(() => ctx.judgment.ask(ASK))).message).toBe('judgment engine "local" is starting')

    local.setStatus({ state: 'ready' })
    expect((await ctx.judgment.ask(ASK)).engineId).toBe('local')
    expect(remote.asks).toHaveLength(0)
  })

  it('propagates the selected engine own failure with its registry id attached', async () => {
    const ctx = root()
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'alpha' })
    const cause = new Error('socket hang up')
    const thrown = new JudgmentError('INVALID_ANSWER', 'alpha answered garbage', { cause })
    const beta = await engine(ctx, { id: 'beta' })
    await engine(ctx, { id: 'alpha', failWith: thrown })

    const failed = await failure(() => ctx.judgment.ask(ASK))
    expect(failed).toMatchObject({ code: 'INVALID_ANSWER', message: 'alpha answered garbage', engineId: 'alpha' })
    expect(failed.cause).toBe(cause)
    expect(beta.asks).toHaveLength(0)
  })

  it('stamps its own routing failures and leaves an already-stamped or non-judgment failure unchanged', async () => {
    const ctx = root()
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'missing' })
    expect(await failure(() => ctx.judgment.ask(ASK))).toMatchObject({ code: 'UNCONFIGURED', engineId: 'missing' })

    const stamped = new JudgmentError('UNAVAILABLE', 'nested dispatch', { engineId: judgmentEngineId('inner') })
    const nested = root()
    await nested.plugin(JudgmentDispatch, { defaultEngine: 'outer' })
    await engine(nested, { id: 'outer', failWith: stamped })
    await expect(nested.judgment.ask(ASK)).rejects.toBe(stamped)

    const foreign = new TypeError('engine broke its contract')
    const broken = root()
    await broken.plugin(JudgmentDispatch, { defaultEngine: 'broken' })
    await engine(broken, { id: 'broken', failWith: foreign })
    await expect(broken.judgment.ask(ASK)).rejects.toBe(foreign)
  })

  it('routes a consumer with an override to its own engine', async () => {
    const ctx = root()
    await withSettings(ctx)
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'alpha' })
    const alpha = await engine(ctx, { id: 'alpha' })
    const beta = await engine(ctx, { id: 'beta' })
    await consumer(ctx, 'worker-escalation')
    await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { overrides: { 'worker-escalation': 'beta' } })

    const overridden = await ctx.judgment.ask({ ...ASK, consumer: judgmentConsumerId('worker-escalation') })
    const other = await ctx.judgment.ask({ ...ASK, consumer: judgmentConsumerId('model-router') })
    const anonymous = await ctx.judgment.ask(ASK)

    expect(overridden.engineId).toBe('beta')
    expect(other.engineId).toBe('alpha')
    expect(anonymous.engineId).toBe('alpha')
    expect(beta.asks).toHaveLength(1)
    expect(alpha.asks).toHaveLength(2)
    expect((ctx.judgment as JudgmentDispatch).selectedEngine(judgmentConsumerId('worker-escalation'))).toBe(judgmentEngineId('beta'))
  })
})

describe('fitting', () => {
  it('exposes fitting only while the deployment-wide selection supports it', async () => {
    const ctx = root()
    await withSettings(ctx)
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'plain' })
    await engine(ctx, { id: 'plain' })
    const fitter = await engine(ctx, { id: 'fitter', fitting: true })

    expect(ctx.judgment.fitting).toBeUndefined()

    await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: 'fitter' })
    const fitting = ctx.judgment.fitting
    expect(fitting).toBeDefined()
    expect(ctx.judgment.fitting).toBe(fitting)

    const answered = await fitting!.ask({ states: ['s'], questions: [] })
    expect(answered.kind).toBe('answered')
    expect(answered.kind === 'answered' ? answered.result.engineId : undefined).toBe('fitter')

    const unfit = await fitting!.ask({ states: ['unfit'], questions: [] })
    expect(unfit.kind === 'unfit' ? unfit.engineId : undefined).toBe('fitter')
    expect(fitter.fittedAsks).toHaveLength(2)
  })

  it('routes a fitting capability read before a selection change to the newly selected engine', async () => {
    const ctx = root()
    await withSettings(ctx)
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'fitter' })
    const fitter = await engine(ctx, { id: 'fitter', fitting: true })
    const plain = await engine(ctx, { id: 'plain' })
    const fitting = ctx.judgment.fitting!

    await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: 'plain' })
    const failed = await failure(() => fitting.ask({ states: ['s'], questions: [] }))

    expect(ctx.judgment.fitting).toBeUndefined()
    expect(failed.code).toBe('UNAVAILABLE')
    expect(failed.message).toBe('judgment engine "plain" selected for consumer "(none)" does not support fitting')
    expect(fitter.fittedAsks).toHaveLength(0)
    expect(plain.asks).toHaveLength(0)
  })

  it('reports no fitting for an unregistered selection', async () => {
    const ctx = root()
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'missing' })

    expect(ctx.judgment.fitting).toBeUndefined()
  })

  it('fails a fitted ask whose consumer override selects an engine without fitting', async () => {
    const ctx = root()
    await withSettings(ctx)
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'fitter' })
    await engine(ctx, { id: 'fitter', fitting: true })
    const plain = await engine(ctx, { id: 'plain' })
    await consumer(ctx, 'worker-escalation')
    await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { overrides: { 'worker-escalation': 'plain' } })

    const failed = await failure(() => ctx.judgment.fitting!.ask({ states: ['s'], questions: [], consumer: judgmentConsumerId('worker-escalation') }))

    expect(failed.code).toBe('UNAVAILABLE')
    expect(failed.message).toBe('judgment engine "plain" selected for consumer "worker-escalation" does not support fitting')
    expect(plain.asks).toHaveLength(0)
  })

  it('resolves fitting per consumer: an override to a fitting engine fits while the default does not', async () => {
    const ctx = root()
    await withSettings(ctx)
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'plain' })
    const plain = await engine(ctx, { id: 'plain' })
    const fitter = await engine(ctx, { id: 'fitter', fitting: true })
    await consumer(ctx, 'model-router')
    await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { overrides: { 'model-router': 'fitter' } })
    const router = judgmentConsumerId('model-router')

    expect(ctx.judgment.fitting).toBeUndefined()
    expect(ctx.judgment.fittingFor()).toBeUndefined()
    expect(ctx.judgment.fittingFor(judgmentConsumerId('worker-escalation'))).toBeUndefined()
    const fitting = ctx.judgment.fittingFor(router)
    expect(fitting).toBeDefined()
    const answered = await fitting!.ask({ states: ['s'], questions: [], consumer: router })
    expect(answered.kind === 'answered' ? answered.result.engineId : undefined).toBe('fitter')
    expect(fitter.fittedAsks).toHaveLength(1)
    expect(plain.asks).toHaveLength(0)
    expect(ctx.judgment.selectedEngine(router)).toBe('fitter')
    expect(ctx.judgment.selectedEngine()).toBe('plain')
  })

  it('stamps the routed engine on a fitted ask failure', async () => {
    const ctx = root()
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'fitter' })
    await engine(ctx, { id: 'fitter', fitting: true, failWith: new JudgmentError('INPUT_TOO_LARGE', 'too big') })
    const failed = await failure(() => ctx.judgment.fitting!.ask({ states: ['s'], questions: [] }))
    expect(failed).toMatchObject({ code: 'INPUT_TOO_LARGE', message: 'too big', engineId: 'fitter' })
  })

  it('fails a fitted ask to an engine that is not ready', async () => {
    const ctx = root()
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'fitter' })
    const fitter = await engine(ctx, { id: 'fitter', fitting: true })
    const fitting = ctx.judgment.fitting!
    fitter.setStatus({ state: 'unavailable', detail: 'gateway exited 1' })

    const failed = await failure(() => fitting.ask({ states: ['s'], questions: [] }))

    expect(failed.code).toBe('UNAVAILABLE')
    expect(failed.message).toBe('judgment engine "fitter" is unavailable: gateway exited 1')
    expect(failed.engineId).toBe('fitter')
    expect(fitter.fittedAsks).toHaveLength(0)
  })
})

describe('settings writes', () => {
  it('rejects a selection no provider registered, naming the field', async () => {
    const ctx = root()
    await withSettings(ctx)
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'alpha' })
    await engine(ctx, { id: 'alpha' })
    await consumer(ctx, 'worker-escalation')

    const engineRefusal = await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: 'laya' }).then(() => undefined, (error: unknown) => error)
    const overrideRefusal = await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { overrides: { 'worker-escalation': 'laya' } })
      .then(() => undefined, (error: unknown) => error)

    expect(engineRefusal).toBeInstanceOf(SettingsFieldError)
    expect(engineRefusal).toMatchObject({ path: ['engine'], message: 'judgment: engine names engine "laya", which is not composed' })
    expect(overrideRefusal).toBeInstanceOf(SettingsFieldError)
    expect(overrideRefusal).toMatchObject({
      path: ['overrides', 'worker-escalation'],
      message: 'judgment: overrides.worker-escalation names engine "laya", which is not composed',
    })
    expect(ctx.judgment.settings()).toEqual({ enabled: true, engine: 'alpha' })
  })

  it('rejects an override for a consumer that does not name itself, even one naming a ready engine', async () => {
    const ctx = root()
    await withSettings(ctx)
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'remote' })
    await engine(ctx, { id: 'remote' })
    const local = await engine(ctx, { id: 'local' })

    const refusal = await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { overrides: { 'model-router': 'local' } })
      .then(() => undefined, (error: unknown) => error)

    expect(refusal).toBeInstanceOf(SettingsFieldError)
    expect(refusal).toMatchObject({
      path: ['overrides', 'model-router'],
      message: 'judgment: consumer "model-router" does not name itself in judgment asks; this override would have no effect',
    })
    expect(ctx.judgment.settings()).toEqual({ enabled: true, engine: 'remote' })
    expect((await ctx.judgment.ask({ ...ASK, consumer: judgmentConsumerId('model-router') })).engineId).toBe('remote')
    expect(local.asks).toHaveLength(0)
  })

  it('rejects an override once its consumer stops declaring itself', async () => {
    const ctx = root()
    await withSettings(ctx)
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'alpha' })
    await engine(ctx, { id: 'alpha' })
    await engine(ctx, { id: 'beta' })
    const declared = await consumer(ctx, 'compaction-jev')
    await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { overrides: { 'compaction-jev': 'beta' } })
    expect(ctx.judgmentEngines.consumers()).toEqual(['compaction-jev'])

    await declared.dispose()

    expect(ctx.judgmentEngines.hasConsumer('compaction-jev')).toBe(false)
    await expect(ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { overrides: { 'compaction-jev': 'alpha' } }))
      .rejects.toMatchObject({ path: ['overrides', 'compaction-jev'] })
  })

  it('applies a reloaded document whose override names an undeclared consumer, and ignores that override', async () => {
    const ctx = root()
    await withSettings(ctx)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'alpha' })
    await engine(ctx, { id: 'alpha' })
    const beta = await engine(ctx, { id: 'beta' })
    await engine(ctx, { id: 'local' })

    publish(ctx, { judgment: { engine: 'local', overrides: { 'model-router': 'beta' } } })

    expect(ctx.judgment.settings()).toEqual({ enabled: true, engine: 'local', overrides: { 'model-router': 'beta' } })
    expect(warn).not.toHaveBeenCalled()
    expect((await ctx.judgment.ask({ ...ASK, consumer: judgmentConsumerId('model-router') })).engineId).toBe('local')
    expect(beta.asks).toHaveLength(0)
  })

  it('lets an unrelated write through a stale override, and names the key a write adds', async () => {
    const ctx = root()
    await withSettings(ctx)
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'alpha' })
    await engine(ctx, { id: 'alpha' })
    await engine(ctx, { id: 'beta' })
    await engine(ctx, { id: 'gamma' })
    const escalation = await consumer(ctx, 'worker-escalation')
    await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { overrides: { 'worker-escalation': 'beta' } })
    await escalation.dispose()

    await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: 'gamma' })
    expect(ctx.judgment.settings()).toEqual({ enabled: true, engine: 'gamma', overrides: { 'worker-escalation': 'beta' } })

    await expect(ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { overrides: { 'model-router': 'beta' } }))
      .rejects.toMatchObject({
        path: ['overrides', 'model-router'],
        message: 'judgment: consumer "model-router" does not name itself in judgment asks; this override would have no effect',
      })
  })

  it('lets a write through a stale unregistered engine it leaves unchanged', async () => {
    const ctx = root()
    await withSettings(ctx)
    vi.spyOn(ctx.logger, 'error').mockImplementation(() => ctx.logger)
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'alpha' })
    await engine(ctx, { id: 'alpha' })
    await consumer(ctx, 'compaction-jev')
    publish(ctx, { judgment: { engine: 'missing' } })

    await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { overrides: { 'compaction-jev': 'alpha' } })

    expect(ctx.judgment.settings()).toEqual({ enabled: true, engine: 'missing', overrides: { 'compaction-jev': 'alpha' } })
    expect((await ctx.judgment.ask({ ...ASK, consumer: judgmentConsumerId('compaction-jev') })).engineId).toBe('alpha')
  })

  it('rejects an engine whose descriptor names another host, and accepts any or a matching host', async () => {
    const ctx = root()
    await withSettings(ctx)
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'alpha' })
    await engine(ctx, { id: 'alpha' })
    await engine(ctx, { id: 'mac', host: 'darwin-arm64' })
    await engine(ctx, { id: 'anywhere', host: 'any' })
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
    cleanups.push(() => {
      Object.defineProperty(process, 'platform', platform)
      Object.defineProperty(process, 'arch', arch)
      return Promise.resolve()
    })

    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    Object.defineProperty(process, 'arch', { ...arch, value: 'x64' })
    await expect(ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: 'mac' }))
      .rejects.toThrow('judgment: engine "mac" requires darwin-arm64')
    await consumer(ctx, 'judgment-guardrails')
    await expect(ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { overrides: { 'judgment-guardrails': 'mac' } }))
      .rejects.toMatchObject({ path: ['overrides', 'judgment-guardrails'], message: 'judgment: engine "mac" requires darwin-arm64' })
    await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: 'anywhere' })
    expect(ctx.judgment.settings().engine).toBe('anywhere')

    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    Object.defineProperty(process, 'arch', { ...arch, value: 'arm64' })
    await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: 'mac' })
    expect(ctx.judgment.settings().engine).toBe('mac')
  })

  it('rejects an empty engine id through the Definition shape check', async () => {
    const ctx = root()
    await withSettings(ctx)
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'alpha' })
    await engine(ctx, { id: 'alpha' })

    await expect(ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: '' })).rejects.toThrow('judgment: engine must name an engine id')
  })

  it('applies a reloaded engine switch to an engine that is not composed; asks fail UNCONFIGURED without fallback, reported once', async () => {
    const ctx = root()
    await withSettings(ctx)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => ctx.logger)
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'typesafe' })
    const remote = await engine(ctx, { id: 'typesafe' })

    publish(ctx, { judgment: { engine: 'laya' } })

    expect(ctx.judgment.settings()).toEqual({ enabled: true, engine: 'laya' })
    expect(warn).not.toHaveBeenCalled()
    expect((await failure(() => ctx.judgment.ask(ASK))).code).toBe('UNCONFIGURED')
    expect((await failure(() => ctx.judgment.ask(ASK))).code).toBe('UNCONFIGURED')
    expect(remote.asks).toHaveLength(0)
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]?.[1])).toBe('laya')
  })

  it('keeps a stored selection whose provider registers after the dispatcher', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shres-judgment-dispatch-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'settings.yaml')
    const first = root()
    await first.plugin(FileSettingsProvider, { path, watch: false })
    await first.plugin(JudgmentDispatch, { defaultEngine: 'alpha' })
    await engine(first, { id: 'alpha' })
    await engine(first, { id: 'beta' })
    await first.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: 'beta' })

    const second = root()
    await second.plugin(FileSettingsProvider, { path, watch: false })
    await second.plugin(JudgmentDispatch, { defaultEngine: 'alpha' })
    await engine(second, { id: 'alpha' })
    const beta = await engine(second, { id: 'beta' })

    expect((await second.judgment.ask(ASK)).engineId).toBe('beta')
    expect(beta.asks).toHaveLength(1)
  })
})

describe('registry lifecycle', () => {
  it('releases an engine with its provider fiber and rejects duplicates and mismatched descriptors', async () => {
    const ctx = root()
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'alpha' })
    const seen: number[] = []
    const unsubscribe = ctx.judgmentEngines.subscribe(() => {
      seen.push(ctx.judgmentEngines.list().length)
    })
    const fiber = await ctx.plugin({
      name: 'fake-alpha',
      inject: ['judgmentEngines'],
      apply: (inner: Context) => {
        new FakeEngine(inner, { id: 'alpha' })
      },
    })

    expect(ctx.judgmentEngines.list().map(descriptor => descriptor.id)).toEqual(['alpha'])
    const alpha = ctx.judgmentEngines.get(judgmentEngineId('alpha'))!
    expect(() => ctx.judgmentEngines.register(judgmentEngineId('alpha'), alpha)).toThrow('judgment engine "alpha" is already registered')
    expect(() => ctx.judgmentEngines.register(judgmentEngineId('other'), alpha)).toThrow('judgment engine "other" cannot register a descriptor naming "alpha"')
    expect(() => ctx.judgmentEngines.register(judgmentEngineId('alpha'), { ...alpha, descriptor: { ...alpha.descriptor, supportsFitting: true } }))
      .toThrow('judgment engine "alpha" declares supportsFitting true but does not expose fitting')

    await fiber.dispose()

    expect(ctx.judgmentEngines.get(judgmentEngineId('alpha'))).toBeUndefined()
    expect(seen).toEqual([1, 0])
    expect((await failure(() => ctx.judgment.ask(ASK))).code).toBe('UNCONFIGURED')
    unsubscribe()
  })

  it('logs a failing registry subscriber as a warning and keeps notifying', async () => {
    const ctx = root()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'alpha' })
    let calls = 0
    ctx.judgmentEngines.subscribe(() => {
      calls += 1
      throw new Error('sync boom')
    })
    ctx.judgmentEngines.subscribe(() => Promise.reject(new Error('async boom')))
    const alpha = await engine(ctx, { id: 'alpha' })

    alpha.setStatus({ state: 'starting' })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(calls).toBe(2)
    // A rejection is reported a microtask after its notification, so only the multiset is fixed.
    expect(warn.mock.calls.map(call => String(call[1])).sort()).toEqual([
      'Error: async boom', 'Error: async boom', 'Error: sync boom', 'Error: sync boom',
    ])
  })

  it('reports nothing at settle when the settle barrier rejects, and reports at the first routed ask', async () => {
    const ctx = root()
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => ctx.logger)
    let reject: ((reason: Error) => void) | undefined
    ctx.provide('loader', {
      await: () => new Promise<void>((_resolve, rejectSettle) => {
        reject = rejectSettle
      }),
    })
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'missing' })

    reject?.(new Error('a plugin elsewhere failed'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(error).not.toHaveBeenCalled()

    expect((await failure(() => ctx.judgment.ask(ASK))).code).toBe('UNCONFIGURED')
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('withdraws ctx.judgment and ctx.judgmentEngines with the dispatcher fiber', async () => {
    const ctx = root()
    const fiber = await ctx.plugin(JudgmentDispatch, { defaultEngine: 'alpha' })

    await fiber.dispose()

    expect(ctx.get('judgment')).toBeUndefined()
    expect(ctx.get('judgmentEngines')).toBeUndefined()
  })
})
