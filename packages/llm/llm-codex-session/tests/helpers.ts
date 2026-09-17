/**
 * Test fixtures: Codex session documents whose tokens encode their own
 * expiry, and a local stand-in for the ChatGPT backend that speaks the
 * `openai-responses` event stream.
 * @module tests/helpers
 */

import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Encode one JWT-shaped token whose `exp` claim carries the given instant. */
export function tokenWithExp(expiresAtMs: number): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return [encode({ alg: 'RS256', typ: 'JWT' }), encode({ exp: Math.floor(expiresAtMs / 1000) }), 'signature'].join('.')
}

/** The document's `tokens` object verbatim, with a far-future or stale access token. */
export function tokensRaw(expiresAtMs: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id_token: tokenWithExp(expiresAtMs + 86_400_000),
    access_token: tokenWithExp(expiresAtMs),
    refresh_token: 'refresh-token-1',
    account_id: 'account-1',
    ...overrides,
  }
}

/** The document root verbatim around one `tokens` object. */
export function documentRaw(tokens: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    last_refresh: new Date(Date.now() - 3_600_000).toISOString(),
    tokens,
    ...overrides,
  }
}

/** Write an auth document holding the given tokens; returns its path. */
export async function writeAuthDocument(tokens: Record<string, unknown>, root: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-session-'))
  const path = join(dir, 'auth.json')
  await writeFile(path, JSON.stringify(documentRaw(tokens, root)), { mode: 0o600 })
  return path
}

/** Write an auth document that is the given root verbatim (no `tokens` member unless the caller adds one). */
export async function writeRootDocument(root: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-session-'))
  const path = join(dir, 'auth.json')
  await writeFile(path, JSON.stringify(root), { mode: 0o600 })
  return path
}

/** A far-future instant the default leeway cannot reach. */
export function farFuture(): number {
  return Date.now() + 10 * 24 * 3600 * 1000
}

/** An instant inside the default refresh leeway. */
export function nearlyExpired(): number {
  return Date.now() + 60 * 1000
}

/** A payload the refresh grant returns. */
export function grantPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const expiresAtMs = farFuture()
  return {
    access_token: tokenWithExp(expiresAtMs),
    refresh_token: 'refresh-token-2',
    id_token: tokenWithExp(expiresAtMs + 86_400_000),
    ...overrides,
  }
}

export interface MockUpstream {
  url: string
  paths: string[]
  authHeaders: string[]
  accountHeaders: string[]
  bodies: unknown[]
  /** Replace the next scripted response with a raw status/body rejection. */
  respond: (status: number, body: string) => void
  /** Replace the next scripted response with a raw SSE stream. */
  respondStream: (sse: string[]) => void
  close: () => Promise<void>
}

/** Local backend stand-in: records requests, replays one responses stream. */
export async function mockUpstream(events: string[]): Promise<MockUpstream> {
  const paths: string[] = []
  const authHeaders: string[] = []
  const accountHeaders: string[] = []
  const bodies: unknown[] = []
  let override: { status: number; body?: string; sse?: string[] } | undefined
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      paths.push(request.url ?? '')
      authHeaders.push(request.headers.authorization ?? '')
      const account = request.headers['chatgpt-account-id']
      accountHeaders.push(Array.isArray(account) ? account[0] ?? '' : account ?? '')
      bodies.push(body.length === 0 ? undefined : JSON.parse(body))
      const scripted: { status: number; body?: string; sse?: string[] } = override ?? { status: 200, sse: events }
      override = undefined
      if (scripted.status !== 200) {
        response.writeHead(scripted.status, { 'content-type': 'application/json' })
        response.end(scripted.body ?? '{}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const lines = scripted.sse ?? []
      let index = 0
      const writeNext = (): void => {
        const event = lines[index++]
        if (event === undefined) {
          response.end()
          return
        }
        response.write(`data: ${event}\n\n`)
        writeNext()
      }
      writeNext()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    paths,
    authHeaders,
    accountHeaders,
    bodies,
    respond: (status, bodyText) => { override = { status, body: bodyText } },
    respondStream: (sse) => { override = { status: 200, sse } },
    close: () => new Promise(resolve => server.close(() => { resolve() })),
  }
}

/** One assistant text turn in the backend's responses stream, with usage. */
export function textTurn(
  text: string,
  usage: { input?: number; cached?: number; output?: number } = {},
): string[] {
  const input = usage.input ?? 3
  const cached = usage.cached ?? 0
  const output = usage.output ?? 1
  return [
    JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }),
    JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant' } }),
    JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text }),
    JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_1',
        usage: {
          input_tokens: input,
          input_tokens_details: { cached_tokens: cached },
          output_tokens: output,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: input + output,
        },
      },
    }),
  ]
}
