import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { normalizeSessionLog, scrubRequestHeaders } from '@shres-code/shres-code-acp-snapshot'
import { startMockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import type { MockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@shres-code/shres-code-loader-smoke'
import { foldModelRoutingStats } from '@shres-code/shres-code-model-router'
import type { SessionEvent } from '@shres-code/shres-code-session'

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
 *
 * Child-route arms pin parent logs plus each child's own session log. Spawn
 * carries `subagent/descriptor.agentRouteRequestId`; fork does not. Shadow
 * logs `shadow: true` and keeps the child's header on the inherited model.
 * `judge: true` records `child-judged`. Two countable candidate failures
 * (`QUOTA`, not retryable; `SERVER` would also count after retries are exhausted)
 * suspend that candidate so the next child is kept with `child-route-errors`.
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
  /** Fixture driver that owns an explicit create/dispose/resume or select lifecycle, instead of the headless driver. */
  readonly driver?: 'model-router-resume-driver' | 'model-router-unmount-driver' | 'model-router-select-driver' | 'model-router-subagent-driver' | 'model-router-subagent-shadow-driver' | 'model-router-subagent-judge-driver' | 'model-router-subagent-guard-driver'
}

/** One arm's harvested, normalized outputs. */
interface ArmOutput {
  /** Normalized stdout transcript. */
  readonly stream: string
  /** Normalized durable session log. */
  readonly session: string
  /** Normalized child session logs, spawn-order, when the driver persists children. */
  readonly children?: readonly string[]
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
 * Quantize the wall-clock measurements a decision records, which otherwise
 * carry the run's millisecond jitter into the committed bytes: the cold-point
 * idle gap rounds to whole minutes, far coarser than any scheduling noise and
 * identical on every machine.
 * @param record - one JSONL record, a bare event or a wrapped session_event.
 * @returns the record with `coldPoint.idleMs` quantized.
 */
function quantizeDecisionTimings(record: Record<string, unknown>): Record<string, unknown> {
  const target = (record['event'] ?? record) as {
    type?: string
    data?: { coldPoint?: { idleMs?: number } }
  }
  const idleMs = target.data?.coldPoint?.idleMs
  if (target.type === 'model-routing/decision' && typeof idleMs === 'number') {
    target.data!.coldPoint!.idleMs = Math.round(idleMs / 60_000) * 60_000
  }
  return record
}

/** Line form of {@link quantizeDecisionTimings} for raw JSONL. */
function quantizeDecisionTimingsLine(line: string): string {
  return JSON.stringify(quantizeDecisionTimings(JSON.parse(line) as Record<string, unknown>))
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
  const records = parseJsonl(rawStdout).map(quantizeDecisionTimings) // objects in, objects out
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
  const driver = arm.driver === undefined ? binScript : join(testsDir, 'fixtures', `${arm.driver}.ts`)
  let runCwd = ''
  let rawSession: string | undefined
  let harvestedChildren: string[] = []
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
      const logs = (await readdir(root, { recursive: true })).filter(name => name.endsWith('.jsonl')).sort()
      const isChildDriver = arm.driver === 'model-router-subagent-driver'
        || arm.driver === 'model-router-subagent-shadow-driver'
        || arm.driver === 'model-router-subagent-judge-driver'
        || arm.driver === 'model-router-subagent-guard-driver'
      if (isChildDriver) {
        expect(logs.length).toBeGreaterThanOrEqual(2)
        const contents = await Promise.all(logs.map(name => readFile(join(root, name), 'utf8')))
        const parsed = contents.map((content) => {
          const header = JSON.parse(content.split('\n', 1)[0] ?? '{}') as { id?: unknown; parentSession?: unknown }
          return { content, header }
        })
        const parent = parsed.find(entry => typeof entry.header.parentSession !== 'string'
          && entry.content.includes('model-routing/child-decision'))
        if (parent === undefined) throw new Error(`${arm.promptFixture} persisted no parent child-decision log`)
        rawSession = parent.content
        harvestedChildren = parsed
          .filter(entry => typeof entry.header.parentSession === 'string')
          .map(entry => entry.content)
          .sort((a, b) => firstUserPrompt(a).localeCompare(firstUserPrompt(b)))
      } else {
        expect(logs).toHaveLength(1)
        rawSession = await readFile(join(root, logs[0]!), 'utf8')
      }
    },
  })
  expect(result.stderr).toBe('')
  if (rawSession === undefined) throw new Error(`${arm.promptFixture} did not persist a comparable session`)
  const session = rawSession.split('\n').filter(l => l.trim().length > 0).map(quantizeDecisionTimingsLine).join('\n') + '\n'
  const parentContext = logContext(session)
  const children = harvestedChildren.map((content) => {
    const quantized = content.split('\n').filter(l => l.trim().length > 0).map(quantizeDecisionTimingsLine).join('\n') + '\n'
    const childHeader = JSON.parse(quantized.split('\n', 1)[0] ?? '{}') as { id?: unknown }
    const childId = typeof childHeader.id === 'string' ? childHeader.id : ''
    return scrubRequestHeaders(normalizeSessionLog(quantized, {
      sessionIds: [...parentContext.sessionIds, ...childId === '' ? [] : [childId]],
      cwd: parentContext.cwd,
    }))
  })
  return {
    stream: normalizedStream(result.stdout, runCwd),
    session: scrubRequestHeaders(normalizeSessionLog(session, parentContext)),
    ...children.length === 0 ? {} : { children },
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

/** First user-message text in a persisted child log, used to order fixtures. */
function firstUserPrompt(content: string): string {
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue
    const event = JSON.parse(line) as { type?: string; data?: { content?: Array<{ type?: string; text?: string }> } }
    if (event.type !== 'user/message') continue
    const text = event.data?.content?.find(block => block.type === 'text')?.text
    if (typeof text === 'string') return text
  }
  return ''
}

/** Model on the child's first request/header, when present. */
function childHeaderModel(content: string): string | undefined {
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue
    const event = JSON.parse(line) as { type?: string; data?: { header?: { config?: { model?: string } } } }
    if (event.type === 'request/header') return event.data?.header?.config?.model
  }
  return undefined
}

/** Compare one arm's child logs with committed child.expected.jsonl files. */
async function expectChildFixtures(fixture: string, children: readonly string[]): Promise<void> {
  for (const [index, content] of children.entries()) {
    const path = join(snapshotsDir, fixture, index === 0 ? 'child.expected.jsonl' : `child.${String(index)}.expected.jsonl`)
    if (refreshing) await writeFile(path, content)
    else expect(content).toBe(await readFile(path, 'utf8'))
  }
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
        driver: 'model-router-resume-driver',
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

  it.each([
    ['model-router-idle', 'model-router-idle.cordis.snapshot.yml', 'candidate-equals-base'],
    ['model-router-idle-unlisted', 'model-router-resume.cordis.snapshot.yml', 'base-unlisted'],
  ] as const)('reports routing idle on the selected route after a manual deviation (%s)', async (fixture, config, reason) => {
    const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, chunkSize: 4096, successText: SUCCESS_TEXT })
    try {
      const output = await runArm({
        configPath: join(exampleDir, config),
        promptFixture: fixture,
        driver: 'model-router-select-driver',
      }, server)
      // Every turn runs flash: the routed first turn, then the explicit selection. No judgment reaches the model.
      expect(server.requests.map((_, index) => requestedModel(server, index))).toEqual([
        'deepseek-v4-flash', 'deepseek-v4-flash', 'deepseek-v4-flash',
      ])
      const decisions = parseJsonl(output.session).filter(event => event['type'] === 'model-routing/decision')
      expect(decisions.map(event => event['data'])).toMatchObject([
        { outcome: 'downgraded', sticky: { active: true, entryBase: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } },
        { outcome: 'kept-strong', reason: 'manual-deviation', sticky: { active: false, brokenBy: 'manual-deviation' } },
        { outcome: 'kept-strong', reason, sticky: { active: false } },
      ])
      await expectArmFixtures(fixture, output)
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('returns a routed session to its manual route when it resumes in a tree without the router', async () => {
    const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, chunkSize: 4096, successText: SUCCESS_TEXT })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-unmount.cordis.snapshot.yml'),
        promptFixture: 'model-router-unmount',
        driver: 'model-router-unmount-driver',
      }, server)
      // The first boot routes to the candidate; the resumed tree has no router and runs the manual model.
      expect(server.requests.map((_, index) => requestedModel(server, index))).toEqual([
        'deepseek-v4-flash', 'deepseek-v4-pro',
      ])
      const events = parseJsonl(output.session)
      const recorded = events.filter(event => event['type'] === 'agent/route-base')
      expect(recorded.map(event => event['data'])).toEqual([{
        manual: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        routed: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      }])
      const decisions = events.filter(event => event['type'] === 'model-routing/decision')
      expect(decisions).toHaveLength(1)
      expect(decisions[0]?.['data']).toMatchObject({ outcome: 'downgraded' })
      // The restored selection is read from the log, not written as an explicit one.
      expect(events.filter(event => event['type'] === 'agent/model-selection')).toEqual([])
      const headers = events.filter(event => event['type'] === 'request/header')
      const models = headers.map(event => (event['data'] as { header: { config: { model: string } } }).header.config.model)
      expect(models.at(0)).toBe('deepseek-v4-flash')
      expect(models.at(-1)).toBe('deepseek-v4-pro')
      await expectArmFixtures('model-router-unmount', output)
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
        failure: { code: expect.any(String) as unknown, provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        failedChunkSeq: expect.any(Number) as unknown,
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
      // The decision is followed by the manual route recorded beneath it, then
      // by the request header it was consumed under.
      expect(eventOf(records[decisionIndex + 1]!)).toMatchObject({
        type: 'agent/route-base',
        data: {
          manual: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
          routed: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        },
      })
      const header = eventOf(records[decisionIndex + 2]!) as {
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

  it('routes on an LLM judge accepted through its operating point', async () => {
    // One judge request, answered by the judgment_answer tool call, then the
    // agent's own request on the routed candidate.
    const server = await startMockLlmServer({
      sequence: ['tool_call_success', 'success'],
      repeatLast: true,
      chunkSize: 4096,
      successText: SUCCESS_TEXT,
      toolName: 'judgment_answer',
      toolArguments: JSON.stringify({
        answers: {
          'model-route': { 'keep-current': 0.005, flash: 0.995 },
          'turn-difficulty': { 0: 0.9, 1: 0.1, 2: 0, 3: 0, 4: 0 },
        },
      }),
    })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-llm-judge.cordis.snapshot.yml'),
        promptFixture: 'model-router-llm-judge',
      }, server)
      await expectArmFixtures('model-router-llm-judge', output)

      const decision = eventRecords(output.stream).map(eventOf).find(event => event['type'] === 'model-routing/decision')
      expect(decision?.['data']).toMatchObject({
        outcome: 'downgraded',
        reason: 'gate-passed',
        engine: 'llm',
        model: 'deepseek-v4-flash',
        engineId: 'llm:deepseek-official/deepseek-v4-flash',
        selection: { candidateId: 'flash', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        thresholds: { downgradeThreshold: 0.8, downgradeMargin: 0.3, source: 'operating-point' },
      })
      // The judge asked with the answer tool on its own route; the agent then ran the candidate.
      expect(server.requests).toHaveLength(2)
      const judgeBody = server.requests[0]?.body as { model?: unknown; tools?: { function?: { name?: unknown } }[] }
      expect(judgeBody.model).toBe('deepseek-v4-flash')
      expect(judgeBody.tools?.map(tool => tool.function?.name)).toEqual(['judgment_answer'])
      expect(requestedModel(server, 1)).toBe('deepseek-v4-flash')
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('counts a dispatcher refusal of an engine that is not ready as a failure and opens the breaker', async () => {
    // Only the agent's own requests reach the stub: the dispatcher refuses every judge ask.
    const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, chunkSize: 4096, successText: SUCCESS_TEXT })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-engine-refused.cordis.snapshot.yml'),
        promptFixture: 'model-router-engine-refused',
      }, server)
      await expectArmFixtures('model-router-engine-refused', output)

      const events = eventRecords(output.stream).map(eventOf)
      const decisions = events.filter(event => event['type'] === 'model-routing/decision').map(event => event['data'])
      expect(decisions).toMatchObject([
        { outcome: 'kept-strong', reason: 'engine-unavailable', engineId: 'typesafe', engineFailure: { code: 'UNAVAILABLE', refusedBeforeDispatch: true } },
        { outcome: 'kept-strong', reason: 'engine-unavailable', engineId: 'typesafe', engineFailure: { code: 'UNAVAILABLE', refusedBeforeDispatch: true } },
        { outcome: 'kept-strong', reason: 'breaker-open' },
      ])
      // Nothing was sent to the judge; both refusals still count as failed judgments.
      const stats = foldModelRoutingStats(events as unknown as SessionEvent[])
      expect(stats.egress).toEqual([])
      expect(stats.counts.judgeFailed).toBe(2)
      expect(server.requests).toHaveLength(3)
      expect([0, 1, 2].map(index => requestedModel(server, index))).toEqual(['deepseek-v4-pro', 'deepseek-v4-pro', 'deepseek-v4-pro'])
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
        outcome: 'downgraded', reason: 'gate-passed', difficulty: { score: 1 },
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

  it('keeps the manual model without judging on the turn after an escalation', async () => {
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
        configPath: join(exampleDir, 'model-router-cooldown.cordis.snapshot.yml'),
        promptFixture: 'model-router-cooldown',
      }, server)
      expect(server.requests.map((_, index) => requestedModel(server, index))).toEqual([
        'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-pro',
      ])
      const decisions = parseJsonl(output.session)
        .filter(event => event['type'] === 'model-routing/decision')
        .map(event => event['data'] as Record<string, unknown>)
      expect(decisions.map(decision => decision['reason'])).toEqual(['gate-passed', 'escalated', 'reentry-cooldown'])
      // The cooldown turn asks no question and records no answer.
      expect(decisions[2]).toMatchObject({ outcome: 'kept-strong', sticky: { active: false } })
      expect(decisions[2]).not.toHaveProperty('route')
      expect(decisions[2]).not.toHaveProperty('judgmentQuestions')
      await expectArmFixtures('model-router-cooldown', output)
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('returns to the manual model without judging when a hold reaches its step cap', async () => {
    const server = await startMockLlmServer({
      sequence: ['tool_call_success', 'success'],
      repeatLast: true,
      chunkSize: 4096,
      successText: SUCCESS_TEXT,
      toolName: 'bash',
      toolArguments: JSON.stringify({ command: "printf 'done'", description: 'Print a fixed line.' }),
    })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-cap.cordis.snapshot.yml'),
        promptFixture: 'model-router-cap',
      }, server)
      expect(server.requests.map((_, index) => requestedModel(server, index))).toEqual([
        'deepseek-v4-flash', 'deepseek-v4-pro',
      ])
      const decisions = parseJsonl(output.session)
        .filter(event => event['type'] === 'model-routing/decision')
        .map(event => event['data'] as Record<string, unknown>)
      expect(decisions.map(decision => decision['reason'])).toEqual(['gate-passed', 'hold-cap'])
      expect(decisions[0]).toMatchObject({ sticky: { active: true, stepsElapsed: 0, enteredTurn: 1, enteredStep: 1 } })
      expect(decisions[1]).toMatchObject({ outcome: 'kept-strong', sticky: { active: false, brokenBy: 'hold-cap' } })
      expect(decisions[1]).not.toHaveProperty('route')
      await expectArmFixtures('model-router-cap', output)
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
        difficulty: { score: 1, confidence: 1 },
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

  it('enters a quota route only at cold points and returns the held streak at the next one', async () => {
    const server = await startMockLlmServer({
      sequence: ['tool_call_success', 'success'],
      repeatLast: true,
      chunkSize: 4096,
      successText: SUCCESS_TEXT,
      toolName: 'bash',
      toolArguments: JSON.stringify({ command: "printf 'done'", description: 'Print a fixed line.' }),
    })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-coldpoint.cordis.snapshot.yml'),
        promptFixture: 'model-router-coldpoint',
      }, server)
      // The manual model served turns 1 (second step), 2, and 4; the routed
      // candidate served turn 1's first step and turn 3.
      expect(server.requests.map((_, index) => requestedModel(server, index))).toEqual([
        'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-pro',
      ])
      const decisions = parseJsonl(output.session)
        .filter(event => event['type'] === 'model-routing/decision')
        .map(event => event['data'] as Record<string, unknown>)
      expect(decisions.map(decision => decision['reason'])).toEqual([
        'gate-passed', 'gate-failed', 'warm-prefix', 'gate-passed', 'cold-point-return',
      ])
      // Session start is a cold point of the quota route, under the fallback
      // lifetime: the adapter declares none.
      expect(decisions[0]).toMatchObject({
        outcome: 'downgraded',
        coldPoint: { kind: 'session-start', ttlMs: 300_000, ttlSource: 'fallback' },
        cache: { base: { provider: 'deepseek-official', model: 'deepseek-v4-pro', ttlMs: 300_000, source: 'fallback' } },
      })
      // Turn 2's prefix is warm: logged once for the turn, with no judgment
      // call and no candidate capability work.
      expect(decisions[2]).toMatchObject({ outcome: 'kept-strong', coldPoint: null })
      expect(decisions[2]).not.toHaveProperty('route')
      expect(decisions[2]).not.toHaveProperty('engineId')
      expect(decisions[2]).not.toHaveProperty('candidateEligibility')
      // Turn 3 measures the recorded idle gap against the fallback lifetime.
      expect(decisions[3]).toMatchObject({
        outcome: 'downgraded',
        coldPoint: { kind: 'idle', ttlMs: 300_000, ttlSource: 'fallback' },
      })
      expect((decisions[3]?.coldPoint as { idleMs?: number }).idleMs ?? 0).toBeGreaterThan(300_000)
      // Turn 4 returns the held streak at that cold point without judging.
      expect(decisions[4]).toMatchObject({
        outcome: 'kept-strong',
        coldPoint: { kind: 'idle' },
        sticky: { active: false, stepsElapsed: 0, brokenBy: 'cold-point-return' },
      })
      expect(decisions[4]).not.toHaveProperty('route')
      await expectArmFixtures('model-router-coldpoint', output)
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('judges every turn in shadow, logs shadow decisions, and never rewrites a request', async () => {
    const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, chunkSize: 4096, successText: SUCCESS_TEXT })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-shadow.cordis.snapshot.yml'),
        promptFixture: 'model-router-shadow',
      }, server)
      // Every request ran the manual model: shadow rewrote nothing.
      expect(server.requests.map((_, index) => requestedModel(server, index))).toEqual([
        'deepseek-v4-pro', 'deepseek-v4-pro',
      ])
      const durableEvents = parseJsonl(output.session)
      const configuration = durableEvents
        .filter(event => event['type'] === 'model-routing/configuration')
        .map(event => event['data'])
      expect(configuration).toEqual([{ active: true, shadow: true }])
      const decisions = durableEvents
        .filter(event => event['type'] === 'model-routing/decision')
        .map(event => event['data'] as Record<string, unknown>)
      expect(decisions).toHaveLength(2)
      for (const decision of decisions) {
        expect(decision).toMatchObject({
          outcome: 'downgraded',
          reason: 'gate-passed',
          shadow: true,
          selection: { candidateId: 'flash', model: 'deepseek-v4-flash' },
        })
      }
      // The second consult continued the streak the shadow fold simulated.
      expect(decisions[1]).toMatchObject({ sticky: { active: true, stepsElapsed: 1 } })
      // The live sticky fold never held anything.
      expect(durableEvents.some(event => event['type'] === 'agent/model-selection')).toBe(false)
      const headers = durableEvents
        .filter(event => event['type'] === 'request/header')
        .map(event => (event['data'] as { header: { config: { model: string } } }).header.config.model)
      expect(headers.length).toBeGreaterThan(0)
      expect(headers.every(model => model === 'deepseek-v4-pro')).toBe(true)
      await expectArmFixtures('model-router-shadow', output)
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('routes a spawn child through childPolicies and keeps a fork on the inherited model', async () => {
    const server = await startMockLlmServer({
      sequence: ['success'],
      repeatLast: true,
      chunkSize: 4096,
      successText: SUCCESS_TEXT,
    })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-subagent.cordis.snapshot.yml'),
        promptFixture: 'model-router-subagent',
        driver: 'model-router-subagent-driver',
      }, server)
      const events = parseJsonl(output.session)
      const childDecisions = events.filter(event => event['type'] === 'model-routing/child-decision')
      expect(childDecisions.length).toBeGreaterThanOrEqual(1)
      expect(childDecisions.some(event => (event['data'] as { outcome?: string; shadow?: boolean }).outcome === 'routed'
        && (event['data'] as { shadow?: boolean }).shadow !== true)).toBe(true)
      const models = server.requests.map((_, index) => requestedModel(server, index))
      expect(models).toContain('deepseek-v4-flash')
      expect(models).toContain('deepseek-v4-pro')
      const children = output.children ?? []
      expect(children).toHaveLength(2)
      const spawnChild = children.find(content => content.includes('"agentRouteRequestId"'))
      if (spawnChild === undefined) throw new Error('model-router-subagent persisted no routed spawn child log')
      expect(childHeaderModel(spawnChild)).toBe('deepseek-v4-flash')
      const forkChild = children.find(content => !content.includes('"agentRouteRequestId"'))
      if (forkChild === undefined) throw new Error('model-router-subagent persisted no inherited fork child log')
      const parentHeader = events.filter(event => event['type'] === 'request/header').at(-1) as { data?: { header?: { config?: { model?: string } } } } | undefined
      expect(childHeaderModel(forkChild)).toBe(parentHeader?.data?.header?.config?.model)
      expect(childDecisions).toHaveLength(1)
      await expectArmFixtures('model-router-subagent', output)
      await expectChildFixtures('model-router-subagent', children)
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('shadows a child-decision and keeps the child header on the inherited route', async () => {
    const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, chunkSize: 4096, successText: SUCCESS_TEXT })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-subagent-shadow.cordis.snapshot.yml'),
        promptFixture: 'model-router-subagent-shadow',
        driver: 'model-router-subagent-shadow-driver',
      }, server)
      const childDecisions = parseJsonl(output.session).filter(event => event['type'] === 'model-routing/child-decision')
      expect(childDecisions.some(event => (event['data'] as { shadow?: boolean }).shadow === true)).toBe(true)
      const child = output.children?.[0]
      if (child === undefined) throw new Error('model-router-subagent-shadow persisted no child log')
      expect(child).toContain('deepseek-v4-pro')
      expect(child).not.toContain('deepseek-v4-flash')
      await expectArmFixtures('model-router-subagent-shadow', output)
      await expectChildFixtures('model-router-subagent-shadow', output.children ?? [])
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('judges a child route with the scripted engine and runs the selected candidate', async () => {
    const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, chunkSize: 4096, successText: SUCCESS_TEXT })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-subagent-judge.cordis.snapshot.yml'),
        promptFixture: 'model-router-subagent-judge',
        driver: 'model-router-subagent-judge-driver',
      }, server)
      const childDecisions = parseJsonl(output.session).filter(event => event['type'] === 'model-routing/child-decision')
      expect(childDecisions.some(event => (event['data'] as { reason?: string }).reason === 'child-judged')).toBe(true)
      const child = output.children?.[0]
      if (child === undefined) throw new Error('model-router-subagent-judge persisted no child log')
      expect(child).toContain('agentRouteRequestId')
      expect(child).toContain('deepseek-v4-flash')
      await expectArmFixtures('model-router-subagent-judge', output)
      await expectChildFixtures('model-router-subagent-judge', output.children ?? [])
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('suspends a candidate after two countable child failures and keeps the third child inherited', async () => {
    const server = await startMockLlmServer({
      sequence: ['success', 'quota_exceeded', 'quota_exceeded', 'success'],
      repeatLast: false,
      chunkSize: 4096,
      successText: SUCCESS_TEXT,
    })
    try {
      const output = await runArm({
        configPath: join(exampleDir, 'model-router-subagent-guard.cordis.snapshot.yml'),
        promptFixture: 'model-router-subagent-guard',
        driver: 'model-router-subagent-guard-driver',
      }, server)
      const events = parseJsonl(output.session)
      const outcomes = events.filter(event => event['type'] === 'model-routing/child-outcome')
      expect(outcomes.filter(event => (event['data'] as { countedAs?: string }).countedAs === 'failure').length).toBe(2)
      const decisions = events.filter(event => event['type'] === 'model-routing/child-decision')
      expect(decisions.at(-1)).toMatchObject({ data: { outcome: 'kept', reason: 'child-route-errors' } })
      const children = output.children ?? []
      expect(children).toHaveLength(3)
      expect(childHeaderModel(children[0]!)).toBe('deepseek-v4-flash')
      expect(childHeaderModel(children[1]!)).toBe('deepseek-v4-flash')
      expect(childHeaderModel(children[2]!)).toBe('deepseek-v4-pro')
      await expectArmFixtures('model-router-subagent-guard', output)
      await expectChildFixtures('model-router-subagent-guard', output.children ?? [])
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
