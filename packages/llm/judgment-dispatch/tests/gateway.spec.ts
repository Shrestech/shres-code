import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { remoteMethods } from '@shres-code/shres-code-typert-protocol'
import { FileSettingsProvider } from '@shres-code/shres-code-settings-file'
import { settingsNamespace } from '@shres-code/shres-code-settings'
import { declareJudgmentConsumer, JUDGMENT_SETTINGS_NAMESPACE, judgmentConsumerId } from '@shres-code/shres-code-judgment'
import JudgmentDispatch, { currentHost, JudgmentEnginesGateway } from '../src/index.ts'
import { FakeEngine } from './fake-engine.ts'
import type { FakeEngineConfig } from './fake-engine.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** A root context with the file-backed settings provider and the dispatcher selecting `alpha`. */
async function boot(): Promise<{ ctx: Context; gateway: JudgmentEnginesGateway; events: () => number }> {
  const ctx = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'shres-judgment-gateway-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }), async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  let count = 0
  ctx.on('judgment/engines-updated', () => {
    count += 1
  })
  await ctx.plugin(JudgmentDispatch, { defaultEngine: 'alpha' })
  const gateway: unknown = ctx.get('judgmentEnginesRemote')
  if (!(gateway instanceof JudgmentEnginesGateway)) throw new Error('the judgmentEngines Remote is not mounted')
  return { ctx, gateway, events: () => count }
}

/** Mount one fake engine. */
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

describe('the judgmentEngines Remote', () => {
  it('publishes one snapshot method under the judgmentEngines namespace', async () => {
    const { gateway } = await boot()
    expect(gateway.typertRemote).toMatchObject({ serviceKey: 'judgmentEnginesRemote', namespace: 'judgmentEngines' })
    expect(remoteMethods(gateway)).toEqual([{ method: 'snapshot', invocation: { kind: 'direct' } }])
  })

  it('lists every engine with its descriptor facts and live status, the selection, and the declared consumers', async () => {
    const { ctx, gateway } = await boot()
    await engine(ctx, {
      id: 'alpha',
      describe: { egress: 'remote', label: 'Alpha', models: { fast: 'a-fast', accurate: 'a-acc' }, destination: 'api.alpha.test', terms: 'https://alpha.test/terms' },
    })
    const beta = await engine(ctx, { id: 'beta', fitting: true, host: 'darwin-arm64', status: { state: 'not-installed', detail: 'run /beta install' } })
    await engine(ctx, { id: 'gamma', host: 'any' })
    await ctx.plugin({
      name: 'consumer',
      apply: (inner: Context) => {
        declareJudgmentConsumer(inner, judgmentConsumerId('worker-escalation'))
      },
    })
    await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { overrides: { 'worker-escalation': 'gamma' } })

    const snapshot = gateway.snapshot()

    expect(snapshot).toEqual({
      engines: [
        {
          id: 'alpha', label: 'Alpha', egress: 'remote', calibration: 'calibrated', supportsFitting: false, host: 'any', runsOnThisHost: true,
          terms: 'https://alpha.test/terms', models: { fast: 'a-fast', accurate: 'a-acc' }, destination: 'api.alpha.test', state: 'ready',
        },
        {
          id: 'beta', label: 'Fake beta', egress: 'none', calibration: 'calibrated', supportsFitting: true, host: 'darwin-arm64',
          runsOnThisHost: currentHost() === 'darwin-arm64', state: 'not-installed', detail: 'run /beta install',
        },
        { id: 'gamma', label: 'Fake gamma', egress: 'none', calibration: 'calibrated', supportsFitting: false, host: 'any', runsOnThisHost: true, state: 'ready' },
      ],
      selection: { enabled: true, engine: 'alpha', overrides: { 'worker-escalation': 'gamma' } },
      consumers: ['worker-escalation'],
      thisHost: currentHost(),
    })
    beta.setStatus({ state: 'ready' })
    expect(gateway.snapshot().engines[1]).toMatchObject({ state: 'ready' })
    expect(gateway.snapshot().engines[1]).not.toHaveProperty('detail')
  })

  it('reports an empty override map and returns detached copies', async () => {
    const { ctx, gateway } = await boot()
    await engine(ctx, { id: 'alpha', describe: { models: { fast: 'x', accurate: 'y' } } })
    const first = gateway.snapshot()
    expect(first.selection).toEqual({ enabled: true, engine: 'alpha', overrides: {} })
    ;(first.engines[0]?.models as { fast: string }).fast = 'mutated'
    expect(gateway.snapshot().engines[0]?.models).toEqual({ fast: 'x', accurate: 'y' })
  })

  it('announces judgment/engines-updated on engine, status, and consumer-declaration changes and judgment selection commits only', async () => {
    const { ctx, events } = await boot()
    const start = events()
    const alpha = await engine(ctx, { id: 'alpha' })
    expect(events()).toBe(start + 1)
    alpha.setStatus({ state: 'unavailable', detail: 'down' })
    expect(events()).toBe(start + 2)

    const consumer = await ctx.plugin({
      name: 'model-router-consumer',
      apply: (inner: Context) => {
        declareJudgmentConsumer(inner, judgmentConsumerId('model-router'))
      },
    })
    expect(events()).toBe(start + 3)
    await consumer.dispose()
    expect(events()).toBe(start + 4)

    await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { enabled: false })
    expect(events()).toBe(start + 5)
    ctx.emit('settings/updated', settingsNamespace('other-namespace'), {}, {}, 'update')
    expect(events()).toBe(start + 5)
  })
})
