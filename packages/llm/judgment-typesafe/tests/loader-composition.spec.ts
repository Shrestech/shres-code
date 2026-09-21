import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import { judgmentQuestionId } from '@shres-code/shres-code-judgment'
import type { JudgmentBinaryQuestion, JudgmentChoiceQuestion } from '@shres-code/shres-code-judgment'
import TypesafeJudgmentEngine from '../src/index.ts'
import { MemoryCredentials } from './credentials-memory.ts'
import { closeMockServers, mockServer } from './mock-server.ts'
import type { MockServer } from './mock-server.ts'

const ANSWERED_MODEL = 'jev-latest-2026-05-01'
const ENGINE_SPECIFIER = '@shres-code/shres-code-judgment-typesafe'
const CREDENTIALS_SPECIFIER = '@shres-code/shres-code-credentials-memory'

const BINARY: JudgmentBinaryQuestion = {
  kind: 'binary',
  id: judgmentQuestionId('urgent'),
  instructions: 'Does this convey urgency?',
}

const CHOICE: JudgmentChoiceQuestion = {
  kind: 'choice',
  id: judgmentQuestionId('severity'),
  instructions: 'How severe is this?',
  options: [{ option: 'low' }, { option: 'high' }],
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await closeMockServers()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot one test-only cordis.yml through the real Loader and its include builtin. */
async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'shres-judgment-typesafe-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    [ENGINE_SPECIFIER, TypesafeJudgmentEngine],
    [CREDENTIALS_SPECIFIER, MemoryCredentials],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** The two rows one composition needs: the memory credentials provider and the engine. */
function rows(server: MockServer, extraEngineKeys: readonly string[] = []): string[] {
  return [
    `- name: '${CREDENTIALS_SPECIFIER}'`,
    '  config:',
    '    TYPESAFE_API_KEY: loader-key',
    `- name: '${ENGINE_SPECIFIER}'`,
    '  config:',
    '    apiKeyRef: TYPESAFE_API_KEY',
    `    endpoint: '${server.url}'`,
    ...extraEngineKeys,
  ]
}

describe('real Loader composition', () => {
  it('loads the engine against the stub endpoint and answers one ask', async () => {
    const server = await mockServer([{
      kind: 'json',
      status: 200,
      body: JSON.stringify({
        model: ANSWERED_MODEL,
        answers: {
          urgent: { type: 'noul', noul: 0.91 },
          severity: { type: 'choice', choice: 'high', probabilities: { low: 0.1, high: 0.9 }, confidence: 0.85 },
        },
        usage: { input_tokens: 64, output_tokens: 0 },
      }),
    }])
    const loaded = await loadYaml(rows(server))

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.get('judgment')).toBeInstanceOf(TypesafeJudgmentEngine)

    const result = await loaded.judgment.ask({ state: 'the build is failing', questions: [BINARY, CHOICE] })

    expect(result.engine).toBe('typesafe')
    expect(result.model).toBe(ANSWERED_MODEL)
    expect(result.answers).toEqual([
      { kind: 'binary', id: 'urgent', probability: 0.91 },
      {
        kind: 'choice',
        id: 'severity',
        option: 'high',
        probabilities: { low: 0.1, high: 0.9 },
        confidence: 0.85,
      },
    ])
    expect(server.requests[0]?.path).toBe('/v1/systemone')
    expect(server.requests[0]?.headers.authorization).toBe('Bearer loader-key')
    expect(server.requests[0]?.body).toEqual({
      state: 'the build is failing',
      model: 'jev-latest',
      questions: {
        urgent: { type: 'noul', instructions: 'Does this convey urgency?' },
        severity: { type: 'choice', instructions: 'How severe is this?', criteria: { low: null, high: null } },
      },
    })
  })

  it('retries one transient refusal through the loaded composition', async () => {
    const server = await mockServer([
      { kind: 'json', status: 429, body: JSON.stringify({ error: { message: 'slow down' } }) },
      {
        kind: 'json',
        status: 200,
        body: JSON.stringify({
          model: ANSWERED_MODEL,
          answers: { urgent: { type: 'noul', noul: 0.9 } },
          usage: { input_tokens: 64, output_tokens: 0 },
        }),
      },
    ])
    // The nested retry entry is the loaded schema's, and the wait is real here: the
    // test shortens it rather than faking the timer the Loader's own boot runs on.
    const loaded = await loadYaml(rows(server, ['    retry:', '      delayMs: 1']))

    const result = await loaded.judgment.ask({ state: 'the build is failing', questions: [BINARY] })

    expect(result.answers).toEqual([{ kind: 'binary', id: 'urgent', probability: 0.9 }])
    expect(server.requests).toHaveLength(2)
    expect(server.requests[1]?.body).toEqual(server.requests[0]?.body)
  })

  it('rejects an unknown config key at load', async () => {
    const server = await mockServer([])

    await expect(loadYaml(rows(server, ['    timeout: 10'])))
      .rejects.toThrow(/unknown key "timeout"/)
  })

  it('withdraws ctx.judgment when the loaded entry fiber disposes', async () => {
    const server = await mockServer([])
    const loaded = await loadYaml(rows(server))
    const entry = [...loaded.loader.entries()].find(candidate => candidate.options.name === ENGINE_SPECIFIER)

    expect(entry?.fiber).toBeDefined()
    await entry?.fiber?.dispose()

    expect(loaded.get('judgment')).toBeUndefined()
  })
})
