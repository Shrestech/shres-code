/**
 * Framed byte-pipe codec of the desktop host: request decoding, response
 * encoding, the frame bounds, and the EOF contract.
 */

import { describe, expect, it } from 'vitest'
import {
  DESKTOP_HOST_PROTOCOL_VERSION,
  DESKTOP_PIPE_CHUNK_BYTES,
  encodeDesktopResponseData,
  encodeDesktopResponseEnd,
  encodeDesktopResponseError,
  encodeDesktopResponseStart,
  DesktopHostRequestDecoder,
} from '../src/wire.ts'

const FRAME_MAGIC = 0x53485233
const HEADER_BYTES = 13

function requestFrame(type: number, streamId: number, payload: Buffer): Buffer {
  const frame = Buffer.alloc(HEADER_BYTES + payload.byteLength)
  frame.writeUInt32BE(FRAME_MAGIC, 0)
  frame.writeUInt8(type, 4)
  frame.writeUInt32BE(streamId, 5)
  frame.writeUInt32BE(payload.byteLength, 9)
  payload.copy(frame, HEADER_BYTES)
  return frame
}

function startPayload(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

const START = {
  url: 'shres-app://app/index.html',
  method: 'POST',
  headers: [['content-type', 'application/json']],
  hasBody: true,
}

describe('DesktopHostRequestDecoder', () => {
  it('decodes start, data, and end frames reassembled from split chunks', () => {
    const decoder = new DesktopHostRequestDecoder()
    const bytes = Buffer.concat([
      requestFrame(1, 1, startPayload(START)),
      requestFrame(2, 1, Buffer.from('hello ')),
      requestFrame(2, 1, Buffer.from('world')),
      requestFrame(3, 1, Buffer.alloc(0)),
    ])
    // Every split point must yield the same frame sequence.
    for (const split of [1, HEADER_BYTES - 1, HEADER_BYTES, bytes.byteLength - 1]) {
      const frames = [
        ...decoder.push(bytes.subarray(0, split)),
        ...decoder.push(bytes.subarray(split)),
      ]
      expect(frames, String(split)).toEqual([
        { type: 'start', streamId: 1, url: START.url, method: 'POST', headers: [['content-type', 'application/json']], hasBody: true },
        { type: 'data', streamId: 1, data: Buffer.from('hello ') },
        { type: 'data', streamId: 1, data: Buffer.from('world') },
        { type: 'end', streamId: 1 },
      ])
      decoder.finish()
    }
  })

  it('decodes a cancel frame and yields nothing before a header completes', () => {
    const decoder = new DesktopHostRequestDecoder()
    const frame = requestFrame(4, 7, Buffer.alloc(0))
    expect(decoder.push(frame.subarray(0, HEADER_BYTES - 1))).toEqual([])
    expect(decoder.push(frame.subarray(HEADER_BYTES - 1))).toEqual([{ type: 'cancel', streamId: 7 }])
    decoder.finish()
  })

  it('rejects a wrong marker, an unknown frame type, and payloads on control frames', () => {
    const badMagic = requestFrame(3, 1, Buffer.alloc(0))
    badMagic.writeUInt32BE(0x44534833, 0)
    expect(() => new DesktopHostRequestDecoder().push(badMagic)).toThrow('invalid Electron request frame marker')
    expect(() => new DesktopHostRequestDecoder().push(requestFrame(9, 1, Buffer.alloc(0))))
      .toThrow('unknown Electron request frame type 9')
    expect(() => new DesktopHostRequestDecoder().push(requestFrame(3, 1, Buffer.from('x'))))
      .toThrow('request end frame carried a payload')
    expect(() => new DesktopHostRequestDecoder().push(requestFrame(4, 1, Buffer.from('x'))))
      .toThrow('request cancel frame carried a payload')
  })

  it('rejects stream ids outside the wire range and start frames that are not a valid request', () => {
    // Zero is the only out-of-range id a 32-bit wire header can carry.
    expect(() => new DesktopHostRequestDecoder().push(requestFrame(3, 0, Buffer.alloc(0))))
      .toThrow('invalid pipe stream id')
    expect(() => new DesktopHostRequestDecoder().push(requestFrame(1, 1, Buffer.from('not json'))))
      .toThrow('request start payload is not JSON')
    for (const value of [null, [], { ...START, url: 1 }, { ...START, headers: [['only-one']] }, { ...START, hasBody: 'yes' }]) {
      expect(() => new DesktopHostRequestDecoder().push(requestFrame(1, 1, startPayload(value))), JSON.stringify(value))
        .toThrow('invalid Electron request start payload')
    }
  })

  it('bounds a data frame at the pipe chunk size and a control frame at the control limit', () => {
    const decoder = new DesktopHostRequestDecoder()
    expect(decoder.push(requestFrame(2, 1, Buffer.alloc(DESKTOP_PIPE_CHUNK_BYTES)))).toHaveLength(1)
    expect(() => new DesktopHostRequestDecoder().push(requestFrame(2, 1, Buffer.alloc(DESKTOP_PIPE_CHUNK_BYTES + 1))))
      .toThrow('Electron request frame exceeds the 65536-byte limit')
    expect(() => new DesktopHostRequestDecoder().push(requestFrame(1, 1, Buffer.alloc(1024 * 1024 + 1))))
      .toThrow('Electron request frame exceeds the 1048576-byte limit')
  })

  it('rejects EOF inside a frame and accepts EOF on a frame boundary', () => {
    const decoder = new DesktopHostRequestDecoder()
    decoder.push(requestFrame(2, 1, Buffer.from('partial')).subarray(0, HEADER_BYTES + 2))
    expect(() => { decoder.finish() }).toThrow('Electron request pipe ended inside a frame')
    new DesktopHostRequestDecoder().finish()
  })
})

describe('desktop response frames', () => {
  it('encodes start, data, end, and error frames with the shared marker and header', () => {
    const start = encodeDesktopResponseStart(3, { status: 200, headers: [['content-type', 'text/plain']], hasBody: true })
    expect(start.readUInt32BE(0)).toBe(FRAME_MAGIC)
    expect(start.readUInt8(4)).toBe(1)
    expect(start.readUInt32BE(5)).toBe(3)
    expect(JSON.parse(start.subarray(HEADER_BYTES).toString('utf8')))
      .toEqual({ status: 200, headers: [['content-type', 'text/plain']], hasBody: true })
    const data = encodeDesktopResponseData(3, Buffer.from('body'))
    expect(data.readUInt8(4)).toBe(2)
    expect(data.subarray(HEADER_BYTES).toString('utf8')).toBe('body')
    const end = encodeDesktopResponseEnd(3)
    expect(end.readUInt8(4)).toBe(3)
    expect(end.readUInt32BE(9)).toBe(0)
    const error = encodeDesktopResponseError(3, 'boom')
    expect(error.readUInt8(4)).toBe(4)
    expect(JSON.parse(error.subarray(HEADER_BYTES).toString('utf8'))).toEqual({ message: 'boom' })
  })

  it('refuses a data frame above the chunk size, a control frame above the control limit, and an invalid stream id', () => {
    expect(() => encodeDesktopResponseData(1, Buffer.alloc(DESKTOP_PIPE_CHUNK_BYTES + 1)))
      .toThrow('response pipe frame exceeds the 65536-byte limit')
    expect(() => encodeDesktopResponseStart(1, { status: 200, headers: [], hasBody: false, ...{ padding: 'x'.repeat(1024 * 1024) } }))
      .toThrow('response pipe frame exceeds the 1048576-byte limit')
    expect(() => encodeDesktopResponseEnd(0)).toThrow('invalid pipe stream id')
  })

  it('states the protocol version the Electron shell handshakes on', () => {
    expect(DESKTOP_HOST_PROTOCOL_VERSION).toBe(1)
  })
})
