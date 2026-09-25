import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import AgentRegistry, { modelSelectionInstalled } from '@shres-code/shres-code-agent'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import type { Agent } from '@shres-code/shres-code-agent'
import AgentDefaultModel from '@shres-code/shres-code-agent-default-model'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import CommandRuntime from '@shres-code/shres-code-commands'
import BasicCompactionEngine from '@shres-code/shres-code-compaction-basic'
import LlmRuntime, { createUserMessage } from '@shres-code/shres-code-llm'
// A function plugin: the Loader reads its `name`/`inject`/`apply` namespace, not a default.
import * as DeepSeekPlugin from '@shres-code/shres-code-llm-deepseek'
import { startMockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import type { MockLlmBehavior, MockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import type { SessionEvent } from '@shres-code/shres-code-session'
import SessionProjectionRegistry from '@shres-code/shres-code-session-projection'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import TokenMeter from '@shres-code/shres-code-token-meter'
import ToolRuntime from '@shres-code/shres-code-tools'
import JsonlSessionPersistence from '@shres-code/shres-code-session-persistence-jsonl'
import SubagentRuntime, { effectiveAgentRoute } from '@shres-code/shres-code-subagent'
import type { SubagentChildRouteRequest } from '@shres-code/shres-code-subagent'
import * as SubagentFork from '@shres-code/shres-code-subagent-fork-in-process'
import * as SubagentSpawn from '@shres-code/shres-code-subagent-spawn-in-process'
import * as ToolSubagent from '@shres-code/shres-code-tool-subagent'
import ModelRoutingController, { KEEP_CURRENT_OPTION_ID, ROUTE_COMMAND, ROUTE_QUESTION_ID, DIFFICULTY_QUESTION_ID } from '../src/index.ts'
import * as ModelRouterInvariant from '../src/invariant.ts'
import { FakeJudgment, SCRIPTED_CANDIDATE, SCRIPTED_ENGINE, SCRIPTED_OTHER_CANDIDATE } from './fake-judgment-provider.ts'

/**
 * REAL composition of `@shres-code/shres-code-model-router`: the shipping agent
 * spine, the shipping `/route` command registry and projection registry, a real
 * DeepSeek adapter pointed at the loopback stub server, a scripted
 * `ctx.judgment` engine, and the router itself, all booted from a test-only
 * `cordis.yml` through the real Loader. Only the two external services — the
 * model provider and the judgment engine — are substituted; the loop, the
 * session log, the fold, the command, and the projection are the shipped ones.
 *
 * The keyless, deterministic inputs are the stub server (one fixed behavior
 * script) and {@link FakeJudgment} (one fixed answer script); nothing here
 * reads a credential, a clock, or the network beyond loopback.
 */

/** The provider route the composition registers. */
const PROVIDER = 'deepseek-official'

/** Manual (default) route the sessions start on. */
const MANUAL_MODEL = 'deepseek-v4-pro'

/** Allowlisted downgrade target the scripted judgment selects. */
const CANDIDATE_MODEL = 'deepseek-v4-flash'

/** A second allowlisted route, so the route question carries a real distribution. */
const SECOND_CANDIDATE_MODEL = 'deepseek-v4-flash-vision-exp'

/** Router composition entry: both candidates allowed, stickiness on, easy turns held. */
const ROUTER_CONFIG: readonly string[] = [
  '    initialMode: on',
  '    candidates:',
  `      - id: ${SCRIPTED_CANDIDATE}`,
  `        provider: ${PROVIDER}`,
  `        model: ${CANDIDATE_MODEL}`,
  '        description: a small, well-scoped change in familiar code',
  '      - id: vision',
  `        provider: ${PROVIDER}`,
  `        model: ${SECOND_CANDIDATE_MODEL}`,
  '        description: a small change that reads an image',
  '    routeFrom:',
  `      - { provider: ${PROVIDER}, model: ${MANUAL_MODEL}, objective: dollars }`,
  '    downgradeThreshold: 0.7',
  '    downgradeMargin: 0.5',
  '    hold: { minSteps: 3 }',
  '    routeInstructions: Pick the cheapest route that can finish this turn.',
  '    difficultyInstructions: Rate how much reasoning this turn needs.',
]

/** Cold-cache Loader resolution can exceed the default per-test budget. */
const COMPOSITION_TIMEOUT_MS = 60_000

let root: string | undefined
let context: Context | undefined
let server: MockLlmServer | undefined
let previousApiKey: string | undefined

beforeEach(() => {
  previousApiKey = process.env['DEEPSEEK_API_KEY']
  process.env['DEEPSEEK_API_KEY'] = 'model-router-composition-key'
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await server?.close()
  server = undefined
  if (previousApiKey === undefined) delete process.env['DEEPSEEK_API_KEY']
  else process.env['DEEPSEEK_API_KEY'] = previousApiKey
  previousApiKey = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Optional rows one boot adds to the spine. */
interface SpineOptions {
  /** Deployment persona template for the system-prompt row. */
  readonly persona?: string
  /** Compose the invariant registry and this package's companion. */
  readonly invariants?: boolean
  /** Router `inTurnFallback`; omitted keeps the documented default. */
  readonly inTurnFallback?: 'manual' | 'off'
  /** Compose compaction-basic with automatic compaction off, and its summarization route when stated. */
  readonly compaction?: { readonly summarizationRoute?: 'manual' | 'request' }
  /** Compose session persistence, the subagent runtime, spawn and fork, `tool-subagent`, and a child-route observer. */
  readonly subagents?: boolean
  /** Router `hold` as a YAML flow mapping, replacing the default `{ minSteps: 3 }`. */
  readonly hold?: string
}

/** `inherited` of every `subagent/child-route` dispatch the observer saw. */
const childRouteInherited: SubagentChildRouteRequest['inherited'][] = []

/** TEST PLUGIN: observes `subagent/child-route` and delegates, so it routes nothing. */
const ChildRouteObserver = {
  name: 'child-route-observer',
  inject: ['subagents'],
  apply(ctx: Context): void {
    ctx.on('subagent/child-route', (request, next) => {
      childRouteInherited.push(request.inherited)
      return next()
    })
  },
}

/** Boot one test-only cordis.yml through the real Loader and its include builtin. */
async function loadSpine(baseURL: string, options: SpineOptions = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'shres-model-router-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@shres-code/shres-code-llm'",
    "- name: '@shres-code/shres-code-session'",
    "- name: '@shres-code/shres-code-system-prompt'",
    // A double-quoted YAML scalar keeps the persona's `{{variable}}` braces literal.
    ...options.persona === undefined ? [] : ['  config:', `    persona: ${JSON.stringify(options.persona)}`],
    "- name: '@shres-code/shres-code-tools'",
    "- name: '@shres-code/shres-code-agent'",
    "- name: '@shres-code/shres-code-commands'",
    "- name: '@shres-code/shres-code-session-projection'",
    "- name: '@shres-code/shres-code-agent-default-model'",
    '  config:',
    `    provider: ${PROVIDER}`,
    `    model: ${MANUAL_MODEL}`,
    "- name: '@shres-code/shres-code-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@shres-code/shres-code-llm-deepseek'",
    '  config:',
    `    baseURL: '${baseURL}/v1'`,
    "- name: '@test/model-router-judgment'",
    "- name: '@shres-code/shres-code-model-router'",
    '  config:',
    ...ROUTER_CONFIG.map(line => options.hold !== undefined && line.startsWith('    hold:') ? `    hold: ${options.hold}` : line),
    ...options.inTurnFallback === undefined ? [] : [`    inTurnFallback: ${options.inTurnFallback}`],
    ...options.invariants === true
      ? ["- name: '@shres-code/shres-code-invariants'", "- name: '@shres-code/shres-code-model-router/invariant'"]
      : [],
    ...options.subagents === true ? [
      "- name: '@shres-code/shres-code-session-persistence-jsonl'",
      '  config:',
      `    root: '${join(root, 'sessions')}'`,
      "- name: '@shres-code/shres-code-subagent'",
      "- name: '@shres-code/shres-code-subagent-spawn-in-process'",
      '  config:',
      '    providerName: spawn',
      "- name: '@shres-code/shres-code-subagent-fork-in-process'",
      '  config:',
      '    providerName: fork',
      "- name: '@shres-code/shres-code-tool-subagent'",
      '  config:',
      '    provider: spawn',
      "- name: '@test/child-route-observer'",
    ] : [],
    ...options.compaction === undefined ? [] : [
      "- name: '@shres-code/shres-code-token-meter'",
      "- name: '@shres-code/shres-code-compaction-basic'",
      '  config:',
      '    auto: false',
      ...options.compaction.summarizationRoute === undefined
        ? []
        : [`    summarizationRoute: ${options.compaction.summarizationRoute}`],
    ],
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@shres-code/shres-code-llm', LlmRuntime],
    ['@shres-code/shres-code-session', SessionStore],
    ['@shres-code/shres-code-system-prompt', SystemPrompt],
    ['@shres-code/shres-code-tools', ToolRuntime],
    ['@shres-code/shres-code-agent', AgentRegistry],
    ['@shres-code/shres-code-commands', CommandRuntime],
    ['@shres-code/shres-code-session-projection', SessionProjectionRegistry],
    ['@shres-code/shres-code-agent-default-model', AgentDefaultModel],
    ['@shres-code/shres-code-agent-loop', AgentLoop],
    ['@shres-code/shres-code-llm-deepseek', DeepSeekPlugin],
    ['@test/model-router-judgment', FakeJudgment],
    ['@shres-code/shres-code-model-router', ModelRoutingController],
    ['@shres-code/shres-code-invariants', InvariantRegistry],
    ['@shres-code/shres-code-model-router/invariant', ModelRouterInvariant],
    ['@shres-code/shres-code-token-meter', TokenMeter],
    ['@shres-code/shres-code-compaction-basic', BasicCompactionEngine],
    ['@shres-code/shres-code-session-persistence-jsonl', JsonlSessionPersistence],
    ['@shres-code/shres-code-subagent', SubagentRuntime],
    ['@shres-code/shres-code-subagent-spawn-in-process', SubagentSpawn],
    ['@shres-code/shres-code-subagent-fork-in-process', SubagentFork],
    ['@shres-code/shres-code-tool-subagent', ToolSubagent],
    ['@test/child-route-observer', ChildRouteObserver],
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

/** Start the stub model server and boot the composition against it. */
async function boot(
  successText = 'ROUTED_OK',
  sequence: readonly MockLlmBehavior[] = ['success'],
  options: SpineOptions = {},
  tool?: { readonly name: string; readonly arguments: string },
): Promise<Context> {
  server = await startMockLlmServer({
    sequence,
    repeatLast: true,
    chunkSize: 4096,
    successText,
    ...tool === undefined ? {} : { toolName: tool.name, toolArguments: tool.arguments },
  })
  return loadSpine(server.baseURL, options)
}

/** The scripted judgment engine the composition mounted. */
function scriptedEngine(loaded: Context): FakeJudgment {
  const engine = loaded.get('judgment')
  if (!(engine instanceof FakeJudgment)) throw new Error('the composition did not mount the scripted judgment engine')
  return engine
}

/** Pin this agent's manual route through the shipped `/model` command. */
async function pinManualRoute(loaded: Context, agent: Agent): Promise<void> {
  const execution = await loaded.commands.execute(
    agent,
    `/model ${PROVIDER} ${MANUAL_MODEL}`,
    new AbortController().signal,
  )
  expect(execution?.result.kind).toBe('success')
}

/** Create the one root agent on the manual route; the registry installs its model-selection hook. */
function createAgent(loaded: Context, id: string, cwd?: string): Agent {
  return loaded.agentLoop.create(SessionId(id), { provider: PROVIDER, model: MANUAL_MODEL }, cwd === undefined ? {} : { cwd })
}

/** Drive one user turn to whole-agent idle. */
async function turn(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** Events of one type from a session log, in log order. */
function eventsOfType<T extends SessionEvent['type']>(
  events: readonly SessionEvent[],
  type: T,
): Extract<SessionEvent, { type: T }>[] {
  return events.flatMap(event => event.type === type ? [event as Extract<SessionEvent, { type: T }>] : [])
}

/** The `model` field of one captured stub-server request body. */
function requestedModel(index: number): unknown {
  const request = server?.requests[index]
  return (request?.body as { model?: unknown } | undefined)?.model
}

describe('real Loader composition', () => {
  it('downgraded request system prompt does not name the manual model', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    // The shipped headless persona, read from its bundle patch so this case
    // follows the product text; the invariant companion guards the same rule.
    const patch = await readFile(new URL('../../../bundle/headless/cordis.patch.yml', import.meta.url), 'utf8')
    const persona = /persona: >-\n\s+(\S.*)\n/.exec(patch)?.[1]
    if (persona === undefined) throw new Error('the headless bundle patch declares no folded persona line')
    const loaded = await boot('ROUTED_OK', ['success'], { persona, invariants: true })
    const cwd = root!
    const agent = createAgent(loaded, 'router-persona', cwd)
    await turn(agent, 'Summarize the failing test name.')

    const log = agent.session.events
    const [decision] = eventsOfType(log, 'model-routing/decision')
    expect(decision?.data).toMatchObject({ outcome: 'downgraded', sticky: { entryBase: { model: MANUAL_MODEL } } })
    const [header] = eventsOfType(log, 'request/header')
    expect(header?.data.header.config).toMatchObject({ model: CANDIDATE_MODEL })
    expect(header?.data.header.system).toContain(persona.replace('{{cwd}}', cwd))
    expect(header?.data.header.system).not.toContain(MANUAL_MODEL)
    expect(eventsOfType(log, 'turn/end')[0]?.data.reason.kind).toBe('completed')
  })

  it('refuses a routed request whose persona names the manual model', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot('ROUTED_OK', ['success'], { persona: 'You are powered by the {{model}} model.', invariants: true })
    const agent = createAgent(loaded, 'router-persona-model')
    await turn(agent, 'Summarize the failing test name.')

    const log = agent.session.events
    expect(eventsOfType(log, 'model-routing/decision')[0]?.data.outcome).toBe('downgraded')
    // The guard rejects the routed header before publication, so none is logged.
    expect(eventsOfType(log, 'request/header')).toEqual([])
    expect(server?.requests).toEqual([])
    const ended = eventsOfType(log, 'turn/end')[0]?.data.reason
    expect(ended?.kind).toBe('error')
    expect(JSON.stringify(ended)).toContain('routed request names the manual model')
  })

  it('downgrades a judged turn and the consumed request header carries the decision selection', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot()

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.get('modelRouting')).toBeInstanceOf(ModelRoutingController)
    expect(loaded.get('judgment')).toBeInstanceOf(FakeJudgment)

    const agent = createAgent(loaded, 'router-turn-one')
    await turn(agent, 'Summarize the failing test name.')

    const log = agent.session.events
    const [decision] = eventsOfType(log, 'model-routing/decision')
    expect(decision).toBeDefined()
    expect(decision?.data).toMatchObject({
      outcome: 'downgraded',
      reason: 'gate-passed',
      selection: { candidateId: SCRIPTED_CANDIDATE, provider: PROVIDER, model: CANDIDATE_MODEL },
      engine: SCRIPTED_ENGINE,
      sticky: {
        active: true,
        stepsElapsed: 0,
        enteredTurn: 1,
        entryBase: { provider: PROVIDER, model: MANUAL_MODEL },
      },
    })
    expect(decision?.data.route).toMatchObject({ choice: SCRIPTED_CANDIDATE, confidence: 0.9 })
    expect(decision?.data.difficulty).toMatchObject({ score: 1 })

    // The decision is written before the turn's request header, and the header
    // the stub server consumed carries exactly the selected route.
    const [turnStart] = eventsOfType(log, 'turn/start')
    const [turnEnd] = eventsOfType(log, 'turn/end')
    const [header] = eventsOfType(log, 'request/header')
    expect(turnStart).toBeDefined()
    expect(header).toBeDefined()
    expect(turnEnd).toBeDefined()
    expect(turnStart!.seq).toBeLessThan(decision!.seq)
    expect(decision!.seq).toBeLessThan(header!.seq)
    expect(header!.seq).toBeLessThan(turnEnd!.seq)
    expect(header!.data.header.config).toMatchObject({ provider: PROVIDER, model: CANDIDATE_MODEL })

    // The stub server received that route, and the judgment engine was asked
    // both questions the router owns.
    expect(server?.requests).toHaveLength(1)
    expect(server?.requests[0]?.path).toBe('/v1/chat/completions')
    expect(requestedModel(0)).toBe(CANDIDATE_MODEL)
    const judgment = scriptedEngine(loaded)
    expect(judgment.asks).toHaveLength(1)
    const asked = judgment.asks[0]!
    expect(asked.questions.map(question => question.id)).toEqual([ROUTE_QUESTION_ID, DIFFICULTY_QUESTION_ID])
    expect(asked.state).toContain('Summarize the failing test name.')
    expect(asked.questions[0]).toMatchObject({ kind: 'choice' })
    const routeQuestion = asked.questions[0]
    if (routeQuestion?.kind !== 'choice') throw new Error('the route question was not a choice question')
    expect(routeQuestion.options.map(option => option.option)).toEqual([
      KEEP_CURRENT_OPTION_ID,
      SCRIPTED_CANDIDATE,
      SCRIPTED_OTHER_CANDIDATE,
    ])

    // The projection renders the same decision the log holds. Its `active` is
    // the mode in force: `initialMode: on` with no logged mode event is on.
    const projection = loaded.sessionProjections.snapshot(agent.session).values['modelRouting']
    expect(projection).toMatchObject({
      active: true,
      pending: false,
      last: { outcome: 'downgraded', selection: { model: CANDIDATE_MODEL } },
      sticky: { active: true, stepsElapsed: 0, selection: { model: CANDIDATE_MODEL } },
    })
  })

  it('holds the downgrade across turns while the manual route stays pinned', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot()
    const agent = createAgent(loaded, 'router-streak')
    await pinManualRoute(loaded, agent)

    await turn(agent, 'First easy turn.')
    await turn(agent, 'Second easy turn.')

    const decisions = eventsOfType(agent.session.events, 'model-routing/decision')
    expect(decisions).toHaveLength(2)
    expect(decisions[0]?.data).toMatchObject({
      outcome: 'downgraded',
      reason: 'gate-passed',
      sticky: { active: true, stepsElapsed: 0, enteredTurn: 1 },
    })
    // The second turn re-judges the same state, and the streak keeps the route
    // it entered on instead of returning to the manual route.
    expect(decisions[1]?.data).toMatchObject({
      outcome: 'downgraded',
      reason: 'gate-passed',
      selection: { candidateId: SCRIPTED_CANDIDATE, provider: PROVIDER, model: CANDIDATE_MODEL },
      sticky: {
        active: true,
        stepsElapsed: 1,
        enteredTurn: 1,
        entryBase: { provider: PROVIDER, model: MANUAL_MODEL },
      },
    })

    // Both turns ran on the held route, each behind its own header inside its
    // own turn window.
    expect(server?.requests).toHaveLength(2)
    expect(requestedModel(1)).toBe(CANDIDATE_MODEL)
    // The held route leaves the composed header unchanged, so the second turn
    // consumes the header turn one logged instead of writing another one.
    const headers = eventsOfType(agent.session.events, 'request/header')
    expect(headers.map(header => header.data.header.config.model)).toEqual([CANDIDATE_MODEL])
    const secondTurnStart = eventsOfType(agent.session.events, 'turn/start')[1]!
    expect(decisions[1]!.seq).toBeGreaterThan(secondTurnStart.seq)
    expect(headers[0]!.seq).toBeLessThan(secondTurnStart.seq)
  })

  it('compaction-basic summarizes a held streak on the manual route unless summarizationRoute is request', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    for (const [route, expected] of [[undefined, MANUAL_MODEL], ['request', CANDIDATE_MODEL]] as const) {
      const loaded = await boot('ROUTED_OK', ['success'], { compaction: route === undefined ? {} : { summarizationRoute: route } })
      const agent = createAgent(loaded, `router-compaction-${route ?? 'default'}`)
      await pinManualRoute(loaded, agent)
      // Long enough that the framed summary is smaller than what it replaces.
      await turn(agent, `First easy turn. ${'Context line. '.repeat(200)}`)
      await turn(agent, 'Second easy turn.')
      expect(eventsOfType(agent.session.events, 'model-routing/decision').at(-1)?.data)
        .toMatchObject({ outcome: 'downgraded', sticky: { active: true } })
      const before = server?.requests.length ?? 0
      expect(requestedModel(before - 1)).toBe(CANDIDATE_MODEL)

      const result = await loaded.compaction.compactNow(agent, new AbortController().signal)
      expect(result).not.toBeNull()
      // The one summarization request ran on the expected route, and the log records it.
      expect(server?.requests).toHaveLength(before + 1)
      expect(requestedModel(before)).toBe(expected)
      const summary = eventsOfType(agent.session.events, 'compaction/summary').at(-1)?.data
      expect(summary).toMatchObject({ provider: PROVIDER, model: expected })
      await context?.fiber.dispose()
      context = undefined
      await server?.close()
      server = undefined
    }
  })

  it('reports the session’s own selection while a held streak serves the routed candidate', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot()
    const agent = createAgent(loaded, 'router-reported-selection')
    const selection = loaded.agentDefaultModel.selectionFor(agent)

    await turn(agent, 'First easy turn.')

    // The turn ran on the allowlisted candidate: the decision selected it, the
    // header the turn consumed carries it, and the stub endpoint served it.
    const decisions = eventsOfType(agent.session.events, 'model-routing/decision')
    expect(decisions[0]?.data).toMatchObject({ outcome: 'downgraded', reason: 'gate-passed' })
    expect(eventsOfType(agent.session.events, 'request/header').at(-1)?.data.header.config)
      .toMatchObject({ provider: PROVIDER, model: CANDIDATE_MODEL })
    expect(requestedModel(0)).toBe(CANDIDATE_MODEL)

    // The selection the Host reports for the next assembled step is still the
    // route the session is pointed at: routing rewrites the request, never the
    // session, so a held streak must not read back as a model switch.
    expect(selection.current).toEqual({ provider: PROVIDER, model: MANUAL_MODEL })
  })

  it('keeps the held route when the gate fails below the streak horizon, recording the entry base', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot()
    const agent = createAgent(loaded, 'router-hold')
    await pinManualRoute(loaded, agent)

    await turn(agent, 'First easy turn.')
    // The next answer no longer clears the confidence floor on its own.
    scriptedEngine(loaded).scriptRoute(SCRIPTED_OTHER_CANDIDATE, 0.5)
    await turn(agent, 'Second easy turn.')

    const decisions = eventsOfType(agent.session.events, 'model-routing/decision')
    expect(decisions).toHaveLength(2)
    expect(decisions[1]?.data).toMatchObject({
      outcome: 'downgraded',
      reason: 'sticky-hold',
      selection: { candidateId: SCRIPTED_CANDIDATE, provider: PROVIDER, model: CANDIDATE_MODEL },
      route: { choice: SCRIPTED_OTHER_CANDIDATE, confidence: 0.5 },
      sticky: {
        active: true,
        stepsElapsed: 1,
        enteredTurn: 1,
        entryBase: { provider: PROVIDER, model: MANUAL_MODEL },
      },
    })
    // A failed gate below the horizon does not move the route: the held candidate serves.
    expect(requestedModel(1)).toBe(CANDIDATE_MODEL)
  })

  it('the /route command switches routing off, and the next turn reverts to the manual route', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot()
    const agent = createAgent(loaded, 'router-off')
    const selection = loaded.agentDefaultModel.selectionFor(agent)

    await turn(agent, 'First easy turn.')
    expect(eventsOfType(agent.session.events, 'model-routing/decision')).toHaveLength(1)
    expect(selection.current).toEqual({ provider: PROVIDER, model: MANUAL_MODEL })

    // The real command, through the real registry, exactly as a UI dispatches it.
    const execution = await loaded.commands.execute(agent, `/${ROUTE_COMMAND} off`, new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success', text: 'Model routing off.' })
    const modes = eventsOfType(agent.session.events, 'model-routing/mode')
    expect(modes.map(mode => mode.data.active)).toEqual([false])
    expect(loaded.modelRouting.get(agent)).toEqual({ active: false })

    await turn(agent, 'Second easy turn.')

    // Switching the mode off is a user gesture, so the turn it gates must still
    // complete: a routing change never fails a turn.
    expect(eventsOfType(agent.session.events, 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' })
    // Off is off: no further decision, and no judgment ask for the turn.
    expect(eventsOfType(agent.session.events, 'model-routing/decision')).toHaveLength(1)
    expect(loaded.modelRouting.modeOf(agent.session)).toBe(false)
    expect(scriptedEngine(loaded).asks).toHaveLength(1)
    // The consumed request is the manual route again, and the stub server sees it.
    const headers = eventsOfType(agent.session.events, 'request/header')
    expect(headers.at(-1)?.data.header.config).toMatchObject({ provider: PROVIDER, model: MANUAL_MODEL })
    expect(selection.current).toEqual({ provider: PROVIDER, model: MANUAL_MODEL, reasoningEffort: 'high' })
    expect(requestedModel(1)).toBe(MANUAL_MODEL)
  })

  it('restores the initial default after routed request errors and resumes from that base', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    // Terminal candidate failures drive the route-error breaker; the in-turn
    // fallback would retry each on the manual model instead.
    const loaded = await boot('ROUTED_OK', ['success', 'rate_limit', 'rate_limit', 'success'], { inTurnFallback: 'off' })
    const agent = createAgent(loaded, 'router-route-errors')
    const selection = loaded.agentDefaultModel.selectionFor(agent)

    await turn(agent, 'First easy turn.')
    await turn(agent, 'Second easy turn.')
    await turn(agent, 'Third easy turn.')

    const ends = eventsOfType(agent.session.events, 'turn/end')
    expect(ends.map(event => event.data.reason.kind)).toEqual(['completed', 'error', 'error'])
    expect(loaded.modelRouting.stickySelection(agent)).toEqual({ provider: PROVIDER, model: MANUAL_MODEL })
    expect(selection.current).toEqual({ provider: PROVIDER, model: MANUAL_MODEL })

    await turn(agent, 'Fourth easy turn.')
    expect(requestedModel(3)).toBe(MANUAL_MODEL)
    const decisions = eventsOfType(agent.session.events, 'model-routing/decision')
    expect(decisions[3]?.data).toMatchObject({
      outcome: 'kept-strong',
      reason: 'route-errors',
      sticky: { active: false, entryBase: { provider: PROVIDER, model: MANUAL_MODEL } },
    })
    expect(scriptedEngine(loaded).asks).toHaveLength(3)

    await turn(agent, 'Fifth easy turn.')
    expect(requestedModel(4)).toBe(CANDIDATE_MODEL)
    expect(eventsOfType(agent.session.events, 'model-routing/decision')[4]?.data).toMatchObject({
      outcome: 'downgraded',
      reason: 'gate-passed',
      sticky: { active: true, entryBase: { provider: PROVIDER, model: MANUAL_MODEL } },
    })
  })

  it('resolves the session’s route from the log, holding the streak until a real manual switch ends it', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot()
    const agent = createAgent(loaded, 'router-log-manual')

    await turn(agent, 'First easy turn.')
    await turn(agent, 'Second easy turn.')

    // No selection was made in this process, so the manual route the live
    // session resolves is the one its held streak was entered on. Turn two
    // re-affirms the streak instead of reading the routed header as a deviation.
    const decisions = eventsOfType(agent.session.events, 'model-routing/decision')
    expect(decisions).toHaveLength(2)
    expect(decisions[1]?.data).toMatchObject({
      outcome: 'downgraded',
      reason: 'gate-passed',
      sticky: {
        active: true,
        stepsElapsed: 1,
        enteredTurn: 1,
        entryBase: { provider: PROVIDER, model: MANUAL_MODEL },
      },
    })
    expect(requestedModel(1)).toBe(CANDIDATE_MODEL)

    // A user switch still wins: the new manual route is a deviation from the
    // entry base, so the streak ends and the manual route returns.
    const execution = await loaded.commands.execute(
      agent,
      `/model ${PROVIDER} ${SECOND_CANDIDATE_MODEL}`,
      new AbortController().signal,
    )
    expect(execution?.result.kind).toBe('success')
    await turn(agent, 'Third easy turn.')

    expect(eventsOfType(agent.session.events, 'model-routing/decision')[2]?.data).toMatchObject({
      outcome: 'kept-strong',
      reason: 'manual-deviation',
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'manual-deviation' },
    })
    expect(requestedModel(2)).toBe(SECOND_CANDIDATE_MODEL)
  })

  it('withdraws the router service, its command, and its projection when the loaded entry fiber disposes', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot()
    const agent = createAgent(loaded, 'router-disposal')
    await turn(agent, 'First easy turn.')

    expect(loaded.get('modelRouting')).toBeDefined()
    expect(loaded.commands.find(agent, ROUTE_COMMAND)).toBeDefined()
    expect(loaded.sessionProjections.snapshot(agent.session).values['modelRouting']).toBeDefined()

    const entry = [...loaded.loader.entries()]
      .find(candidate => candidate.options.name === '@shres-code/shres-code-model-router')
    expect(entry?.fiber).toBeDefined()
    await entry?.fiber?.dispose()

    expect(loaded.get('modelRouting')).toBeUndefined()
    expect(loaded.commands.find(agent, ROUTE_COMMAND)).toBeUndefined()
    expect(loaded.sessionProjections.snapshot(agent.session).values['modelRouting']).toBeUndefined()
  })
})

describe('a root agent no front end provided a model selection for', () => {
  it('hands the router its creation route after a downgrade, and runs it when the router keeps strong', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot()
    const agent = createAgent(loaded, 'router-empty-source-kept')
    expect(modelSelectionInstalled(agent)).toBe(true)
    await turn(agent, 'First easy turn.')
    expect(requestedModel(0)).toBe(CANDIDATE_MODEL)

    // The next request is seeded from the routed header, but the manual route is
    // still the creation route: an answer preferring it ends the streak and runs it.
    scriptedEngine(loaded).scriptRoute(KEEP_CURRENT_OPTION_ID, 0.9)
    await turn(agent, 'Second easy turn.')
    const decisions = eventsOfType(agent.session.events, 'model-routing/decision')
    expect(decisions.map(event => event.data.reason)).toEqual(['gate-passed', 'current-preferred'])
    expect(decisions[1]?.data).toMatchObject({ outcome: 'kept-strong', sticky: { active: false, brokenBy: 'current-preferred' } })
    expect(requestedModel(1)).toBe(MANUAL_MODEL)
    expect(eventsOfType(agent.session.events, 'request/header').at(-1)?.data.header.config)
      .toMatchObject({ provider: PROVIDER, model: MANUAL_MODEL })
  })

  it('returns to the manual route when a hold reaches its step cap', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot('ROUTED_OK', ['success'], { hold: '{ minSteps: 0, maxSteps: 1 }' })
    const agent = createAgent(loaded, 'router-empty-source-cap')
    await turn(agent, 'First easy turn.')
    await turn(agent, 'Second easy turn.')
    const decisions = eventsOfType(agent.session.events, 'model-routing/decision')
    expect(decisions.map(event => event.data.reason)).toEqual(['gate-passed', 'hold-cap'])
    expect([requestedModel(0), requestedModel(1)]).toEqual([CANDIDATE_MODEL, MANUAL_MODEL])
  })

  it('continues a held streak from its entry base after the agent is resumed', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot('ROUTED_OK', ['success'], { subagents: true })
    const sessionId = SessionId('router-empty-source-resume')
    const handle = await loaded.agents.create({ sessionId, agentOptions: { provider: PROVIDER, model: MANUAL_MODEL } })
    await turn(handle.agent, 'First easy turn.')
    expect(requestedModel(0)).toBe(CANDIDATE_MODEL)
    await loaded.sessions.flush(handle.agent.session)
    await handle.dispose()

    const resumed = (await loaded.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: PROVIDER, model: MANUAL_MODEL },
    })).agent
    expect(modelSelectionInstalled(resumed)).toBe(true)
    await turn(resumed, 'Second easy turn.')
    // The resumed agent hands the router the streak's entry base, not the routed
    // header it was seeded from, so the streak continues instead of ending as a manual deviation.
    const decisions = eventsOfType(resumed.session.events, 'model-routing/decision')
    expect(decisions.at(-1)?.data).toMatchObject({
      outcome: 'downgraded',
      sticky: { active: true, enteredTurn: 1, entryBase: { provider: PROVIDER, model: MANUAL_MODEL } },
    })
    expect(requestedModel(1)).toBe(CANDIDATE_MODEL)

    // The resumed instance now seeds from the header it logged itself, which is
    // the candidate; the streak's entry base is still the manual route.
    await turn(resumed, 'Third easy turn.')
    expect(eventsOfType(resumed.session.events, 'model-routing/decision').at(-1)?.data).toMatchObject({
      outcome: 'downgraded',
      sticky: { active: true, enteredTurn: 1, entryBase: { provider: PROVIDER, model: MANUAL_MODEL } },
    })
    expect(requestedModel(2)).toBe(CANDIDATE_MODEL)
  })

  it('keeps a routed header in force after the router is removed, because nothing reports a manual route beneath it', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot()
    const agent = createAgent(loaded, 'router-empty-source-removed')
    await turn(agent, 'First easy turn.')
    expect(requestedModel(0)).toBe(CANDIDATE_MODEL)
    const entry = [...loaded.loader.entries()]
      .find(candidate => candidate.options.name === '@shres-code/shres-code-model-router')
    await entry?.fiber?.dispose()
    expect(loaded.get('modelRouting')).toBeUndefined()
    await turn(agent, 'Second easy turn.')
    expect(requestedModel(1)).toBe(CANDIDATE_MODEL)
  })
})

describe('children of a parent on a held downgrade', () => {
  beforeEach(() => { childRouteInherited.length = 0 })

  /** The manual route every child must inherit. */
  const MANUAL = { provider: PROVIDER, model: MANUAL_MODEL }

  /** Boot with subagents and run one easy turn, so the parent holds a downgrade streak. */
  async function heldParent(
    id: string,
    sequence: readonly MockLlmBehavior[] = ['success'],
    tool?: { readonly name: string; readonly arguments: string },
  ): Promise<{ loaded: Context; agent: Agent }> {
    const loaded = await boot('ROUTED_OK', sequence, { subagents: true }, tool)
    const agent = createAgent(loaded, id)
    await turn(agent, 'First easy turn.')
    expect(eventsOfType(agent.session.events, 'model-routing/decision')[0]?.data)
      .toMatchObject({ outcome: 'downgraded', sticky: { active: true } })
    // The parent's latest header carries the routed candidate, not its manual route,
    // while the route children inherit and the Team roster reports for a Lead is manual.
    expect(agent.session.requestHeader()?.config.model).toBe(CANDIDATE_MODEL)
    expect(effectiveAgentRoute(agent)).toEqual({ provider: PROVIDER, model: MANUAL_MODEL })
    return { loaded, agent }
  }

  it('a fresh child the parent spawns runs the manual route, and the child-route listener is told that route', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    // Step 1 asks for one subagent call; the child and the parent's step 2 answer with text.
    const tool = { name: 'subagent', arguments: JSON.stringify({ description: 'scan', prompt: 'list the files' }) }
    const { agent } = await heldParent('router-parent-spawns', ['tool_call_success', 'success'], tool)

    // Parent step 1 on the candidate, the child on the manual route, parent step 2 still held.
    expect([0, 1, 2].map(requestedModel)).toEqual([CANDIDATE_MODEL, MANUAL_MODEL, CANDIDATE_MODEL])
    expect(childRouteInherited).toEqual([MANUAL])
    // Nothing routed the child: its only decision log is the parent's.
    expect(eventsOfType(agent.session.events, 'model-routing/decision').every(event => event.data.outcome === 'downgraded')).toBe(true)
  })

  it('a fork child runs the manual route', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const { loaded, agent } = await heldParent('router-parent-forks')
    const before = server?.requests.length ?? 0
    const run = await loaded.subagents.start('fork', {
      prompt: [{ type: 'text', text: 'continue from here' }],
      parent: agent,
      signal: new AbortController().signal,
    })
    await run.result
    expect(requestedModel(before)).toBe(MANUAL_MODEL)
    await run.dispose()
  })

  it('a continuable child records and runs the manual route as its descriptor route', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const { loaded, agent } = await heldParent('router-parent-continuable')
    const before = server?.requests.length ?? 0
    const started = await loaded.subagents.startContinuable({
      provider: 'spawn',
      label: 'child task',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent: agent },
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(server?.requests.length).toBeGreaterThan(before) })
    expect(requestedModel(before)).toBe(MANUAL_MODEL)
    await vi.waitFor(async () => {
      const persisted = await loaded.sessionPersistence.load(started.childId)
      expect(persisted.events.find(event => event.type === 'subagent/descriptor')?.data)
        .toMatchObject({ agentProvider: PROVIDER, agentModel: MANUAL_MODEL })
    })
  })
})
