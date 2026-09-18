import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { normalizeSessionLog, scrubRequestHeaders } from '@shres-code/shres-code-acp-snapshot'
import { startMockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import type { MockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@shres-code/shres-code-loader-smoke'

/**
 * Keyless model-routing snapshot pair. Both arms boot the shipping headless
 * spine through the real Loader against a loopback stub model endpoint and a
 * scripted judgment engine, so neither needs an API key: the ON arm composes
 * `@shres-code/shres-code-model-router` with `initialMode: on` and shows the
 * downgrade in-transcript, and the OFF arm composes the same tree with
 * `initialMode: off` and is byte-identical to a third run of the same fixture
 * with no router composed at all.
 *
 * The OFF arm composes the router rather than omitting it: a composed-but-off
 * tree is the stronger claim, because it proves the package writes nothing while
 * the mode is off instead of only proving that an absent package is absent.
 */

const testsDir = dirname(fileURLToPath(import.meta.url))
const snapshotsDir = join(testsDir, 'snapshots')
const exampleDir = dirname(testsDir)
const binScript = join(testsDir, 'fixtures', 'headless-driver.ts')
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const refreshing = process.env['SHRES_SNAPSHOT'] === 'refresh'

/** Deterministic model text the stub endpoint streams back. */
const SUCCESS_TEXT = 'ROUTED_OK'

/** One arm: the tree it boots, and the fixture whose prompt it runs. */
interface Arm {
  /** Configuration this arm boots. */
  readonly configPath: string
  /** Fixture holding the prompt both arms run. */
  readonly promptFixture: string
}

/** One arm's harvested, normalized outputs. */
interface ArmOutput {
  /** Normalized stdout transcript. */
  readonly stream: string
  /** Normalized durable session log. */
  readonly session: string
}

/** Parse newline-delimited JSON records. */
function parseJsonl(content: string): Record<string, unknown>[] {
  return content.split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

/** The run's own volatile session id and cwd, read from its persisted header. */
function logContext(content: string): { sessionIds: string[]; cwd: string } {
  const header = parseJsonl(content)[0]
  return {
    sessionIds: typeof header?.['id'] === 'string' ? [header['id']] : [],
    cwd: typeof header?.['cwd'] === 'string' ? header['cwd'] : '\0no-cwd\0',
  }
}

/**
 * Normalize the driver's stdout: one compact record per line, each
 * `session_event` payload scrubbed like the session fixture and every session id
 * tokenized.
 * @param rawStdout - the driver's captured stdout.
 * @param cwd - the run's generated cwd.
 * @returns the normalized transcript, ending in one newline.
 */
function normalizedStream(rawStdout: string, cwd: string): string {
  const records = parseJsonl(rawStdout)
  const result = records.at(-1)
  if (result?.['type'] !== 'result') throw new Error('model-router snapshot did not end with a result record')
  const events = records.slice(0, -1)
  if (events.some(record => record['type'] !== 'session_event')) {
    throw new Error('model-router snapshot emitted a non-event record before its result')
  }
  const sessionIds = [...new Set(records.flatMap(record => typeof record['sessionId'] === 'string' ? [record['sessionId']] : []))]
  if (sessionIds.length !== 1) throw new Error(`model-router snapshot streamed ${sessionIds.length} session ids`)
  const normalized = parseJsonl(scrubRequestHeaders(normalizeSessionLog(
    `${events.map(record => JSON.stringify(record['event'])).join('\n')}\n`,
    { sessionIds, cwd },
  )))
  return `${records.map((record, index) => JSON.stringify({
    ...record,
    sessionId: '{{sessionId}}',
    ...index < normalized.length ? { event: normalized[index] } : {},
  })).join('\n')}\n`
}

/** The scenario prompt one fixture declares. */
async function armPrompt(fixture: string): Promise<string> {
  const input = JSON.parse(await readFile(join(snapshotsDir, fixture, 'input.json'), 'utf8')) as {
    steps?: { op?: unknown; text?: unknown }[]
  }
  const prompt = input.steps?.find(step => step.op === 'prompt')?.text
  if (typeof prompt !== 'string') throw new Error(`${fixture} input has no prompt step`)
  return prompt
}

/**
 * Boot one arm as a real subprocess and harvest its normalized transcript and
 * durable log.
 * @param arm - the tree to boot and the fixture prompt to run.
 * @param server - the loopback stub endpoint the arm's adapter dials.
 * @returns the arm's normalized outputs.
 */
async function runArm(arm: Arm, server: MockLlmServer): Promise<ArmOutput> {
  const prompt = await armPrompt(arm.promptFixture)
  let runCwd = ''
  let rawSession: string | undefined
  const result = await runLoaderSmoke({
    label: `model routing ${arm.promptFixture} headless stream-json snapshot`,
    tempDirPrefix: `headless-snapshot-model-router-${arm.promptFixture}-`,
    binScript,
    libBinScript: binScript,
    configPath: arm.configPath,
    binArgs: [arm.configPath, prompt],
    tsconfigPath,
    env: {
      SHRES_SNAPSHOT: 'replay',
      DEEPSEEK_API_KEY: 'model-router-snapshot-key',
      SHRES_SNAPSHOT_BASE_URL: server.baseURL,
      NODE_OPTIONS: [process.env['NODE_OPTIONS'], '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
    },
    prepare: (cwd) => { runCwd = cwd },
    inspect: async (cwd) => {
      const root = join(cwd, '.sessions')
      const logs = (await readdir(root, { recursive: true })).filter(name => name.endsWith('.jsonl'))
      expect(logs).toHaveLength(1)
      rawSession = await readFile(join(root, logs[0]!), 'utf8')
    },
  })
  expect(result.stderr).toBe('')
  if (rawSession === undefined) throw new Error(`${arm.promptFixture} did not persist a comparable session`)
  return {
    stream: normalizedStream(result.stdout, runCwd),
    session: scrubRequestHeaders(normalizeSessionLog(rawSession, logContext(rawSession))),
  }
}

/** Compare one arm's outputs with its committed fixture, writing them in refresh mode. */
async function expectArmFixtures(fixture: string, output: ArmOutput): Promise<void> {
  const sessionFixture = join(snapshotsDir, fixture, 'session.jsonl')
  const streamFixture = join(snapshotsDir, fixture, 'stream-json.expected.jsonl')
  if (refreshing) {
    await writeFile(sessionFixture, output.session)
    await writeFile(streamFixture, output.stream)
    return
  }
  expect(output.session).toBe(await readFile(sessionFixture, 'utf8'))
  expect(output.stream).toBe(await readFile(streamFixture, 'utf8'))
}

/** The session-event records of a normalized transcript. */
function eventRecords(stream: string): Record<string, unknown>[] {
  return parseJsonl(stream).flatMap(record => record['type'] === 'session_event' ? [record] : [])
}

/** The `event` payload of one transcript record. */
function eventOf(record: Record<string, unknown>): Record<string, unknown> {
  return record['event'] as Record<string, unknown>
}

/** The `model` field of one stub-server request body. */
function requestedModel(server: MockLlmServer, index: number): unknown {
  return (server.requests[index]?.body as { model?: unknown } | undefined)?.model
}

describe('headless model-routing snapshots', () => {
  it('downgrades in-transcript through the composed router', async () => {
    const server = await startMockLlmServer({
      sequence: ['success'],
      repeatLast: true,
      chunkSize: 4096,
      successText: SUCCESS_TEXT,
    })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-on.cordis.snapshot.yml'),
        promptFixture: 'model-router-on',
      }, server)
      await expectArmFixtures('model-router-on', output)

      const records = eventRecords(output.stream)
      const decisionIndex = records.findIndex(record => eventOf(record)['type'] === 'model-routing/decision')
      expect(decisionIndex).toBeGreaterThanOrEqual(0)
      expect(eventOf(records[decisionIndex]!).data).toMatchObject({
        outcome: 'downgraded',
        selection: { candidateId: 'flash', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        sticky: { active: true },
      })
      // The record that follows the decision is the request header it was consumed under.
      const header = eventOf(records[decisionIndex + 1]!) as {
        type: string
        data: { header: { config: Record<string, unknown> } }
      }
      expect(header.type).toBe('request/header')
      expect(header.data.header.config).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })

      // The stub endpoint served exactly that route.
      expect(server.requests).toHaveLength(1)
      expect(requestedModel(server, 0)).toBe('deepseek-v4-flash')
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('composes OFF keylessly and stays byte-identical to a run without the router', async () => {
    const server = await startMockLlmServer({
      sequence: ['success'],
      repeatLast: true,
      chunkSize: 4096,
      successText: SUCCESS_TEXT,
    })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-off.cordis.snapshot.yml'),
        promptFixture: 'model-router-off',
      }, server)
      const reference = await runArm({
        configPath: join(exampleDir, 'model-router-plain.cordis.snapshot.yml'),
        promptFixture: 'model-router-off',
      }, server)
      await expectArmFixtures('model-router-off', output)

      // The two arms run the same prompt, so only the composition can differ.
      expect(await armPrompt('model-router-on')).toBe(await armPrompt('model-router-off'))
      // A composed-but-off tree writes nothing routing-related...
      expect(eventRecords(output.stream)
        .some(record => String(eventOf(record)['type']).startsWith('model-routing/'))).toBe(false)
      // ...and its complete transcript and durable log are the uncomposed run's bytes.
      expect(output.stream).toBe(reference.stream)
      expect(output.session).toBe(reference.session)
      expect(server.requests).toHaveLength(2)
      expect(requestedModel(server, 1)).toBe('deepseek-v4-pro')
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
