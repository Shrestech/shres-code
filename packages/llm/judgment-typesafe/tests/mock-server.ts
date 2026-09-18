import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** One scripted answer the stub server gives the next request. */
export type Behavior =
  | { kind: 'json'; status: number; body: string; contentType?: string }
  | { kind: 'malformed'; status: number; body: string }
  | { kind: 'stall' }
  | { kind: 'partial'; status: number; head: string }

/** One request the stub server received. */
export interface RecordedRequest {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: unknown
}

export interface MockServer {
  /** Base URL the engine is configured with. */
  url: string
  /** Requests received so far, in order. */
  requests: RecordedRequest[]
  /** Remaining scripted behaviors; a request beyond the script is answered with HTTP 500. */
  script: Behavior[]
  close(): Promise<void>
}

const servers: Server[] = []

/** Close every stub server opened since the last call; run from each spec's afterEach. */
export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    // A 'stall' or 'partial' behavior holds its socket open; drop it so close resolves.
    server.closeAllConnections()
    server.close(() => { resolve() })
  })))
}

/**
 * Loopback stand-in for the vendor endpoint: records every request and replays
 * one scripted behavior per request.
 */
export async function mockServer(script: Behavior[]): Promise<MockServer> {
  const requests: RecordedRequest[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push({
        method: request.method ?? '',
        path: url.pathname,
        headers: request.headers,
        body,
      })
      const behavior = script.shift()
      if (behavior === undefined) {
        response.writeHead(500, { 'content-type': 'text/plain' }).end('mock script exhausted')
        return
      }
      switch (behavior.kind) {
        case 'json':
          response.writeHead(behavior.status, { 'content-type': behavior.contentType ?? 'application/json' })
          response.end(behavior.body)
          return
        case 'malformed':
          response.writeHead(behavior.status, { 'content-type': 'text/plain' })
          response.end(behavior.body)
          return
        case 'stall':
          // Hold the request open with no response at all.
          return
        case 'partial':
          // Declare more bytes than are sent, so the body stream stays outstanding.
          response.writeHead(behavior.status, {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(behavior.head) + 64),
          })
          response.write(behavior.head)
          return
      }
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the stub server has no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    script,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => { resolve() })
    }),
  }
}
