import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { Stream } from '@agentclientprotocol/sdk'
import { Context } from '@shres-code/cordis'
import * as AcpServer from '@shres-code/shres-code-acp'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import AgentRegistry from '@shres-code/shres-code-agent'
import type { Agent } from '@shres-code/shres-code-agent'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import LlmRuntime, { createUserMessage } from '@shres-code/shres-code-llm'
import * as DeepSeekPlugin from '@shres-code/shres-code-llm-deepseek'
import { startMockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import type { MockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import * as JsonRpcServer from '@shres-code/shres-code-sdk-jsonrpc-server'
import SessionStore from '@shres-code/shres-code-session'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import ModelRoutingController from '../src/index.ts'
import { FakeJudgment, SCRIPTED_CANDIDATE } from './fake-judgment-provider.ts'

/**
 * REAL Loader compositions of front ends that provide no model selection of
 * their own: the JSON-RPC server, which creates each session's agent on its
 * first prompt, the ACP server, which creates it on `session/new`, and an
 * agent the agent loop pre-creates from its `agents` config. Neither composes `agent-default-model` nor calls `selectionFor`; the
 * agent registry's model-selection hook is what reaches the router, so each
 * records a routing decision and runs the routed candidate.
 *
 * TEST DOUBLES: the loopback stub model server and the scripted judgment
 * engine. The JSON-RPC and ACP servers run over in-memory streams, as their
 * own plugin tests do.
 */

const PROVIDER = 'deepseek-official'
const MANUAL_MODEL = 'deepseek-v4-pro'
const CANDIDATE_MODEL = 'deepseek-v4-flash'
const TIMEOUT_MS = 60_000

let root: string | undefined
let context: Context | undefined
let server: MockLlmServer | undefined
let previousApiKey: string | undefined

beforeEach(() => {
  previousApiKey = process.env['DEEPSEEK_API_KEY']
  process.env['DEEPSEEK_API_KEY'] = 'model-router-front-end-key'
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await server?.close()
  server = undefined
  if (previousApiKey === undefined) delete process.env['DEEPSEEK_API_KEY']
  else process.env['DEEPSEEK_API_KEY'] = previousApiKey
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** The in-memory stdio pair the JSON-RPC server is mounted over. */
interface Wire {
  readonly input: PassThrough
  readonly output: PassThrough
  readonly frames: Record<string, unknown>[]
}

/**
 * Boot the spine, the router, and the given extra rows through the real Loader.
 * @param agentLoopAgents - the agent loop's `agents` rows, as YAML lines.
 * @param wire - the JSON-RPC server's stdio, when the composition mounts it.
 * @returns the loaded root context.
 */
async function boot(agentLoopAgents: readonly string[], wire?: Wire, acpStream?: Stream): Promise<Context> {
  server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, chunkSize: 4096, successText: 'ROUTED_OK' })
  root = await mkdtemp(join(tmpdir(), 'shres-model-router-front-end-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@shres-code/shres-code-llm'",
    "- name: '@shres-code/shres-code-session'",
    "- name: '@shres-code/shres-code-system-prompt'",
    "- name: '@shres-code/shres-code-tools'",
    "- name: '@shres-code/shres-code-agent'",
    "- name: '@shres-code/shres-code-agent-loop'",
    '  config:',
    ...agentLoopAgents.length === 0 ? ['    agents: []'] : ['    agents:', ...agentLoopAgents],
    "- name: '@shres-code/shres-code-llm-deepseek'",
    '  config:',
    `    baseURL: '${server.baseURL}/v1'`,
    "- name: '@test/judgment'",
    "- name: '@shres-code/shres-code-model-router'",
    '  config:',
    '    initialMode: on',
    '    candidates:',
    `      - { id: ${SCRIPTED_CANDIDATE}, provider: ${PROVIDER}, model: ${CANDIDATE_MODEL}, description: a small change }`,
    '    routeFrom:',
    `      - { provider: ${PROVIDER}, model: ${MANUAL_MODEL}, objective: dollars }`,
    '    downgradeThreshold: 0.7',
    '    downgradeMargin: 0.5',
    '    hold: { minSteps: 3 }',
    '    routeInstructions: Pick the cheapest route that can finish this turn.',
    '    difficultyInstructions: Rate how much reasoning this turn needs.',
    ...wire === undefined ? [] : ["- name: '@test/jsonrpc'"],
    ...acpStream === undefined ? [] : ["- name: '@test/acp'", '  config:', `    provider: ${PROVIDER}`, `    model: ${MANUAL_MODEL}`],
    '',
  ].join('\n'))
  const modules = new Map<string, unknown>([
    ['@shres-code/shres-code-llm', LlmRuntime],
    ['@shres-code/shres-code-session', SessionStore],
    ['@shres-code/shres-code-system-prompt', SystemPrompt],
    ['@shres-code/shres-code-tools', ToolRuntime],
    ['@shres-code/shres-code-agent', AgentRegistry],
    ['@shres-code/shres-code-agent-loop', AgentLoop],
    ['@shres-code/shres-code-llm-deepseek', DeepSeekPlugin],
    ['@test/judgment', FakeJudgment],
    ['@shres-code/shres-code-model-router', ModelRoutingController],
    // The shipped JSON-RPC plugin, handed in-memory stdio through its own config fields.
    ['@test/jsonrpc', {
      ...JsonRpcServer,
      apply: (ctx: Context, config: JsonRpcServer.JsonRpcConfig) => {
        if (wire === undefined) throw new Error('the JSON-RPC row needs the in-memory stdio')
        JsonRpcServer.apply(ctx, { ...config, input: wire.input, output: wire.output, exit: () => undefined })
      },
    }],
    // The shipped ACP plugin, handed its in-memory transport through its runtime-only config field.
    ['@test/acp', {
      ...AcpServer,
      apply: (ctx: Context, config: AcpServer.AcpConfig) => {
        if (acpStream === undefined) throw new Error('the ACP row needs the in-memory transport')
        AcpServer.apply(ctx, { ...config, stream: acpStream })
      },
    }],
  ])
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/** Poll until a value appears, for up to ten seconds. */
async function waitFor<T>(read: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** The routing decisions one agent's session logged. */
function decisions(agent: Agent): unknown[] {
  return agent.session.events.flatMap(event => event.type === 'model-routing/decision' ? [event.data] : [])
}

/** The model the stub served for one request. */
function requestedModel(index: number): unknown {
  return (server?.requests[index]?.body as { model?: unknown } | undefined)?.model
}

describe('front ends that provide no model selection reach the router', () => {
  it('routes a JSON-RPC session created on its first prompt', { timeout: TIMEOUT_MS }, async () => {
    const wire: Wire = { input: new PassThrough(), output: new PassThrough(), frames: [] }
    let buffered = ''
    wire.output.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) if (line.trim() !== '') wire.frames.push(JSON.parse(line) as Record<string, unknown>)
    })
    const ctx = await boot([], wire)
    const send = (frame: Record<string, unknown>): void => { wire.input.write(JSON.stringify(frame) + '\n') }
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { cwd: root, provider: PROVIDER, model: MANUAL_MODEL } })
    await waitFor(() => wire.frames.find(frame => frame['id'] === 1), 'initialize response')
    send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'rpc', contentBlocks: [{ type: 'text', text: 'a small change' }] } })
    await waitFor(() => wire.frames.find(frame => frame['id'] === 2), 'prompt response')
    await waitFor(() => wire.frames.find(frame => frame['method'] === 'session.status'
      && (frame['params'] as { status?: string } | undefined)?.status === 'idle'), 'idle status')
    const agent = ctx.agents.list().find(candidate => String(candidate.id) === 'rpc')
    if (agent === undefined) throw new Error('the JSON-RPC session has no live agent')
    expect(decisions(agent)).toMatchObject([{ outcome: 'downgraded', reason: 'gate-passed' }])
    expect(requestedModel(0)).toBe(CANDIDATE_MODEL)
  })

  it('routes an ACP session created by session/new', { timeout: TIMEOUT_MS }, async () => {
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
    const ctx = await boot([], undefined, ndJsonStream(agentToClient.writable, clientToAgent.readable))
    // oxlint-disable-next-line typescript/no-deprecated -- the client the ACP package's own test harness drives
    const client = new ClientSideConnection(() => ({
      sessionUpdate: () => Promise.resolve(),
      requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
    }), ndJsonStream(clientToAgent.writable, agentToClient.readable))
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: root ?? process.cwd(), mcpServers: [] })
    const response = await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'a small change' }] })
    expect(response.stopReason).toBe('end_turn')
    const agent = ctx.agents.list().find(candidate => String(candidate.id) === sessionId)
    if (agent === undefined) throw new Error('the ACP session has no live agent')
    expect(decisions(agent)).toMatchObject([{ outcome: 'downgraded', reason: 'gate-passed' }])
    expect(requestedModel(0)).toBe(CANDIDATE_MODEL)
  })

  it('routes an agent the agent loop pre-creates from its config', { timeout: TIMEOUT_MS }, async () => {
    const ctx = await boot([`      - { id: main, provider: ${PROVIDER}, model: ${MANUAL_MODEL} }`])
    const agent = await waitFor(() => ctx.agents.roots()[0], 'the configured agent')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'a small change' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(decisions(agent)).toMatchObject([{ outcome: 'downgraded', reason: 'gate-passed' }])
    expect(requestedModel(0)).toBe(CANDIDATE_MODEL)
  })
})
