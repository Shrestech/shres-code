import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import Include from '@shres-code/cordis-plugin-include'
import Loader from '@shres-code/cordis-plugin-loader'
import { declareJudgmentConsumer, judgmentConsumerId } from '@shres-code/shres-code-judgment'
import { FileSettingsProvider } from '@shres-code/shres-code-settings-file'
import JudgmentDispatch from '../src/index.ts'
import { FakeEngine } from './fake-engine.ts'

const DISPATCH = '@shres-code/shres-code-judgment-dispatch'
const FAKE = './fake-engine.ts'
const SETTINGS = '@shres-code/shres-code-settings-file'
const GATED = './gated.ts'
const CONSUMER = './consumer.ts'

let root: string | undefined
let context: Context | undefined
let releaseGate: (() => void) | undefined

afterEach(async () => {
  releaseGate?.()
  releaseGate = undefined
  vi.restoreAllMocks()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A plugin whose activation waits for the test, so the tree stays unsettled. */
async function gated(): Promise<void> {
  await new Promise<void>((resolve) => {
    releaseGate = resolve
  })
}

/** A consumer plugin that declares the consumer id its config names. */
function consumerPlugin(ctx: Context, config: { id: string }): void {
  declareJudgmentConsumer(ctx, judgmentConsumerId(config.id))
}

/** One started composition: its context, the settle promise, and the captured error and info log calls. */
interface Started {
  ctx: Context
  settled: Promise<void>
  logged: unknown[][]
  infos: unknown[][]
}

/** Start one composition through the real Loader, returning the context and the settle promise. */
async function start(lines: readonly string[], settings?: string): Promise<Started> {
  root = await mkdtemp(join(tmpdir(), 'shres-judgment-dispatch-loader-'))
  const configPath = join(root, 'cordis.yml')
  const settingsRows = settings === undefined ? [] : [`- name: '${SETTINGS}'`, '  config:', `    path: '${join(root, 'settings.yaml')}'`, '    watch: false']
  if (settings !== undefined) await writeFile(join(root, 'settings.yaml'), settings)
  await writeFile(configPath, [...settingsRows, ...lines, ''].join('\n'))
  const ctx = new Context()
  context = ctx
  const logged: unknown[][] = []
  vi.spyOn(ctx.logger, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args)
    return ctx.logger
  })
  const infos: unknown[][] = []
  vi.spyOn(ctx.logger, 'info').mockImplementation((...args: unknown[]) => {
    infos.push(args)
    return ctx.logger
  })
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    [DISPATCH, JudgmentDispatch],
    [FAKE, FakeEngine],
    [SETTINGS, FileSettingsProvider],
    [GATED, gated],
    [CONSUMER, consumerPlugin],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  // Not awaited: a gated plugin keeps `create` pending until the test releases it.
  const created = ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  return { ctx, settled: created.then(() => ctx.loader.await()), logged, infos }
}

/** The dispatcher row selecting `engine` by default. */
function dispatch(engine: string): string[] {
  return [`- name: '${DISPATCH}'`, '  config:', `    defaultEngine: ${engine}`]
}

/** One fake engine row. */
function fake(id: string): string[] {
  return [`- name: '${FAKE}'`, '  config:', `    id: ${id}`]
}

/** One consumer row declaring `id`. */
function consumer(id: string): string[] {
  return [`- name: '${CONSUMER}'`, '  config:', `    id: ${id}`]
}

/** The override consumers the dispatcher logged as not naming themselves. */
function undeclared(logged: unknown[][]): string[] {
  return logged
    .filter(call => String(call[0]).includes('the stored override is ignored'))
    .map(call => /consumer "([^"]+)"/.exec(String(call[1]))?.[1] ?? '')
}

/** Commit a document the settings provider observed in storage, as a file reload does. */
function reload(ctx: Context, doc: Record<string, unknown>): void {
  ;(ctx.settings as unknown as { publish(document: Record<string, unknown>): void }).publish(doc)
}

/** The dispatcher's info lines, format arguments joined. */
function resolvedReports(infos: unknown[][]): string[] {
  return infos
    .filter(call => String(call[0]).startsWith('judgment-dispatch:'))
    .map(call => call.slice(1).map(String).join(' '))
}

/** One dispatcher plugin mounted after the settle, as a hot reload does. */
async function mountLate(ctx: Context, plugin: (inner: Context) => void, name: string): Promise<void> {
  await ctx.plugin({ name, apply: plugin })
}

/** The ids the dispatcher logged as selected but not composed. */
function unresolved(logged: unknown[][]): string[] {
  return logged
    .filter(call => String(call[0]).includes('is selected but not composed'))
    .map(call => String(call[1]))
}

describe('settle-time selection report', () => {
  it('logs nothing when every selected engine is composed', async () => {
    const { ctx, settled, logged } = await start([...dispatch('alpha'), ...fake('alpha')])
    await settled
    await Promise.resolve()

    expect(unresolved(logged)).toEqual([])
    expect((await ctx.judgment.ask({ state: 's', questions: [] })).engineId).toBe('alpha')
  })

  it('logs each unresolved default and override once after the tree settles, before any ask', async () => {
    const stored = ['judgment:', '  overrides:', '    worker-escalation: laya', '    compaction-jev: alpha', ''].join('\n')
    const { ctx, settled, logged } = await start([
      ...dispatch('typesafe'), ...fake('alpha'), ...consumer('worker-escalation'), ...consumer('compaction-jev'),
    ], stored)
    await settled
    await Promise.resolve()

    expect(unresolved(logged)).toEqual(['typesafe', 'laya'])
    expect(undeclared(logged)).toEqual([])
    await expect(ctx.judgment.ask({ state: 's', questions: [] })).rejects.toMatchObject({ code: 'UNCONFIGURED' })
    expect(unresolved(logged)).toEqual(['typesafe', 'laya'])
  })

  it('keeps a stored override for a consumer that declares after the section registers, and logs one that never declares', async () => {
    const stored = ['judgment:', '  overrides:', '    model-router: beta', '    worker-escalation: beta', ''].join('\n')
    const { ctx, settled, logged } = await start([
      ...dispatch('alpha'), ...fake('alpha'), ...fake('beta'), ...consumer('worker-escalation'),
    ], stored)
    await settled
    await Promise.resolve()

    expect(ctx.judgment.settings().overrides).toEqual({ 'model-router': 'beta', 'worker-escalation': 'beta' })
    expect(undeclared(logged)).toEqual(['model-router'])
    expect(unresolved(logged)).toEqual([])
    expect((await ctx.judgment.ask({ state: 's', questions: [], consumer: judgmentConsumerId('worker-escalation') })).engineId).toBe('beta')
    expect((await ctx.judgment.ask({ state: 's', questions: [], consumer: judgmentConsumerId('model-router') })).engineId).toBe('alpha')
  })

  it('reports each condition a reload introduces once, forgets one the selection drops, and reports it again when it returns', async () => {
    const { ctx, settled, logged, infos } = await start([...dispatch('alpha'), ...fake('alpha')], 'judgment: {}\n')
    await settled
    await Promise.resolve()

    reload(ctx, { judgment: { engine: 'laya', overrides: { 'model-router': 'alpha' } } })
    reload(ctx, { judgment: { engine: 'laya', overrides: { 'model-router': 'alpha' } }, other: {} })
    expect(ctx.judgment.settings()).toEqual({ enabled: true, engine: 'laya', overrides: { 'model-router': 'alpha' } })
    await expect(ctx.judgment.ask({ state: 's', questions: [] })).rejects.toMatchObject({ code: 'UNCONFIGURED' })
    expect(unresolved(logged)).toEqual(['laya'])
    expect(undeclared(logged)).toEqual(['model-router'])

    reload(ctx, { judgment: {} })
    reload(ctx, { judgment: { engine: 'laya', overrides: { 'model-router': 'alpha' } } })

    expect(unresolved(logged)).toEqual(['laya', 'laya'])
    expect(undeclared(logged)).toEqual(['model-router', 'model-router'])
    expect(resolvedReports(infos)).toEqual([])
  })

  it('reports that a stored override is honoured once its consumer declares after the settle', async () => {
    const stored = ['judgment:', '  overrides:', '    late-consumer: beta', ''].join('\n')
    const { ctx, settled, logged, infos } = await start([...dispatch('alpha'), ...fake('alpha'), ...fake('beta')], stored)
    await settled
    await Promise.resolve()
    expect(undeclared(logged)).toEqual(['late-consumer'])
    expect((await ctx.judgment.ask({ state: 's', questions: [], consumer: judgmentConsumerId('late-consumer') })).engineId).toBe('alpha')

    await mountLate(ctx, (inner) => {
      declareJudgmentConsumer(inner, judgmentConsumerId('late-consumer'))
    }, 'late-consumer')

    expect(resolvedReports(infos)).toEqual(['late-consumer beta'])
    expect((await ctx.judgment.ask({ state: 's', questions: [], consumer: judgmentConsumerId('late-consumer') })).engineId).toBe('beta')
    expect(undeclared(logged)).toEqual(['late-consumer'])
  })

  it('reports that a selected engine is composed once its provider registers after the settle', async () => {
    const { ctx, settled, logged, infos } = await start([...dispatch('late'), ...fake('alpha')])
    await settled
    await Promise.resolve()
    expect(unresolved(logged)).toEqual(['late'])

    await ctx.plugin(FakeEngine, { id: 'late' })

    expect(resolvedReports(infos)).toEqual(['late'])
    expect((await ctx.judgment.ask({ state: 's', questions: [] })).engineId).toBe('late')
  })

  it('reports nothing when the dispatcher unloads before the tree settles', async () => {
    const { ctx, settled, logged } = await start([...dispatch('missing'), `- name: '${GATED}'`])
    await vi.waitFor(() => {
      expect(releaseGate).toBeDefined()
    })
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === DISPATCH)
    await entry?.fiber?.dispose()

    releaseGate?.()
    await settled
    await Promise.resolve()

    expect(unresolved(logged)).toEqual([])
  })
})
