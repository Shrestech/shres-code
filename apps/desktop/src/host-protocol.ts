/**
 * Shell-side wire framing: the request encoder and response decoder for the
 * desktop host's byte pipes. Byte layout mirrors `apps/desktop-host/src/wire.ts`
 * (big-endian u32 magic, u8 type, u32 stream id, u32 payload length); both
 * sides ship together, so the constants come from the host package.
 * @module @shres-code/shres-code-desktop/host-protocol
 */

import { DESKTOP_PIPE_CHUNK_BYTES, FRAME_MAGIC } from '@shres-code/shres-code-desktop-host'

const REQUEST_FRAME_START = 1
const REQUEST_FRAME_DATA = 2
const REQUEST_FRAME_END = 3
const REQUEST_FRAME_CANCEL = 4

const RESPONSE_FRAME_START = 1
const RESPONSE_FRAME_DATA = 2
const RESPONSE_FRAME_END = 3
const RESPONSE_FRAME_ERROR = 4
const HEADER_BYTES = 13

/** One forwarded request's metadata, as the host's decoder reads it. */
export interface ShellRequestStart {
  readonly url: string
  readonly method: string
  readonly headers: readonly [string, string][]
  readonly hasBody: boolean
}

/** One decoded host response frame. */
export type ShellResponseFrame = {
  readonly type: 'start'
  readonly streamId: number
  readonly status: number
  readonly headers: readonly [string, string][]
  readonly hasBody: boolean
} | {
  readonly type: 'data'
  readonly streamId: number
  readonly data: Uint8Array
} | {
  readonly type: 'end' | 'error'
  readonly streamId: number
  readonly message?: string
}

function frame(type: number, streamId: number, payload: Buffer): Buffer {
  const bytes = Buffer.allocUnsafe(HEADER_BYTES + payload.byteLength)
  bytes.writeUInt32BE(FRAME_MAGIC, 0)
  bytes.writeUInt8(type, 4)
  bytes.writeUInt32BE(streamId, 5)
  bytes.writeUInt32BE(payload.byteLength, 9)
  payload.copy(bytes, HEADER_BYTES)
  return bytes
}

/** Encode one request start frame. */
export function encodeRequestStart(streamId: number, request: ShellRequestStart): Buffer {
  return frame(REQUEST_FRAME_START, streamId, Buffer.from(JSON.stringify(request), 'utf8'))
}

/** Encode one bounded request body chunk. */
export function encodeRequestData(streamId: number, chunk: Uint8Array): Buffer {
  return frame(REQUEST_FRAME_DATA, streamId, Buffer.from(chunk))
}

/** Encode request body completion. */
export function encodeRequestEnd(streamId: number): Buffer {
  return frame(REQUEST_FRAME_END, streamId, Buffer.alloc(0))
}

/** Encode request cancellation. */
export function encodeRequestCancel(streamId: number): Buffer {
  return frame(REQUEST_FRAME_CANCEL, streamId, Buffer.alloc(0))
}

/**
 * Incrementally decode validated host response frames from the response pipe.
 */
export class ShellResponseDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  /**
   * Append bytes and return every complete response frame.
   * @param chunk - next bytes read from the host response pipe.
   * @returns complete frames in pipe order.
   */
  push(chunk: Buffer): ShellResponseFrame[] {
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames: ShellResponseFrame[] = []
    for (;;) {
      const next = this.decode()
      if (next === undefined) return frames
      frames.push(next)
    }
  }

  private decode(): ShellResponseFrame | undefined {
    if (this.buffer.byteLength < HEADER_BYTES) return undefined
    if (this.buffer.readUInt32BE(0) !== FRAME_MAGIC) throw new Error('shres desktop: invalid host response frame marker')
    const type = this.buffer.readUInt8(4)
    const streamId = this.buffer.readUInt32BE(5)
    const length = this.buffer.readUInt32BE(9)
    const limit = type === RESPONSE_FRAME_DATA ? DESKTOP_PIPE_CHUNK_BYTES : Number.MAX_SAFE_INTEGER
    if (length > limit) throw new Error('shres desktop: host response frame exceeds its limit')
    const total = HEADER_BYTES + length
    if (this.buffer.byteLength < total) return undefined
    const payload = this.buffer.subarray(HEADER_BYTES, total)
    this.buffer = this.buffer.subarray(total)
    if (type === RESPONSE_FRAME_DATA) return { type: 'data', streamId, data: payload }
    if (type === RESPONSE_FRAME_END) return { type: 'end', streamId }
    const value = JSON.parse(payload.toString('utf8')) as Record<string, unknown>
    if (type === RESPONSE_FRAME_ERROR) return { type: 'error', streamId, message: typeof value.message === 'string' ? value.message : undefined }
    if (typeof value.status === 'number' && Array.isArray(value.headers) && typeof value.hasBody === 'boolean') {
      return {
        type: 'start',
        streamId,
        status: value.status,
        headers: value.headers as readonly [string, string][],
        hasBody: value.hasBody,
      }
    }
    throw new Error('shres desktop: invalid host response start payload')
  }
}
