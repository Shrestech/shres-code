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

/** Start one composition through the real Loader, returning the context and the settle promise. */
async function start(lines: readonly string[], settings?: string): Promise<{ ctx: Context; settled: Promise<void>; logged: unknown[][] }> {
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
  return { ctx, settled: created.then(() => ctx.loader.await()), logged }
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
