/**
 * The shell transport seam: page-global discovery, fetch routing for unary
 * calls, fetch-stream downlinks replacing WebSockets when a transport owns the
 * page, and ownsHost loopback authority.
 */

import { describe, expect, it, vi } from 'vitest'
import { readClientTransport, type ClientTransportHooks } from '../src/client/transport.ts'
import { createWebConnectionRpc } from '../src/client/rpc.ts'
import { WebApiClient } from '../src/client/web-api-client.ts'
import { apply, type ConnectionHandle } from '../src/client/index.ts'
import type { MuxFrame, RpcMessage, RpcRequest } from '../src/client/api.ts'

/** Expose protected members for transport-routing assertions. */
class ProbeClient extends WebApiClient {
  readonly envelopes: RpcMessage[] = []
  probe(input: URL, init?: RequestInit): Promise<Response> {
    return this.doFetch(input, init)
  }
  mux(signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.openMux({}, signal, onOpen)
  }
  protected override onEnvelope(message: RpcMessage): void {
    this.envelopes.push(message)
  }
}

describe('readClientTransport', () => {
  it('returns undefined without the page global and the hooks object when present', () => {
    vi.stubGlobal('__SHRES_TRANSPORT__', undefined)
    expect(readClientTransport()).toBeUndefined()
    const hooks: ClientTransportHooks = { ownsHost: true }
    vi.stubGlobal('__SHRES_TRANSPORT__', hooks)
    expect(readClientTransport()).toBe(hooks)
    vi.unstubAllGlobals()
  })
})

describe('createWebConnectionRpc', () => {
  it('routes generic RPC calls through the provided carrier and validates the echo', async () => {
    const seen: string[] = []
    const rpc = createWebConnectionRpc(async (input: URL | RequestInfo, init?: RequestInit) => {
      seen.push(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url)
      const raw = init?.body
      const sent = JSON.parse(typeof raw === 'string' ? raw : '') as { rpcId: string }
      return new Response(JSON.stringify({ type: 'server-response', rpcId: sent.rpcId, result: { ok: true, value: 7 } }), { status: 200 })
    })
    await expect(rpc.call('/channel', 'endpoint', { a: 1 })).resolves.toEqual({ ok: true, value: 7 })
    expect(seen).toEqual([expect.stringContaining('/channel/endpoint')])
  })
})

describe('WebApiClient transport routing', () => {
  it('routes unary doFetch through the carrier', async () => {
    const seen: string[] = []
    const client = new ProbeClient({ fetch: async (input: URL | RequestInfo) => {
      seen.push(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url)
      return new Response('{}')
    } })
    await client.probe(new URL('http://shres.internal/x'))
    expect(seen).toEqual(['http://shres.internal/x'])
  })

  it('reads the mux downlink as newline-delimited frames, dropping malformed lines', async () => {
    const opened: boolean[] = []
    const frame = { type: 'session/subscribed', sessionId: 's1', lastSeq: 0 } as unknown as MuxFrame
    const line = (rpcId: string, payload: unknown): string => JSON.stringify({ type: 'server-request', rpcId, method: 'events.mux', payload })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode(`${line('r1', frame)}\nnot-json\n`))
        controller.close()
      },
    })
    const client = new ProbeClient({ fetch: async () => new Response(body, { status: 200 }) })
    const yielded: RpcRequest<MuxFrame>[] = []
    for await (const envelope of client.mux(new AbortController().signal, () => { opened.push(true) })) {
      yielded.push(envelope)
    }
    expect(yielded).toEqual([{ rpcId: 'r1', payload: frame }])
    expect(opened).toEqual([true])
    expect(client.envelopes).toHaveLength(1)
  })

  it('constructs without hooks on the default global fetch path', () => {
    expect(() => new WebApiClient()).not.toThrow()
  })
})

describe('apply transport wiring', () => {
  const boot = (): ConnectionHandle => {
    let handle: ConnectionHandle | undefined
    const ctx = { provide: (_name: string, value: ConnectionHandle) => { handle = value } } as never
    apply(ctx)
    return handle as ConnectionHandle
  }

  it('ownsHost grants loopback authority on a non-loopback page', () => {
    vi.stubGlobal('location', { hostname: 'shell.example.com', search: '' })
    vi.stubGlobal('__SHRES_TRANSPORT__', { ownsHost: true })
    expect(boot().isLoopback).toBe(true)
    vi.unstubAllGlobals()
  })

  it('a non-loopback page without a transport stays non-loopback', () => {
    vi.stubGlobal('location', { hostname: 'shell.example.com', search: '' })
    vi.stubGlobal('__SHRES_TRANSPORT__', undefined)
    expect(boot().isLoopback).toBe(false)
    vi.unstubAllGlobals()
  })
})
