/** In-memory ACP transport fixture over the real agent factory and loop. */

import { Context } from '@shres-code/cordis'
import {
  client as acpClient,
  ndJsonStream,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type ClientContext,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk'
import { type GenerateOptions, LlmAdapter, type StreamChunk } from '@shres-code/shres-code-llm'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import { mountAgentLoopTestDependencies } from '@shres-code/shres-code-agent-loop-testkit'
import * as AcpPlugin from '../src/index.ts'
import type { AcpConfig } from '../src/index.ts'

/** Scripted adapter for protocol tests. */
class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: (StreamChunk[] | 'hang')[]) {
    super()
  }

  override providerInfo(provider: string) {
    if (provider !== 'mock') throw new Error(`MockAdapter: unknown provider ${provider}`)
    return { id: 'mock', name: 'Mock' }
  }

  override listModels(provider: string) {
    return Promise.resolve(provider === 'mock' ? [{ provider: 'mock', id: 'mock', name: 'Mock' }] : [])
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('MockAdapter: script exhausted')
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

/** Scripted text response ending in a clean stop. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Scripted response ending at the output-token ceiling. */
export function maxTokensResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

/** Scripted response that fails after publishing an uncommitted partial chunk. */
export function errorResponse(message: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'finish', reason: { kind: 'error', failure: { message, code: 'PROVIDER_ERROR' } } },
  ]
}

export type CapturedUpdate = SessionNotification['update']

/** The agent-side ACP methods the bridge tests call, sent over the harness connection. */
interface AcpTestClient {
  initialize(params: InitializeRequest): Promise<InitializeResponse>
  authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse>
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>
  prompt(params: PromptRequest): Promise<PromptResponse>
  cancel(params: CancelNotification): Promise<void>
}

export interface BridgeHarness {
  ctx: Context
  client: AcpTestClient
  adapter: MockAdapter
  updates: CapturedUpdate[]
  sessionUpdates: { sessionId: string; update: CapturedUpdate }[]
  permissionRequests: RequestPermissionRequest[]
  onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse
  onSessionUpdateError: (() => void) | undefined
  closeClientTransport: () => Promise<void>
  abortClientTransport: () => Promise<void>
  acpFiber: Awaited<ReturnType<Context['plugin']>>
  /** The AgentLoop fiber, so a test can reload the loop out from under the bridge. */
  loopFiber: Awaited<ReturnType<Context['plugin']>>
  dispose: () => Promise<void>
}

type AcpConfigOverrides = { [K in keyof AcpConfig]?: AcpConfig[K] | undefined }

/** Build the bridge and a connected SDK client over cross-wired byte streams. */
export async function makeBridgeHarness(options: {
  script?: (StreamChunk[] | 'hang')[]
  config?: AcpConfigOverrides
  persona?: string
} = {}): Promise<BridgeHarness> {
  const adapter = new MockAdapter(options.script ?? [])
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: options.persona ?? '' } })
  const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)

  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgentWriter = clientToAgent.writable.getWriter()
  const clientOutput = new WritableStream<Uint8Array>({
    write: chunk => clientToAgentWriter.write(chunk),
  })
  const agentStream: Stream = ndJsonStream(agentToClient.writable, clientToAgent.readable)
  const clientStream: Stream = ndJsonStream(clientOutput, agentToClient.readable)

  const updates: CapturedUpdate[] = []
  const sessionUpdates: { sessionId: string; update: CapturedUpdate }[] = []
  const permissionRequests: RequestPermissionRequest[] = []
  const harness: BridgeHarness = {
    ctx,
    adapter,
    updates,
    sessionUpdates,
    permissionRequests,
    onPermission: () => ({ outcome: { outcome: 'cancelled' } }),
    onSessionUpdateError: undefined,
    client: undefined as unknown as AcpTestClient,
    acpFiber: undefined as unknown as BridgeHarness['acpFiber'],
    loopFiber,
    closeClientTransport: async () => { await clientToAgentWriter.close() },
    abortClientTransport: async () => { await clientToAgentWriter.abort(new Error('client transport failed')) },
    dispose: async () => {
      release()
      await ctx.fiber.dispose()
    },
  }

  const app = acpClient({ name: 'acp-bridge-harness' })
    .onNotification('session/update', ({ params }) => {
      updates.push(params.update)
      sessionUpdates.push({ sessionId: params.sessionId, update: params.update })
      if (harness.onSessionUpdateError !== undefined) throw new Error('client update rejected')
    })
    .onRequest('session/request_permission', ({ params }) => {
      permissionRequests.push(params)
      return harness.onPermission(params)
    })

  const config = { stream: agentStream, ...options.config } as AcpConfig
  if (!(options.config && 'provider' in options.config)) config.provider = 'mock'
  if (!(options.config && 'model' in options.config)) config.model = 'mock'
  harness.acpFiber = await ctx.plugin({
    name: 'acp-test',
    inject: [...AcpPlugin.inject],
    apply: (inner: Context) => { AcpPlugin.apply(inner, config) },
  })
  // The connection lives until the harness is disposed or the transport
  // closes; a closed transport rejects the pending requests on its own.
  const connected = Promise.withResolvers<ClientContext>()
  const lifetime = Promise.withResolvers<undefined>()
  const release = (): void => { lifetime.resolve(undefined) }
  app.connectWith(clientStream, async (agent) => {
    connected.resolve(agent)
    await lifetime.promise
  }).catch((error: unknown) => {
    // A connection closed by a test's transport close or abort ends here;
    // requests still pending were rejected with the same reason.
    connected.reject(error)
  })
  const agent = await connected.promise
  harness.client = {
    initialize: params => agent.request('initialize', params),
    authenticate: params => agent.request('authenticate', params),
    newSession: params => agent.request('session/new', params),
    prompt: params => agent.request('session/prompt', params),
    cancel: params => agent.notify('session/cancel', params),
  }
  return harness
}
