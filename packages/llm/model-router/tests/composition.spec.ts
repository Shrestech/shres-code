import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import AgentRegistry from '@shres-code/shres-code-agent'
import type { Agent } from '@shres-code/shres-code-agent'
import AgentDefaultModel from '@shres-code/shres-code-agent-default-model'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import CommandRuntime from '@shres-code/shres-code-commands'
import LlmRuntime, { createUserMessage } from '@shres-code/shres-code-llm'
// A function plugin: the Loader reads its `name`/`inject`/`apply` namespace, not a default.
import * as DeepSeekPlugin from '@shres-code/shres-code-llm-deepseek'
import { startMockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import type { MockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import type { SessionEvent } from '@shres-code/shres-code-session'
import SessionProjectionRegistry from '@shres-code/shres-code-session-projection'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import ModelRoutingController, { ROUTE_COMMAND, ROUTE_QUESTION_ID, DIFFICULTY_QUESTION_ID } from '../src/index.ts'
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
  '      - id: vision',
  `        provider: ${PROVIDER}`,
  `        model: ${SECOND_CANDIDATE_MODEL}`,
  '    downgradeThreshold: 0.7',
  '    downgradeMargin: 0.5',
  '    minTurnsDowngraded: 3',
  // Deployment choice: the lift's threshold sits above the scripted difficulty.
  '    difficultyToEffort:',
  '      scoreThreshold: 4',
  '      reasoningEffort: high',
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

/** Boot one test-only cordis.yml through the real Loader and its include builtin. */
async function loadSpine(baseURL: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'shres-model-router-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@shres-code/shres-code-llm'",
    "- name: '@shres-code/shres-code-session'",
    "- name: '@shres-code/shres-code-system-prompt'",
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
    ...ROUTER_CONFIG,
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
async function boot(successText = 'ROUTED_OK'): Promise<Context> {
  server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, chunkSize: 4096, successText })
  return loadSpine(server.baseURL)
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

/** Create the one root agent on the manual route with its live model selection installed. */
function createAgent(loaded: Context, id: string): Agent {
  const agent = loaded.agentLoop.create(SessionId(id), { provider: PROVIDER, model: MANUAL_MODEL })
  loaded.agentDefaultModel.selectionFor(agent)
  return agent
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
        turnsElapsed: 0,
        enteredTurn: 1,
        entryBase: { provider: PROVIDER, model: MANUAL_MODEL },
      },
    })
    expect(decision?.data.route).toMatchObject({ choice: SCRIPTED_CANDIDATE, confidence: 0.9 })
    expect(decision?.data.difficulty).toMatchObject({ score: 2 })

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
    expect(asked.questions[0]).toMatchObject({
      kind: 'choice',
      options: [{ option: SCRIPTED_CANDIDATE }, { option: 'vision' }],
    })

    // The projection renders the same decision the log holds. Its `active` is the
    // LOGGED mode, which is off before the first `model-routing/mode` event.
    const projection = loaded.sessionProjections.snapshot(agent.session).values['modelRouting']
    expect(projection).toMatchObject({
      active: false,
      pending: false,
      last: { outcome: 'downgraded', selection: { model: CANDIDATE_MODEL } },
      sticky: { active: true, turnsElapsed: 0, selection: { model: CANDIDATE_MODEL } },
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
      sticky: { active: true, turnsElapsed: 0, enteredTurn: 1 },
    })
    // The second turn re-judges the same state, and the streak keeps the route
    // it entered on instead of returning to the manual route.
    expect(decisions[1]?.data).toMatchObject({
      outcome: 'downgraded',
      reason: 'gate-passed',
      selection: { candidateId: SCRIPTED_CANDIDATE, provider: PROVIDER, model: CANDIDATE_MODEL },
      sticky: {
        active: true,
        turnsElapsed: 1,
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
        turnsElapsed: 1,
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
    await pinManualRoute(loaded, agent)

    await turn(agent, 'First easy turn.')
    expect(eventsOfType(agent.session.events, 'model-routing/decision')).toHaveLength(1)

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
    expect(requestedModel(1)).toBe(MANUAL_MODEL)
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
        turnsElapsed: 1,
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
      sticky: { active: false, turnsElapsed: 0, brokenBy: 'manual-deviation' },
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
