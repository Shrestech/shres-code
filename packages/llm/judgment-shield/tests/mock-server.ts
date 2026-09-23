import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** One local gateway response used by a deterministic provider test. */
export type MockResponse =
  | { kind: 'json'; status?: number; body: unknown; headers?: Record<string, string> }
  | { kind: 'text'; status?: number; body: string; headers?: Record<string, string> }
  | { kind: 'stall' }

/** One request received by the local gateway stand-in. */
export interface RecordedRequest {
  method: string
  path: string
  body: unknown
}

/** Loopback server handle used by engine and Loader tests. */
export interface MockServer {
  url: string
  requests: RecordedRequest[]
  close(): Promise<void>
}

/** Two local servers used to prove the provider refuses redirects. */
export interface RedirectServers {
  redirect: MockServer
  targetRequests(): number
}

const servers: Server[] = []

/** Close all local servers opened by the current test file. */
export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => { resolve() })
  })))
}

/**
 * Start a scripted loopback gateway.
 * @param script - responses consumed in request order.
 * @returns recorded requests and a close operation.
 */
export async function mockServer(script: MockResponse[]): Promise<MockServer> {
  const requests: RecordedRequest[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Uint8Array) => { chunks.push(Buffer.from(chunk)) })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      requests.push({
        method: request.method ?? '',
        path: new URL(request.url ?? '/', 'http://localhost').pathname,
        body: raw.length === 0 ? undefined : JSON.parse(raw),
      })
      const behavior = script.shift() ?? { kind: 'text', status: 500, body: 'mock script exhausted' } as const
      if (behavior.kind === 'stall') return
      const status = behavior.status ?? 200
      const body = behavior.kind === 'json' ? JSON.stringify(behavior.body) : behavior.body
      const headers = 'headers' in behavior ? behavior.headers : undefined
      response.writeHead(status, {
        'content-type': behavior.kind === 'json' ? 'application/json' : 'text/plain',
        ...headers,
      })
      response.end(body)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the mock server has no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => { resolve() })
    }),
  }
}

/**
 * Start a redirecting loopback gateway and a second loopback target.
 * @returns redirect handle and the target request count.
 */
export async function redirectServer(): Promise<RedirectServers> {
  let targetRequests = 0
  const target = createServer((_request, response) => {
    targetRequests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{}')
  })
  servers.push(target)
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve))
  const targetAddress = target.address()
  if (targetAddress === null || typeof targetAddress === 'string') throw new Error('the target has no port')
  const targetUrl = `http://127.0.0.1:${targetAddress.port}/v1/judgments`
  const redirect = createServer((_request, response) => {
    response.writeHead(307, { location: targetUrl })
    response.end()
  })
  servers.push(redirect)
  await new Promise<void>(resolve => redirect.listen(0, '127.0.0.1', resolve))
  const redirectAddress = redirect.address()
  if (redirectAddress === null || typeof redirectAddress === 'string') throw new Error('the redirect has no port')
  return {
    redirect: {
      url: `http://127.0.0.1:${redirectAddress.port}`,
      requests: [],
      close: () => new Promise<void>((resolve) => {
        redirect.closeAllConnections()
        redirect.close(() => { resolve() })
      }),
    },
    targetRequests: () => targetRequests,
  }
}
