/**
 * Loader-composition doubles and boot glue shared by the package's
 * real-composition suites.
 *
 * TEST DOUBLES (all local to this package's tests, all labelled):
 * - {@link StubSystemOne}: a loopback stand-in for the vendor \`systemone\` endpoint.
 * - {@link StubModelAdapter}: the smallest real \`LlmAdapter\` that dials the stub
 *   model server over HTTP, so a summarization request is a real wire request.
 * - {@link MemoryCredentials}: the credentials provider double, copied from the
 *   judgment provider's own focused suite.
 * The `compaction-jev` row is the package's real default export, so the Loader
 * path exercises the shipping constructor (which partitions its own config
 * before the inherited resolver sees it).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@shres-code/cordis'
import Include from '@shres-code/cordis-plugin-include'
import Loader from '@shres-code/cordis-plugin-loader'
import AgentRegistry from '@shres-code/shres-code-agent'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import BasicCompactionEngine from '@shres-code/shres-code-compaction-basic'
import { CredentialProvider } from '@shres-code/shres-code-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@shres-code/shres-code-credentials'
import TypesafeJudgmentEngine from '@shres-code/shres-code-judgment-typesafe'
import LlmRuntime, { LlmAdapter, createMessage, createUserMessage } from '@shres-code/shres-code-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@shres-code/shres-code-llm'
import SessionStore from '@shres-code/shres-code-session'
import type { Session } from '@shres-code/shres-code-session'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import TokenMeter from '@shres-code/shres-code-token-meter'
import ToolRuntime from '@shres-code/shres-code-tools'
import ScriptedSnapshotJudgment from './fixtures/compaction-jev-judgment.ts'
import JevCompactionEngine from '../src/index.ts'

/** Provider route the conversation and the summarizer both run on. */
export const ROUTE = 'stub-provider'
/** Model the route names. */
export const ROUTE_MODEL = 'stub-model'
/** Context capacity the adapter advertises, which pricing reads. */
export const CONTEXT_WINDOW = 500_000
/** Threshold ratio that puts a seeded history under pressure immediately. */
export const THRESHOLD_RATIO = 0.01
/** Text the stub model server streams back. */
export const STUB_TEXT = 'stub reply'
/** Credential reference the judgment engine resolves per ask. */
export const CREDENTIAL_REF = 'TYPESAFE_API_KEY'

/** Loader specifier of the engine under test. */
export const JE_SPECIFIER = '@shres-code/shres-code-compaction-jev'
/** Loader specifier of the inherited engine. */
export const BASIC_SPECIFIER = '@shres-code/shres-code-compaction-basic'
/** Loader specifier of the credentials double. */
export const CREDENTIALS_SPECIFIER = '@shres-code/shres-code-credentials-memory'
/** Loader specifier of the judgment provider. */
export const JUDGMENT_SPECIFIER = '@shres-code/shres-code-judgment-typesafe'
/** Loader specifier of the test-only judgment fixture this package's rows mount. */
export const JUDGMENT_FIXTURE_SPECIFIER = '@shres-code/shres-code-compaction-jev-judgment-fixture'

/** TEST DOUBLE: one loopback stand-in for the vendor's \`systemone\` endpoint. */
export class StubSystemOne {
  readonly requests: Array<{
    path: string
    body: { state?: string; model?: string; questions?: Record<string, { type: string }> }
  }> = []
  private server: Server | undefined

  /** Bind a loopback port and start answering. */
  async start(): Promise<string> {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as StubSystemOne['requests'][number]['body']
        this.requests.push({ path: new URL(request.url ?? '/', 'http://localhost').pathname, body })
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          model: 'jev-latest',
          answers: answerEvery(body.questions ?? {}),
        }))
      })
    })
    this.server = server
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('the stub server has no port')
    return `http://127.0.0.1:${address.port}`
  }

  /** Stop accepting requests. */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.closeAllConnections()
      this.server?.close(() => { resolve() })
    })
    this.server = undefined
  }
}

/**
 * One answer per asked question id: a boundary hazard reads safe, a battery
 * check reads verified, and a score question reads the top of its rubric, so the
 * selection rescues the whole span and the battery accepts the draft.
 */
function answerEvery(questions: Record<string, { type: string }>): Record<string, unknown> {
  const answers: Record<string, unknown> = {}
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === 'noul') {
      answers[id] = { type: 'noul', noul: id.startsWith('boundary:') ? 0 : 0.95 }
    } else if (question.type === 'score') {
      answers[id] = { type: 'score', score: 5, probabilities: { '4': 1 }, confidence: 0.9 }
    }
  }
  return answers
}

/** TEST DOUBLE: an adapter that dials the stub model server over HTTP. */
export class StubModelAdapter extends LlmAdapter {
  /** Every call this adapter dispatched, in order. */
  readonly calls: GenerateOptions[] = []

  constructor(private readonly baseURL: string) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: CONTEXT_WINDOW },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const response = await fetch(`${this.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages.map(message => ({ role: message.role, content: message.content })),
        max_tokens: options.maxTokens,
      }),
    })
    const text = readContent(await response.text())
    const block: ContentBlock = { type: 'text', text }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Text joined from one OpenAI-compatible SSE body. */
function readContent(body: string): string {
  let text = ''
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length).trim()
    if (payload.length === 0 || payload === '[DONE]') continue
    const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } }> }
    const content = parsed.choices?.[0]?.delta?.content
    if (typeof content === 'string') text += content
  }
  return text
}

/**
 * TEST DOUBLE: in-memory credentials provider, copied from the judgment
 * provider's focused suite so a composition resolves a key without a secret.
 */
export class MemoryCredentials extends CredentialProvider {
  private readonly store = new Map<string, string>()

  constructor(ctx: Context, seed: Record<string, string> = {}) {
    super(ctx)
    for (const [key, value] of Object.entries(seed)) this.store.set(key, value)
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.store.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const configured = (this.store.get(ref) ?? '').length > 0
    return Promise.resolve({
      configured,
      ...configured ? { source: 'memory' } : {},
      writable: true,
    })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    this.store.set(ref, value)
    this.ctx.emit('credentials/updated', ref)
    return Promise.resolve()
  }

  override unset(ref: CredentialRef): Promise<void> {
    if (this.store.delete(ref)) this.ctx.emit('credentials/updated', ref)
    return Promise.resolve()
  }
}

/** A booted Loader tree and the temp root its config lives in. */
export interface LoadedTree {
  /** The loaded root context. */
  readonly ctx: Context
  /** Temp directory holding the generated cordis.yml. */
  readonly root: string
}

/**
 * Boot one test-only cordis.yml through the real Loader and its include builtin.
 * @param lines - the cordis.yml rows.
 * @returns the loaded context and its temp root.
 */
export async function loadTree(lines: readonly string[]): Promise<LoadedTree> {
  const root = await mkdtemp(join(tmpdir(), 'shres-compaction-jev-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@shres-code/shres-code-llm', LlmRuntime],
    ['@shres-code/shres-code-session', SessionStore],
    ['@shres-code/shres-code-system-prompt', SystemPrompt],
    ['@shres-code/shres-code-tools', ToolRuntime],
    [CREDENTIALS_SPECIFIER, MemoryCredentials],
    [JUDGMENT_SPECIFIER, TypesafeJudgmentEngine],
    [JUDGMENT_FIXTURE_SPECIFIER, ScriptedSnapshotJudgment],
    ['@shres-code/shres-code-agent', AgentRegistry],
    ['@shres-code/shres-code-agent-loop', AgentLoop],
    ['@shres-code/shres-code-token-meter', TokenMeter],
    [BASIC_SPECIFIER, BasicCompactionEngine],
    [JE_SPECIFIER, JevCompactionEngine],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx, root }
}

/**
 * Dispose one booted tree and remove its temp root.
 * @param tree - the tree to unload; a skipped boot is a no-op.
 */
export async function unloadTree(tree: LoadedTree | undefined): Promise<void> {
  await tree?.ctx.fiber.dispose()
  if (tree !== undefined) await rm(tree.root, { recursive: true, force: true })
}

/**
 * The rows one forced-compaction composition needs, with the test-only judgment
 * fixture in place of a remote provider: no credential, no endpoint, no network.
 * @param engineRows - the compaction rows; defaults to the Jev-backed arm.
 * @returns the cordis.yml lines.
 */
export function scriptedRows(engineRows: readonly string[] = jevRows()): string[] {
  return [
    "- name: '@shres-code/shres-code-llm'",
    "- name: '@shres-code/shres-code-session'",
    "- name: '@shres-code/shres-code-system-prompt'",
    '  config:',
    "    persona: 'You are a loader-composition test agent.'",
    "- name: '@shres-code/shres-code-tools'",
    `- name: '${JUDGMENT_FIXTURE_SPECIFIER}'`,
    "- name: '@shres-code/shres-code-agent'",
    "- name: '@shres-code/shres-code-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@shres-code/shres-code-token-meter'",
    ...engineRows,
  ]
}

/**
 * The rows one forced-compaction composition needs.
 * @param endpoint - the stub the judgment provider dials.
 * @param engineRows - the compaction rows; defaults to the Jev-backed arm.
 * @returns the cordis.yml lines.
 */
export function compositionRows(endpoint: string, engineRows: readonly string[] = jevRows()): string[] {
  return [
    "- name: '@shres-code/shres-code-llm'",
    "- name: '@shres-code/shres-code-session'",
    "- name: '@shres-code/shres-code-system-prompt'",
    '  config:',
    "    persona: 'You are a loader-composition test agent.'",
    "- name: '@shres-code/shres-code-tools'",
    "- name: '@shres-code/shres-code-credentials-memory'",
    '  config:',
    `    ${CREDENTIAL_REF}: loader-key`,
    "- name: '@shres-code/shres-code-judgment-typesafe'",
    '  config:',
    `    apiKeyRef: ${CREDENTIAL_REF}`,
    `    endpoint: '${endpoint}'`,
    "- name: '@shres-code/shres-code-agent'",
    "- name: '@shres-code/shres-code-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@shres-code/shres-code-token-meter'",
    ...engineRows,
  ]
}

/** The compaction rows for the Jev-backed arm. */
export function jevRows(): string[] {
  return [
    '- id: compaction-basic',
    `  name: '${BASIC_SPECIFIER}'`,
    '  disabled: true',
    `- name: '${JE_SPECIFIER}'`,
    '  config:',
    `    thresholdRatio: ${THRESHOLD_RATIO}`,
    '    retainTokens: 0',
    '    maxPointers: 0',
    '    maxRescues: 64',
    '    maxSegmentsPerCall: 64',
    '    segmentScoreInstructions: How much does a later turn depend on this segment?',
    '    boundaryInstructions: Does this edge cut through work that belongs together?',
    '    verifyInstructions: How well does this summary preserve what a later turn needs?',
    '    verifyChecks:',
    '      - name: constraints',
    '        instructions: Does the summary drop a stated constraint?',
  ]
}

/** The compaction rows for the plain compaction-basic twin. */
export function basicRows(): string[] {
  return [
    '- id: compaction-basic',
    `  name: '${BASIC_SPECIFIER}'`,
    '  config:',
    `    thresholdRatio: ${THRESHOLD_RATIO}`,
    '    retainTokens: 0',
    '    maxPointers: 0',
    '    compactionRetries: 0',
  ]
}

/**
 * Seed a closed history large enough to cross the tiny threshold, ending with
 * the open turn an automatic transaction needs.
 * @param session - the session to seed.
 * @param turns - how many closed turns to seed.
 */
export function seedHistory(session: Session, turns = 6): void {
  const text = 'history '.repeat(500).trim()
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: ROUTE, model: ROUTE_MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text} assistant ${turn}` }],
        source: { kind: 'model', ...{ provider: ROUTE, model: ROUTE_MODEL } },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
}
