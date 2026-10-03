/** Browser API carrier: HTTP upstream plus one WebSocket per downstream event stream. */

import type { ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest } from './api.ts'
import { AbstractApiClient } from './api.ts'
import { hostFrameSchema, muxFrameSchema } from '@shres-code/shres-code-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@shres-code/shres-code-host-apiproxy/api/rpc.schema'
import { HOST_EVENTS_PATH, MUX_EVENTS_PATH } from '../api-path.ts'
import type { ClientTransportHooks, TransportFetch } from './transport.ts'

type SocketItem<F> = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }
type Parser<F> = { parse(value: unknown): F }

/** Lines applied from one read before the renderer is allowed to paint. */
const STREAM_LINES_PER_TURN = 32

/**
 * Browser platform subclass: unary/respond use fetch; mux/host use downlink-only
 * WebSockets. A shell transport routes every fetch through its carrier and, when
 * present at all, replaces the WebSocket downlinks with newline-delimited
 * streaming response bodies on the same paths.
 */
export class WebApiClient extends AbstractApiClient {
  private readonly fetchCarrier: TransportFetch
  private readonly streamCarrier: TransportFetch | undefined

  constructor(hooks: ClientTransportHooks = {}, timeoutMs?: number) {
    super(timeoutMs)
    this.fetchCarrier = hooks.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.streamCarrier = hooks.fetch
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return this.fetchCarrier(input, init)
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.streamCarrier !== undefined
      ? this.readFetchStream(this.streamCarrier, MUX_EVENTS_PATH, signal, muxFrameSchema, onOpen)
      : this.readWebSocket(MUX_EVENTS_PATH, signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.streamCarrier !== undefined
      ? this.readFetchStream(this.streamCarrier, HOST_EVENTS_PATH, signal, hostFrameSchema, onOpen)
      : this.readWebSocket(HOST_EVENTS_PATH, signal, hostFrameSchema, onOpen)
  }

  /**
   * Read one downlink as a newline-delimited streaming response body: each line
   * is a `ServerRequest` envelope carrying one frame. Body end is stream loss,
   * exactly like a WebSocket close.
   */
  private async *readFetchStream<F extends MuxFrame | HostFrame>(
    carrier: TransportFetch,
    path: string,
    signal: AbortSignal,
    frameSchema: Parser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const response = await carrier(new URL(path, this.resolveBase()), {
      method: 'POST',
      headers: { accept: 'application/x-ndjson' },
      ...signal.aborted ? {} : { signal },
    })
    if (!response.ok || response.body === null) {
      throw new Error(`transport failure for event stream ${path}: HTTP ${response.status}`)
    }
    onOpen?.()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const abort = (): void => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let start = 0
        let applied = 0
        let newline = buffer.indexOf('\n', start)
        while (newline >= 0) {
          const line = buffer.slice(start, newline)
          start = newline + 1
          newline = buffer.indexOf('\n', start)
          if (line === '') continue
          let full: ServerRequest
          let frame: F
          try {
            full = serverRequestSchema.parse(JSON.parse(line))
            frame = frameSchema.parse(full.payload)
          } catch (error) {
            console.error(`[client-connection] dropping malformed stream frame on ${path}:`, error)
            continue
          }
          this.onEnvelope(full)
          yield { rpcId: full.rpcId, payload: frame }
          applied += 1
          if (applied >= STREAM_LINES_PER_TURN) {
            applied = 0
            await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
          }
        }
        buffer = start === 0 ? buffer : buffer.slice(start)
      }
    } finally {
      signal.removeEventListener('abort', abort)
      abort()
    }
  }

  private async *readWebSocket<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    frameSchema: Parser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const url = new URL(path, this.resolveBase())
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    const inbox: SocketItem<F>[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: SocketItem<F>): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const handleOpen = (): void => { onOpen?.() }
    const handleMessage = (event: MessageEvent): void => {
      let full: ServerRequest
      let frame: F
      try {
        if (typeof event.data !== 'string') throw new Error('binary WebSocket frame')
        full = serverRequestSchema.parse(JSON.parse(event.data))
        frame = frameSchema.parse(full.payload)
      } catch (error) {
        console.error(`[client-connection] dropping malformed WebSocket frame on ${path}:`, error)
        return
      }
      this.onEnvelope(full)
      enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
    }
    const handleClose = (): void => { enqueue({ kind: 'end' }) }
    const handleAbort = (): void => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
    }
    socket.addEventListener('open', handleOpen)
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('close', handleClose, { once: true })
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as SocketItem<F>
          if (item.kind === 'end') return
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      socket.removeEventListener('open', handleOpen)
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('close', handleClose)
      handleAbort()
    }
  }
}
