import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import AgentRegistry from '@shres-code/shres-code-agent'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import LlmRuntime, { createUserMessage } from '@shres-code/shres-code-llm'
// Function plugins: the Loader reads their name/inject/Config/apply namespace.
import * as DeepSeekPlugin from '@shres-code/shres-code-llm-deepseek'
import * as SubagentSpawn from '@shres-code/shres-code-subagent-spawn-in-process'
import { startMockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import type { MockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import SubagentRuntime from '@shres-code/shres-code-subagent'
import type { SubagentChildRouteRequest } from '@shres-code/shres-code-subagent'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import * as ToolSubagent from '../src/index.ts'

/** The provider route the composition registers. */
const PROVIDER = 'deepseek-official'
/** The parent's route, which an unrouted child inherits. */
const PARENT_MODEL = 'deepseek-v4-pro'
/** The route the test listener chooses for fresh children. */
const ROUTED_MODEL = 'deepseek-v4-flash'

/** Cold-cache Loader resolution can exceed the default per-test budget. */
const COMPOSITION_TIMEOUT_MS = 60_000

/** What the listener observed when the waterfall asked it. */
interface Observation {
  readonly request: SubagentChildRouteRequest
  /** Live agents at dispatch: only the parent, because the child does not exist yet. */
  readonly liveAgents: readonly string[]
}

const observations: Observation[] = []

/** Test-only plugin: routes every fresh child to the cheap model. */
const RouteListener = {
  name: 'child-route-listener',
  inject: ['subagents', 'agents'],
  apply(ctx: Context): void {
    ctx.on('subagent/child-route', async (request) => {
      observations.push({ request, liveAgents: ctx.agents.list().map(agent => String(agent.id)) })
      return { provider: PROVIDER, model: ROUTED_MODEL }
    })
  },
}

let root: string | undefined
let context: Context | undefined
let server: MockLlmServer | undefined
let previousApiKey: string | undefined

beforeEach(() => {
  observations.length = 0
  previousApiKey = process.env['DEEPSEEK_API_KEY']
  process.env['DEEPSEEK_API_KEY'] = 'child-route-composition-key'
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

/**
 * Boot one test-only cordis.yml through the real Loader and include builtin,
 * against a mock server whose first reply asks for one `subagent` call.
 */
async function boot(withListener: boolean): Promise<Context> {
  server = await startMockLlmServer({
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    chunkSize: 4096,
    successText: 'CHILD_OK',
    toolName: 'subagent',
    toolArguments: JSON.stringify({ description: 'scan the tree', prompt: 'list the files' }),
  })
  root = await mkdtemp(join(tmpdir(), 'shres-child-route-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@shres-code/shres-code-llm'",
    "- name: '@shres-code/shres-code-session'",
    "- name: '@shres-code/shres-code-system-prompt'",
    "- name: '@shres-code/shres-code-tools'",
    "- name: '@shres-code/shres-code-agent'",
    "- name: '@shres-code/shres-code-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@shres-code/shres-code-llm-deepseek'",
    '  config:',
    `    baseURL: '${server.baseURL}/v1'`,
    "- name: '@shres-code/shres-code-subagent'",
    "- name: '@shres-code/shres-code-subagent-spawn-in-process'",
    '  config:',
    '    providerName: spawn',
    "- name: '@shres-code/shres-code-tool-subagent'",
    '  config:',
    '    provider: spawn',
    ...withListener ? ["- name: '@test/child-route-listener'"] : [],
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
    ['@shres-code/shres-code-agent-loop', AgentLoop],
    ['@shres-code/shres-code-llm-deepseek', DeepSeekPlugin],
    ['@shres-code/shres-code-subagent', SubagentRuntime],
    ['@shres-code/shres-code-subagent-spawn-in-process', SubagentSpawn],
    ['@shres-code/shres-code-tool-subagent', ToolSubagent],
    ['@test/child-route-listener', RouteListener],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

/** Drive one parent turn that delegates once, to whole-agent idle. */
async function delegateOnce(loaded: Context) {
  const parent = loaded.agentLoop.create(SessionId('parent'), { provider: PROVIDER, model: PARENT_MODEL })
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'delegate a scan' }], source: { kind: 'user' } }))
  await parent.whenIdle()
  return parent
}

/** Model id of each chat request the mock server received, in order. */
function requestedModels(): string[] {
  return (server?.requests ?? []).map(record => String((record.body as { model?: unknown }).model))
}

describe('subagent/child-route in a real Loader composition', () => {
  it('runs a spawned child on the listener-chosen model, asked before the child exists', async () => {
    const loaded = await boot(true)
    const parent = await delegateOnce(loaded)

    // Parent step, the routed child's only step, then the parent's follow-up step.
    expect(requestedModels()).toEqual([PARENT_MODEL, ROUTED_MODEL, PARENT_MODEL])
    expect(observations).toHaveLength(1)
    const [observed] = observations
    expect(observed!.request).toMatchObject({
      kind: 'subagent',
      subagentProvider: 'spawn',
      agentType: 'subagent',
      prompt: 'list the files',
      inherited: { provider: PROVIDER, model: PARENT_MODEL },
    })
    expect(observed!.request.parent).toBe(parent)
    expect(observed!.liveAgents).toEqual([String(parent.id)])
  }, COMPOSITION_TIMEOUT_MS)

  it('runs the child on the inherited parent model when no listener is composed', async () => {
    const loaded = await boot(false)
    await delegateOnce(loaded)

    expect(requestedModels()).toEqual([PARENT_MODEL, PARENT_MODEL, PARENT_MODEL])
    expect(observations).toHaveLength(0)
  }, COMPOSITION_TIMEOUT_MS)
})
