import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import Include from '@shres-code/cordis-plugin-include'
import Loader from '@shres-code/cordis-plugin-loader'
import JudgmentDispatch from '@shres-code/shres-code-judgment-dispatch'
import ShieldJudgmentEngine, { SHIELD_ENGINE_ID } from '../src/index.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

const ENGINE_SPECIFIER = '@shres-code/shres-code-judgment-shield'
const DISPATCH_SPECIFIER = '@shres-code/shres-code-judgment-dispatch'
let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await closeMockServers()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot one test-only composition through the real Loader and Include plugin. */
async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'shres-judgment-shield-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier === ENGINE_SPECIFIER) return ShieldJudgmentEngine
      if (specifier === DISPATCH_SPECIFIER) return JudgmentDispatch
      throw new Error(`unexpected Loader import: ${specifier}`)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** The dispatcher row and one explicit provider row for the temporary composition. */
function rows(endpoint: string, extra: readonly string[] = []): string[] {
  return [
    `- name: '${DISPATCH_SPECIFIER}'`,
    '  config:',
    '    defaultEngine: shield',
    `- name: '${ENGINE_SPECIFIER}'`,
    '  config:',
    `    endpoint: '${endpoint}'`,
    '    models:',
    "      fast: 'shield-fast@loader'",
    "      accurate: 'shield-accurate@loader'",
    ...extra,
  ]
}

describe('real Loader composition', () => {
  it('loads the provider, answers through the loopback gateway, and records no extra rows', async () => {
    const server = await mockServer([{
      kind: 'json',
      body: { engine: 'shield', model: 'shield-accurate@loader', latencyMs: 3, answers: [] },
    }])
    const loaded = await loadYaml(rows(server.url))

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.judgmentEngines.get(SHIELD_ENGINE_ID)?.engine).toBeInstanceOf(ShieldJudgmentEngine)

    const result = await loaded.judgment.ask({ state: 'state', questions: [] })

    expect(result).toEqual({
      engineId: 'shield',
      engine: 'shield',
      model: 'shield-accurate@loader',
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- Vitest asymmetric matcher is typed as any.
      latencyMs: expect.any(Number),
      answers: [],
    })
    expect(server.requests[0]?.path).toBe('/v1/judgments')
  })

  it('rejects an unknown config key during Loader startup', async () => {
    const server = await mockServer([])
    await expect(loadYaml(rows(server.url, ['    timeout: 10']))).rejects
      .toThrow(/unknown key "timeout"/)
  })

  it('withdraws the engine from the registry when its Loader entry fiber disposes', async () => {
    const server = await mockServer([])
    const loaded = await loadYaml(rows(server.url))
    const entry = [...loaded.loader.entries()]
      .find(candidate => candidate.options.name === ENGINE_SPECIFIER)

    expect(entry?.fiber).toBeDefined()
    await entry?.fiber?.dispose()

    expect(loaded.judgmentEngines.get(SHIELD_ENGINE_ID)).toBeUndefined()
    await expect(loaded.judgment.ask({ state: 'state', questions: [] })).rejects
      .toMatchObject({ code: 'UNCONFIGURED' })
  })
})
