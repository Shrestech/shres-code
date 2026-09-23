/**
 * Behavior of the shell's half of the host pipe. Requests are driven through the
 * host child's own decoder and responses through its own encoders, so this suite
 * fails whenever the two ends of the pipe disagree about a frame.
 */

import { describe, expect, it } from 'vitest'
import {
  DESKTOP_PIPE_CHUNK_BYTES,
  DesktopHostRequestDecoder,
  FRAME_MAGIC,
  encodeDesktopResponseData,
  encodeDesktopResponseEnd,
  encodeDesktopResponseError,
  encodeDesktopResponseStart,
} from '@shres-code/shres-code-desktop-host/wire'
import {
  DesktopHostResponseDecoder,
  encodeDesktopRequestCancel,
  encodeDesktopRequestData,
  encodeDesktopRequestEnd,
  encodeDesktopRequestStart,
} from '../src/host-protocol.ts'

const FRAME_HEADER_BYTES = 13

function decodeInPieces<T>(bytes: Buffer, push: (chunk: Buffer) => readonly T[]): T[] {
  const values: T[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += 7) {
    values.push(...push(bytes.subarray(offset, offset + 7)))
  }
  return values
}

/** Build a frame the host would never write, to exercise the decoder's rejections. */
function rawResponseFrame(type: number, streamId: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength)
  frame.writeUInt32BE(FRAME_MAGIC, 0)
  frame.writeUInt8(type, 4)
  frame.writeUInt32BE(streamId, 5)
  frame.writeUInt32BE(payload.byteLength, 9)
  payload.copy(frame, FRAME_HEADER_BYTES)
  return frame
}

// A rejected frame leaves the bytes it arrived in buffered, so every rejected
// case drives a fresh decoder.
function rejects(bytes: Buffer, pattern: RegExp): void {
  expect(() => new DesktopHostResponseDecoder().push(bytes)).toThrow(pattern)
}

describe('shell request frames', () => {
  it('opens, streams, ends, and cancels one request the host decoder accepts across split writes', () => {
    const decoder = new DesktopHostRequestDecoder()
    const bytes = Buffer.concat([
      encodeDesktopRequestStart(7, {
        url: 'shres-app://app/api/events.mux',
        method: 'POST',
        headers: [['content-type', 'application/json']],
        hasBody: true,
      }),
      encodeDesktopRequestData(7, Buffer.from('{"ok":true}')),
      encodeDesktopRequestEnd(7),
      encodeDesktopRequestCancel(8),
    ])

    expect(decodeInPieces(bytes, chunk => decoder.push(chunk))).toEqual([
      {
        type: 'start',
        streamId: 7,
        url: 'shres-app://app/api/events.mux',
        method: 'POST',
        headers: [['content-type', 'application/json']],
        hasBody: true,
      },
      { type: 'data', streamId: 7, data: Buffer.from('{"ok":true}') },
      { type: 'end', streamId: 7 },
      { type: 'cancel', streamId: 8 },
    ])
    expect(() => { decoder.finish() }).not.toThrow()
  })

  it('carries a body larger than one pipe chunk as bounded frames that reassemble byte for byte', () => {
    const body = Buffer.alloc((2 * DESKTOP_PIPE_CHUNK_BYTES) + 5, 9)
    const frames: Buffer[] = [encodeDesktopRequestStart(1, {
      url: 'shres-app://app/upload',
      method: 'PUT',
      headers: [],
      hasBody: true,
    })]
    for (let offset = 0; offset < body.byteLength; offset += DESKTOP_PIPE_CHUNK_BYTES) {
      frames.push(encodeDesktopRequestData(1, body.subarray(offset, offset + DESKTOP_PIPE_CHUNK_BYTES)))
    }
    frames.push(encodeDesktopRequestEnd(1))

    const dataFrames = frames.slice(1, -1)
    expect(dataFrames).toHaveLength(3)
    for (const frame of dataFrames) {
      expect(frame.byteLength).toBeLessThanOrEqual(FRAME_HEADER_BYTES + DESKTOP_PIPE_CHUNK_BYTES)
    }

    const decoder = new DesktopHostRequestDecoder()
    const reassembled = decoder.push(Buffer.concat(frames))
      .flatMap(chunk => chunk.type === 'data' ? [chunk.data] : [])
    expect(Buffer.concat(reassembled)).toEqual(body)
  })

  it('refuses a body chunk above the pipe chunk size and an unusable stream id', () => {
    expect(() => encodeDesktopRequestData(1, Buffer.alloc(DESKTOP_PIPE_CHUNK_BYTES + 1)))
      .toThrow(/request pipe frame exceeds the 65536-byte limit/u)
    expect(() => encodeDesktopRequestEnd(0)).toThrow(/invalid pipe stream id 0/u)
  })
})

describe('shell response decoding', () => {
  it('decodes host start, data, end, and error frames written across split writes', () => {
    const decoder = new DesktopHostResponseDecoder()
    const bytes = Buffer.concat([
      encodeDesktopResponseStart(9, {
        status: 201,
        headers: [['content-type', 'application/octet-stream']],
        hasBody: true,
      }),
      encodeDesktopResponseData(9, Buffer.from([0, 1, 2, 255])),
      encodeDesktopResponseEnd(9),
      encodeDesktopResponseError(10, 'plugin unavailable'),
    ])

    expect(decodeInPieces(bytes, chunk => decoder.push(chunk))).toEqual([
      {
        type: 'start',
        streamId: 9,
        status: 201,
        headers: [['content-type', 'application/octet-stream']],
        hasBody: true,
      },
      { type: 'data', streamId: 9, data: Buffer.from([0, 1, 2, 255]) },
      { type: 'end', streamId: 9 },
      { type: 'error', streamId: 10, message: 'plugin unavailable' },
    ])
    expect(() => { decoder.finish() }).not.toThrow()
  })

  it('holds a partial frame until the rest of it arrives', () => {
    const decoder = new DesktopHostResponseDecoder()
    const start = encodeDesktopResponseStart(1, { status: 200, headers: [], hasBody: true })
    expect(decoder.push(start.subarray(0, 5))).toEqual([])
    expect(decoder.push(start.subarray(5))).toEqual([{ type: 'start', streamId: 1, status: 200, headers: [], hasBody: true }])
  })

  it('rejects frames the host cannot have written', () => {
    rejects(Buffer.alloc(13), /invalid host response frame marker/u)
    rejects(rawResponseFrame(9, 1), /unknown host response frame type 9/u)
    rejects(rawResponseFrame(2, 0, Buffer.alloc(0)), /invalid pipe stream id 0/u)
    rejects(rawResponseFrame(3, 1, Buffer.from('x')), /end frame carried a payload/u)
    rejects(rawResponseFrame(2, 1, Buffer.alloc(DESKTOP_PIPE_CHUNK_BYTES + 1)), /exceeds the 65536-byte limit/u)
  })

  it('rejects start and error payloads that are not the documented JSON objects', () => {
    rejects(rawResponseFrame(1, 1, Buffer.from('{}')), /invalid host response start payload/u)
    rejects(rawResponseFrame(1, 1, Buffer.from('not json')), /start payload is not JSON/u)
    rejects(rawResponseFrame(1, 1, Buffer.from('{"status":99,"headers":[],"hasBody":true}')), /invalid host response start payload/u)
    rejects(rawResponseFrame(4, 1, Buffer.from('{"other":1}')), /invalid host response error payload/u)
  })

  it('rejects an end of pipe that splits a frame', () => {
    const decoder = new DesktopHostResponseDecoder()
    decoder.push(encodeDesktopResponseEnd(1).subarray(0, 5))
    expect(() => { decoder.finish() }).toThrow(/host response pipe ended inside a frame/u)
  })
})
