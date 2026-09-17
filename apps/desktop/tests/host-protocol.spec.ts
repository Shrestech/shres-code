/**
 * Shell-side wire framing round-trips against the desktop host's own encoder
 * and decoder: the two sides cannot drift when they share the constants.
 */

import { describe, expect, it } from 'vitest'
import {
  DesktopHostRequestDecoder, encodeDesktopResponseData, encodeDesktopResponseEnd, encodeDesktopResponseError, encodeDesktopResponseStart, FRAME_MAGIC,
} from '@shres-code/shres-code-desktop-host'
import {
  encodeRequestCancel, encodeRequestData, encodeRequestEnd, encodeRequestStart, ShellResponseDecoder,
} from '../src/host-protocol.ts'

describe('shell request framing', () => {
  it('encodes frames the host decoder accepts, across split writes', () => {
    const decoder = new DesktopHostRequestDecoder()
    const start = encodeRequestStart(1, {
      url: 'shres-app://app/api/events.mux',
      method: 'POST',
      headers: [['content-type', 'application/json']],
      hasBody: true,
    })
    expect(decoder.push(start.subarray(0, 5))).toEqual([])
    const frames = decoder.push(start.subarray(5))
    expect(frames).toEqual([{
      type: 'start', streamId: 1, url: 'shres-app://app/api/events.mux', method: 'POST',
      headers: [['content-type', 'application/json']], hasBody: true,
    }])
    expect(decoder.push(encodeRequestData(1, Buffer.from('{"a":1}')))).toEqual([{ type: 'data', streamId: 1, data: Buffer.from('{"a":1}') }])
    expect(decoder.push(encodeRequestEnd(1))).toEqual([{ type: 'end', streamId: 1 }])
    expect(decoder.push(encodeRequestCancel(2))).toEqual([{ type: 'cancel', streamId: 2 }])
    expect(() => decoder.finish()).not.toThrow()
  })
})

describe('shell response decoding', () => {
  it('decodes host start, data, end, and error frames', () => {
    const decoder = new ShellResponseDecoder()
    const hostStart = encodeDesktopResponseStart(7, { status: 200, headers: [['content-type', 'text/html']], hasBody: true })
    const hostData = encodeDesktopResponseData(7, Buffer.from('hello'))
    const hostEnd = encodeDesktopResponseEnd(7)
    expect(decoder.push(hostStart)).toEqual([{
      type: 'start', streamId: 7, status: 200, headers: [['content-type', 'text/html']], hasBody: true,
    }])
    const data = decoder.push(hostData)
    expect(data[0]?.type).toBe('data')
    expect(data[0]?.type === 'data' && Buffer.from(data[0].data).toString()).toBe('hello')
    expect(decoder.push(hostEnd)).toEqual([{ type: 'end', streamId: 7 }])
    expect(decoder.push(encodeDesktopResponseError(8, 'boom'))).toEqual([{ type: 'error', streamId: 8, message: 'boom' }])
  })

  it('rejects a foreign frame marker', () => {
    const decoder = new ShellResponseDecoder()
    const bad = Buffer.alloc(13)
    bad.writeUInt32BE(FRAME_MAGIC + 1, 0)
    expect(() => decoder.push(bad)).toThrow('invalid host response frame marker')
  })
})
