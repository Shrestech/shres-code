/**
 * Test fixtures: Grok session documents whose tokens encode their own expiry,
 * and a local stand-in for the subscription proxy that speaks the
 * `openai-responses` event stream.
 * @module tests/helpers
 */

import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const ENTRY_KEY = 'https://auth.x.ai::test-client-id'

/** Encode one JWT-shaped token whose `exp` claim carries the given instant. */
export function tokenWithExp(expiresAtMs: number): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return [encode({ alg: 'ES256', typ: 'at+jwt' }), encode({ exp: Math.floor(expiresAtMs / 1000) }), 'signature'].join('.')
}

/** One auth-document entry verbatim, with a far-future or stale token. */
export function entryRaw(expiresAtMs: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: tokenWithExp(expiresAtMs),
    auth_mode: 'oidc',
    email: 'user@example.com',
    user_id: 'user-1',
    principal_type: 'User',
    principal_id: 'user-1',
    team_id: 'team-1',
    refresh_token: 'refresh-token-1',
    expires_at: new Date(expiresAtMs).toISOString(),
    oidc_issuer: 'https://auth.x.ai',
    oidc_client_id: 'test-client-id',
    ...overrides,
  }
}

/** Write an auth document holding the given entries; returns its path. */
export async function writeAuthDocument(entries: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'grok-session-'))
  const path = join(dir, 'auth.json')
  await writeFile(path, JSON.stringify(entries), { mode: 0o600 })
  return path
}

/** A far-future instant the default leeway cannot reach. */
export function farFuture(): number {
  return Date.now() + 6 * 3600 * 1000
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
    expires_in: 21_600,
    ...overrides,
  }
}

export interface MockUpstream {
  url: string
  paths: string[]
  authHeaders: string[]
  bodies: unknown[]
  /** Replace the next scripted response with a raw status/body rejection. */
  respond: (status: number, body: string) => void
  close: () => Promise<void>
}

/** Local proxy stand-in: records requests, replays one responses stream. */
export async function mockUpstream(events: string[]): Promise<MockUpstream> {
  const paths: string[] = []
  const authHeaders: string[] = []
  const bodies: unknown[] = []
  let override: { status: number; body?: string; sse?: string[] } | undefined
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      paths.push(request.url ?? '')
      authHeaders.push(request.headers.authorization ?? '')
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
    bodies,
    respond: (status, bodyText) => { override = { status, body: bodyText } },
    close: () => new Promise(resolve => server.close(() => { resolve() })),
  }
}

/** One assistant text turn in the proxy's responses stream, with usage. */
export function textTurn(text: string): string[] {
  return [
    JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }),
    JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant' } }),
    JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text }),
    JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_1',
        usage: {
          input_tokens: 3,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 4,
        },
      },
    }),
  ]
}
