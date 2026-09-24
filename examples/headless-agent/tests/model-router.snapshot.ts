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
  /** Driver that owns an explicit create/dispose/resume lifecycle. */
  readonly resume?: boolean
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

/** The ordered scenario prompts one fixture declares. */
async function armPrompts(fixture: string): Promise<string[]> {
  const input = JSON.parse(await readFile(join(snapshotsDir, fixture, 'input.json'), 'utf8')) as {
    steps?: { op?: unknown; text?: unknown }[]
  }
  const prompts = input.steps?.filter(step => step.op === 'prompt').map(step => step.text)
  if (prompts === undefined || prompts.length === 0 || prompts.some(text => typeof text !== 'string')) {
    throw new Error(`${fixture} input has no valid prompt steps`)
  }
  return prompts as string[]
}

/**
 * Boot one arm as a real subprocess and harvest its normalized transcript and
 * durable log.
 * @param arm - the tree to boot and the fixture prompt to run.
 * @param server - the loopback stub endpoint the arm's adapter dials.
 * @returns the arm's normalized outputs.
 */
async function runArm(arm: Arm, server: MockLlmServer): Promise<ArmOutput> {
  const prompts = await armPrompts(arm.promptFixture)
  const driver = arm.resume === true ? join(testsDir, 'fixtures', 'model-router-resume-driver.ts') : binScript
  let runCwd = ''
  let rawSession: string | undefined
  const result = await runLoaderSmoke({
    label: `model routing ${arm.promptFixture} headless stream-json snapshot`,
    tempDirPrefix: `headless-snapshot-model-router-${arm.promptFixture}-`,
    binScript: driver,
    libBinScript: driver,
    configPath: arm.configPath,
    binArgs: [arm.configPath, '--tasks-json', JSON.stringify(prompts)],
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
  it('restores an explicit selection matching the routed header after persisted resume', async () => {
    const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, chunkSize: 4096, successText: SUCCESS_TEXT })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-resume.cordis.snapshot.yml'),
        promptFixture: 'model-router-resume',
        resume: true,
      }, server)
      expect(server.requests.map((_, index) => requestedModel(server, index))).toEqual([
        'deepseek-v4-flash', 'deepseek-v4-flash',
      ])
      const events = parseJsonl(output.session)
      const selections = events.filter(event => event['type'] === 'agent/model-selection')
      expect(selections).toHaveLength(1)
      expect(selections[0]?.['data']).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
      expect(events.filter(event => event['type'] === 'session/end-seed')).toHaveLength(1)
      const decisions = events.filter(event => event['type'] === 'model-routing/decision')
      expect(decisions).toHaveLength(2)
      expect(decisions[0]?.['data']).toMatchObject({ outcome: 'downgraded' })
      expect(decisions[1]?.['data']).toMatchObject({
        outcome: 'kept-strong', reason: 'manual-deviation', sticky: { active: false },
      })
      const headers = events.filter(event => event['type'] === 'request/header')
      expect(headers.length).toBeGreaterThan(0)
      expect(headers.every(event => (event['data'] as { header: { config: { model: string } } }).header.config.model === 'deepseek-v4-flash')).toBe(true)
      await expectArmFixtures('model-router-resume', output)
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('records a fitted context and keeps the manual route when the complete current input cannot fit', async () => {
    const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, chunkSize: 4096, successText: SUCCESS_TEXT })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-fitted.cordis.snapshot.yml'),
        promptFixture: 'model-router-fitted',
      }, server)
      expect(server.requests.map((_, index) => requestedModel(server, index))).toEqual([
        'deepseek-v4-flash', 'deepseek-v4-flash', 'deepseek-v4-pro',
      ])
      const decisions = eventRecords(output.stream).map(eventOf)
        .filter(event => event['type'] === 'model-routing/decision')
      expect(decisions).toHaveLength(3)
      expect(decisions[1]?.['data']).toMatchObject({
        outcome: 'downgraded', judgmentInput: { selectedIndex: 4 },
      })
      const fitted = decisions[1]?.['data'] as { judgmentInput: { state: string } }
      expect(fitted.judgmentInput.state).toContain('Continue.')
      expect(fitted.judgmentInput.state).not.toContain('Workspace context')
      expect(decisions[2]?.['data']).toMatchObject({
        outcome: 'kept-strong', reason: 'judgment-input-too-large', judgmentRejection: { reason: 'state' },
      })
      await expectArmFixtures('model-router-fitted', output)
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('runs the manual model after consecutive candidate failures before allowing another downgrade', async () => {
    const server = await startMockLlmServer({
      sequence: ['auth_error', 'auth_error', 'success', 'success'],
      repeatLast: true,
      chunkSize: 4096,
      successText: SUCCESS_TEXT,
    })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-on.cordis.snapshot.yml'),
        promptFixture: 'model-router-recovery',
      }, server)
      expect(server.requests.map((_, index) => requestedModel(server, index))).toEqual([
        'deepseek-v4-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash',
      ])
      const decisions = eventRecords(output.stream).map(eventOf)
        .filter(event => event['type'] === 'model-routing/decision')
      expect(decisions).toHaveLength(4)
      expect(decisions[2]?.['data']).toMatchObject({
        outcome: 'kept-strong', reason: 'route-errors',
        sticky: { active: false, entryBase: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
      })
      expect(decisions[2]?.['data']).not.toHaveProperty('judgmentQuestions')
      expect(decisions[3]?.['data']).toMatchObject({ outcome: 'downgraded', reason: 'gate-passed' })
      await expectArmFixtures('model-router-recovery', output)
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('retries a failed downgraded step on the manual model and breaks at the error limit', async () => {
    const server = await startMockLlmServer({
      sequence: ['auth_error', 'success', 'auth_error', 'success'],
      repeatLast: true,
      chunkSize: 4096,
      successText: SUCCESS_TEXT,
    })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-fallback.cordis.snapshot.yml'),
        promptFixture: 'model-router-fallback',
      }, server)
      // Each failed candidate request is retried within its step on the manual
      // model; the second failure reaches the error limit across streaks, so the
      // third turn is the manual recovery turn.
      expect(server.requests.map((_, index) => requestedModel(server, index))).toEqual([
        'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-pro',
      ])
      const durableEvents = parseJsonl(output.session)
      const decisions = durableEvents.filter(event => event['type'] === 'model-routing/decision')
        .map(event => event['data'] as Record<string, unknown>)
      expect(decisions.map(decision => decision['reason'])).toEqual([
        'gate-passed', 'route-failed', 'gate-passed', 'route-failed', 'route-errors',
      ])
      expect(decisions[1]).toMatchObject({
        outcome: 'kept-strong',
        failure: { code: expect.any(String), provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        failedChunkSeq: expect.any(Number),
        sticky: { active: false, brokenBy: 'route-failed', entryBase: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
      })
      const ends = durableEvents.filter(event => event['type'] === 'turn/end')
        .map(event => (event['data'] as { reason: { kind: string } }).reason.kind)
      expect(ends).toEqual(['completed', 'completed', 'completed'])
      await expectArmFixtures('model-router-fallback', output)
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

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

  it('rejudges a tool continuation and returns to the strong model for hard evidence', async () => {
    const evidence = 'Distributed transaction deadlock across services.'
    const server = await startMockLlmServer({
      sequence: ['tool_call_success', 'success'],
      repeatLast: true,
      chunkSize: 4096,
      successText: SUCCESS_TEXT,
      toolName: 'bash',
      toolArguments: JSON.stringify({
        command: `printf '${evidence}'`,
        description: 'Print fixed hard evidence.',
      }),
    })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-step.cordis.snapshot.yml'),
        promptFixture: 'model-router-step',
      }, server)
      expect(server.requests.map((_, index) => requestedModel(server, index))).toEqual([
        'deepseek-v4-flash', 'deepseek-v4-pro',
      ])
      const decisions = eventRecords(output.stream).map(eventOf)
        .filter(event => event['type'] === 'model-routing/decision')
      expect(decisions).toHaveLength(2)
      expect(decisions[0]?.['data']).toMatchObject({
        outcome: 'downgraded', reason: 'gate-passed', difficulty: { score: 2 },
      })
      expect(decisions[1]?.['data']).toMatchObject({
        outcome: 'kept-strong', reason: 'escalated', difficulty: { score: 4 },
        sticky: { active: false, brokenBy: 'escalated' },
      })
      const firstState = decisions[0]?.['data'] as { stateHash: string; stateSeqs: number[] }
      const secondState = decisions[1]?.['data'] as { stateHash: string; stateSeqs: number[] }
      const durableEvents = parseJsonl(output.session)
      expect(durableEvents.filter(event => event['type'] === 'turn/start')).toHaveLength(1)
      expect(durableEvents.filter(event => event['type'] === 'step/start')).toHaveLength(2)
      const results = durableEvents.filter(event => event['type'] === 'tool/result')
      expect(results).toHaveLength(1)
      const resultSeq = results[0]?.['seq'] as number
      expect(results[0]?.['data']).toMatchObject({
        message: { content: [{ type: 'tool-result', isError: false, content: [{ type: 'text', text: evidence }] }] },
      })
      expect(secondState.stateSeqs).toContain(resultSeq)
      expect(resultSeq).toBeLessThan(decisions[1]?.['seq'] as number)
      expect(secondState.stateHash).not.toBe(firstState.stateHash)
      expect(secondState.stateSeqs.length).toBeGreaterThan(firstState.stateSeqs.length)
      const secondRequest = server.requests[1]?.body as { messages: { role: string; content: unknown }[] }
      expect(JSON.stringify(secondRequest.messages.filter(message => message.role === 'tool'))).toContain(evidence)
      await expectArmFixtures('model-router-step', output)
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('applies settings-file deployment modes at accepted pre-steps before manual authority wins', async () => {
    const server = await startMockLlmServer({
      sequence: ['success'],
      repeatLast: true,
      chunkSize: 4096,
      successText: SUCCESS_TEXT,
    })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-mode.cordis.snapshot.yml'),
        promptFixture: 'model-router-mode',
      }, server)
      expect(server.requests.map((_, index) => requestedModel(server, index))).toEqual([
        'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash',
      ])
      const durableEvents = parseJsonl(output.session)
      const configuration = durableEvents
        .filter(event => event['type'] === 'model-routing/configuration')
        .map(event => (event['data'] as { active?: unknown }).active)
      expect(configuration).toEqual([true, false, true])
      const manualModes = durableEvents
        .filter(event => event['type'] === 'model-routing/mode')
        .map(event => (event['data'] as { active?: unknown }).active)
      expect(manualModes).toEqual([true])
      await expectArmFixtures('model-router-mode', output)
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('keeps the current model when the route script selects keep-current', async () => {
    const server = await startMockLlmServer({
      sequence: ['success'],
      repeatLast: true,
      chunkSize: 4096,
      successText: SUCCESS_TEXT,
    })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-keep-current.cordis.snapshot.yml'),
        promptFixture: 'model-router-keep-current',
      }, server)
      await expectArmFixtures('model-router-keep-current', output)

      const records = eventRecords(output.stream)
      const decisionIndex = records.findIndex(record => eventOf(record)['type'] === 'model-routing/decision')
      expect(decisionIndex).toBeGreaterThanOrEqual(0)
      expect(eventOf(records[decisionIndex]!).data).toMatchObject({
        outcome: 'kept-strong',
        reason: 'current-preferred',
        route: {
          choice: 'keep-current',
          confidence: 0.9,
          probabilities: { 'keep-current': 0.9, flash: 0.1 },
        },
        difficulty: { score: 2, confidence: 1 },
        sticky: { active: false },
      })
      expect(eventOf(records[decisionIndex]!).data).not.toHaveProperty('selection')
      const header = eventOf(records[decisionIndex + 1]!) as {
        type: string
        data: { header: { config: Record<string, unknown> } }
      }
      expect(header.type).toBe('request/header')
      expect(header.data.header.config).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })

      expect(server.requests).toHaveLength(1)
      expect(requestedModel(server, 0)).toBe('deepseek-v4-pro')
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('keeps the strong model when the route script rates the turn hard', async () => {
    const server = await startMockLlmServer({
      sequence: ['success'],
      repeatLast: true,
      chunkSize: 4096,
      successText: SUCCESS_TEXT,
    })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-hard.cordis.snapshot.yml'),
        promptFixture: 'model-router-hard',
      }, server)
      await expectArmFixtures('model-router-hard', output)

      const records = eventRecords(output.stream)
      const decisionIndex = records.findIndex(record => eventOf(record)['type'] === 'model-routing/decision')
      expect(decisionIndex).toBeGreaterThanOrEqual(0)
      expect(eventOf(records[decisionIndex]!).data).toMatchObject({
        outcome: 'kept-strong',
        reason: 'difficulty-too-high',
        route: {
          choice: 'flash',
          confidence: 0.9,
          probabilities: { 'keep-current': 0.1, flash: 0.9 },
        },
        difficulty: { score: 3, confidence: 1 },
        sticky: { active: false },
      })
      expect(eventOf(records[decisionIndex]!).data).not.toHaveProperty('selection')
      const header = eventOf(records[decisionIndex + 1]!) as {
        type: string
        data: { header: { config: Record<string, unknown> } }
      }
      expect(header.type).toBe('request/header')
      expect(header.data.header.config).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })

      expect(server.requests).toHaveLength(1)
      expect(requestedModel(server, 0)).toBe('deepseek-v4-pro')
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
      expect(await armPrompts('model-router-on')).toEqual(await armPrompts('model-router-off'))
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
