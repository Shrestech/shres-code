/**
 * REAL Loader composition: the shipping agent spine, tools, session store, token
 * meter, the real judgment provider against a loopback \`/v1/systemone\` stub, the
 * real \`compaction-jev\` with the \`compaction-basic\` row disabled, and a stub
 * model server the summarizer dials. One pressure-forced turn then proves the two
 * companion events, the standard bracket, the surface replacement, both stub
 * requests, the plain \`compaction-basic\` twin, and the registry's disposal.
 *
 * TEST DOUBLES: from ./loader-harness.ts — {@link StubSystemOne},
 * {@link StubModelAdapter}, {@link MemoryCredentials}, and the boot glue. The
 * Loader, every mounted service, the sessions, and the durable transaction are
 * real, and the `compaction-jev` row is the package's real default export.
 */

import { afterEach, describe, expect, it } from 'vitest'
import AgentRegistry from '@shres-code/shres-code-agent'
import { isCompactCheckpointSource } from '@shres-code/shres-code-compaction'
import BasicCompactionEngine from '@shres-code/shres-code-compaction-basic'
import { judgmentEngineId } from '@shres-code/shres-code-judgment'
import JudgmentDispatch from '@shres-code/shres-code-judgment-dispatch'
import TypesafeJudgmentEngine from '@shres-code/shres-code-judgment-typesafe'
import { createUserMessage } from '@shres-code/shres-code-llm'
import { startMockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import type { MockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import { SessionId, isReplacementSurfaceEvent } from '@shres-code/shres-code-session'
import JevCompactionEngine from '../src/index.ts'
import {
  basicRows,
  compositionRows,
  JE_SPECIFIER,
  loadTree,
  ROUTE,
  ROUTE_MODEL,
  seedHistory,
  STUB_TEXT,
  StubModelAdapter,
  StubSystemOne,
  unloadTree,
} from './loader-harness.ts'
import type { LoadedTree } from './loader-harness.ts'

let tree: LoadedTree | undefined
let systemOne: StubSystemOne | undefined
let modelServer: MockLlmServer | undefined

afterEach(async () => {
  await unloadTree(tree)
  tree = undefined
  await systemOne?.close()
  systemOne = undefined
  await modelServer?.close()
  modelServer = undefined
})

describe('real Loader composition', () => {
  it('compacts a pressured turn through the composed judgment engine', { timeout: 60_000 }, async () => {
    systemOne = new StubSystemOne()
    const endpoint = await systemOne.start()
    modelServer = await startMockLlmServer({ sequence: ['success'], repeatLast: true, successText: STUB_TEXT })
    tree = await loadTree(compositionRows(endpoint))
    const loaded = tree.ctx

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.get('judgment')).toBeInstanceOf(JudgmentDispatch)
    expect(loaded.judgmentEngines.consumers()).toEqual(['compaction-jev'])
    expect(loaded.judgmentEngines.get(judgmentEngineId('typesafe'))?.engine).toBeInstanceOf(TypesafeJudgmentEngine)
    expect(loaded.get('compaction')).toBeInstanceOf(JevCompactionEngine)
    expect(loaded.agents).toBeInstanceOf(AgentRegistry)

    const adapter = new StubModelAdapter(modelServer.baseURL)
    loaded.llm.registerAdapter([ROUTE], adapter)
    const agent = loaded.agentLoop.create(SessionId('composition'), { provider: ROUTE, model: ROUTE_MODEL })
    seedHistory(agent.session)
    const before = [...agent.session.surface.nodes]

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue the task' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const events = agent.session.events
    const selection = events.flatMap(event => event.type === 'compaction/selection' ? [event.data] : [])
    expect(selection).toHaveLength(1)
    expect(selection[0]).toMatchObject({
      trigger: 'pressure',
      degraded: false,
      engine: 'typesafe',
      model: 'jev-latest',
      boundaryAdjustments: [],
    })
    expect(selection[0]?.segments.length).toBeGreaterThan(1)
    expect(selection[0]?.segments.every(fact => fact.disposition === 'rescued')).toBe(true)
    expect(selection[0]?.latencyMs).toBeGreaterThanOrEqual(0)

    const verification = events.flatMap(event => event.type === 'compaction/verification' ? [event.data] : [])
    expect(verification).toHaveLength(1)
    expect(verification[0]).toMatchObject({
      attempt: 1,
      provider: ROUTE,
      model: ROUTE_MODEL,
      verdict: 'accepted',
      degraded: false,
      engine: 'typesafe',
    })
    expect(verification[0]?.questions).toEqual([
      { name: 'constraints', probability: 0.95 },
      { name: 'overall', score: 5, confidence: 0.9 },
    ])

    const types = events.map(event => event.type)
    expect(types.filter(type => type === 'compaction/start')).toHaveLength(1)
    expect(types.filter(type => type === 'compaction/summary')).toHaveLength(1)
    expect(types.filter(type => type === 'compaction/end')).toHaveLength(1)
    expect(types.indexOf('compaction/start')).toBeLessThan(types.indexOf('compaction/summary'))
    expect(types.indexOf('compaction/summary')).toBeLessThan(types.indexOf('compaction/end'))

    // The surface was replaced by a checkpoint node, and it is smaller.
    const replacement = events.find(event =>
      event.type === 'user/message' && isReplacementSurfaceEvent(event))
    expect(replacement !== undefined && replacement.type === 'user/message'
      ? isCompactCheckpointSource(replacement.data.source)
      : false).toBe(true)
    expect(agent.session.surface.nodes.length).toBeLessThan(before.length)
    expect(agent.session.deriveMessages().at(-1)?.content[0])
      .toEqual({ type: 'text', text: STUB_TEXT })

    // Both stubs received their requests on their expected routes: one score ask,
    // one hazard ask per sub-span edge, and one battery ask.
    expect(systemOne.requests).toHaveLength(4)
    expect(systemOne.requests.every(request => request.path === '/v1/systemone')).toBe(true)
    expect(systemOne.requests.every(request => request.body.model === 'jev-latest')).toBe(true)
    const scoreAsk = systemOne.requests.find(request =>
      Object.values(request.body.questions ?? {}).some(question => question.type === 'score'))
    expect(Object.keys(scoreAsk?.body.questions ?? {}).length).toBeGreaterThan(1)
    expect(scoreAsk?.body.state).toContain('--- segment ')
    expect(systemOne.requests.some(request => 'constraints' in (request.body.questions ?? {}))).toBe(true)
    const summaryCall = adapter.calls.find(call => call.purpose === 'compaction')
    expect(summaryCall).toBeDefined()
    expect(summaryCall?.provider).toBe(ROUTE)
    const compactionRequest = modelServer.requests.find(request =>
      JSON.stringify(request.body).includes('compaction engine for this AI coding assistant'))
    expect(compactionRequest?.path).toContain('chat/completions')
  })

  it('compacts the same history through the plain compaction-basic twin', { timeout: 60_000 }, async () => {
    systemOne = new StubSystemOne()
    const endpoint = await systemOne.start()
    modelServer = await startMockLlmServer({ sequence: ['success'], repeatLast: true, successText: STUB_TEXT })
    tree = await loadTree(compositionRows(endpoint, basicRows()))
    const loaded = tree.ctx

    expect(loaded.get('compaction')).toBeInstanceOf(BasicCompactionEngine)
    const adapter = new StubModelAdapter(modelServer.baseURL)
    loaded.llm.registerAdapter([ROUTE], adapter)
    const agent = loaded.agentLoop.create(SessionId('composition-basic'), { provider: ROUTE, model: ROUTE_MODEL })
    seedHistory(agent.session)

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue the task' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const types = agent.session.events.map(event => event.type)
    expect(types.filter(type => type === 'compaction/summary')).toHaveLength(1)
    // The twin writes no companion event and asks the judgment provider nothing.
    expect(types).not.toContain('compaction/selection')
    expect(types).not.toContain('compaction/verification')
    expect(systemOne.requests).toHaveLength(0)
  })

  it('withdraws ctx.compaction when the engine entry fiber disposes', { timeout: 60_000 }, async () => {
    systemOne = new StubSystemOne()
    const endpoint = await systemOne.start()
    tree = await loadTree(compositionRows(endpoint))
    const entry = [...tree.ctx.loader.entries()].find(candidate => candidate.options.name === JE_SPECIFIER)

    expect(entry?.fiber).toBeDefined()
    expect(tree.ctx.get('compaction')).toBeDefined()
    await entry?.fiber?.dispose()

    expect(tree.ctx.get('compaction')).toBeUndefined()
  })
})
