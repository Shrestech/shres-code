/**
 * Test fixtures for the Claude subscription-session adapter: the OAuth-shaped
 * access token pi-ai detects on, a Claude Code credential document written at
 * the owner-only mode its CLI stores it with, and a loopback Anthropic Messages
 * SSE stand-in that records one request and replays one scripted stream.
 * @module tests/helpers
 */

import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'

/**
 * Encode one JWT-shaped access token. The `sk-ant-oat` prefix is the marker
 * pi-ai's Anthropic implementation detects to switch a request onto the Claude
 * Code OAuth wire, so every fixture token carries it.
 * @param seed - claim value that distinguishes one token from another.
 * @returns a JWT-shaped token string.
 */
export function accessToken(seed: string): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `sk-ant-oat01-${[encode({ alg: 'ES256', typ: 'JWT' }), encode({ sub: seed }), 'signature'].join('.')}`
}

/** A far-future instant neither the shipped refresh leeway nor a request reaches. */
function farFuture(): number {
  return Date.now() + 6 * 3600 * 1000
}

/** One `claudeAiOauth` object in the CLI's own credential-document format. */
function claudeAiOauth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accessToken: accessToken('default'),
    refreshToken: 'refresh-token-1',
    expiresAt: farFuture(),
    refreshTokenExpiresAt: farFuture(),
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    ...overrides,
  }
}

/**
 * Write a Claude Code credential document holding one OAuth session.
 * @param overrides - `claudeAiOauth` fields to replace.
 * @returns the absolute path of the written `.credentials.json`.
 */
export async function writeCredentialsDocument(overrides: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-session-'))
  const path = join(dir, '.credentials.json')
  await writeFile(path, JSON.stringify({ claudeAiOauth: claudeAiOauth(overrides) }), { mode: 0o600 })
  return path
}

/** One recorded Anthropic Messages request. */
interface RecordedMessageRequest {
  /** HTTP method the SDK sent. */
  method: string
  /** Request path including any query string. */
  path: string
  /** Request headers as Node reports them (lower-cased names). */
  headers: IncomingHttpHeaders
  /** Parsed JSON request body. */
  body: Record<string, unknown>
}

/** Loopback Anthropic Messages stand-in: records every request, replays one scripted stream. */
export interface MockAnthropic {
  /** Endpoint base URL; the SDK appends `/v1/messages`. */
  url: string
  /** Every request the stand-in received, in arrival order. */
  requests: RecordedMessageRequest[]
  /** Replace the stream every later request answers with. */
  respondStream: (stream: string) => void
  /** Answer the next request with a raw status/body rejection. */
  respondError: (status: number, body: string) => void
  /** Close the server and every open connection. */
  close: () => Promise<void>
}

/**
 * One `event:`-framed Anthropic SSE record. pi-ai routes each record by its
 * `event:` name, so a `data:`-only frame is ignored.
 * @param type - the SSE event name.
 * @param payload - the JSON object carried by the frame.
 * @returns the fully framed record.
 */
function sseEvent(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
}

/**
 * One completed assistant turn: a thinking block, a text block, a terminal
 * stop reason, and usage carrying both cache counters.
 * @param text - the assistant text.
 * @param thinking - the reasoning text of the thinking block.
 * @returns the full scripted SSE stream.
 */
function anthropicTurn(text: string, thinking = 'mulling it over'): string {
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 7,
          output_tokens: 0,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
      },
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 1 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 3 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('')
}

/**
 * Start a loopback-only Anthropic Messages stand-in.
 * @param stream - the SSE stream requests answer with until {@link MockAnthropic.respondStream} replaces it.
 * @returns the bound server and its recorded requests.
 */
export async function mockAnthropic(stream: string = anthropicTurn('hello')): Promise<MockAnthropic> {
  const requests: RecordedMessageRequest[] = []
  let scripted = stream
  let override: { status: number; body: string } | undefined
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body: text.length === 0 ? {} : JSON.parse(text) as Record<string, unknown>,
      })
      if (override !== undefined) {
        response.writeHead(override.status, { 'content-type': 'application/json' })
        response.end(override.body)
        override = undefined
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(scripted)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the Anthropic stand-in did not bind a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    respondStream: (next) => { scripted = next },
    respondError: (status, body) => { override = { status, body } },
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => { resolve() })
    }),
  }
}
