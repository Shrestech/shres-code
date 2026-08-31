/**
 * The image_gen wire client against an injected fetch: request body fields and
 * the bearer header mirror the Grok CLI, and every documented failure mode
 * (401 auth, other non-2xx, network rejection, unparseable body, empty data,
 * and strictly invalid base64) surfaces a named LlmError without any token or
 * full payload reaching the model.
 */
import { describe, expect, it } from 'vitest'
import { ImageGenClient } from '../src/index.ts'

/** Encode exact bytes as the response b64_json value. */
function b64(bytes: readonly number[]): string {
  return Buffer.from(bytes).toString('base64')
}

/** One response object the client decodes. */
function payload(b64Json?: string): unknown {
  return b64Json === undefined ? { data: [] } : { data: [{ b64_json: b64Json }] }
}

interface Stub {
  requests: { url: string; headers: unknown; body: unknown }[]
  fetch: typeof fetch
  setResponse: (body: unknown, status?: number) => void
  setRawBody: (text: string, status?: number) => void
  rejectOnce: (error: Error) => void
}

/** A fetch stub recording requests and serving scripted responses or one throw. */
function stub(): Stub {
  const requests: Stub['requests'] = []
  let responder: () => Response = () => new Response('{}', { status: 200 })
  let rejecting: Error | undefined
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    requests.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      headers: init?.headers,
      body,
    })
    if (rejecting !== undefined) {
      const error = rejecting
      rejecting = undefined
      throw error
    }
    return responder()
  }
  return {
    requests,
    fetch: fetchImpl,
    setResponse: (body, status = 200) => {
      responder = () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    },
    setRawBody: (text, status = 200) => {
      responder = () => new Response(text, { status, headers: { 'content-type': 'application/json' } })
    },
    rejectOnce: (error) => { rejecting = error },
  }
}

describe('ImageGenClient', () => {
  const imageBytes = [0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]
  const client = (fetchImpl: typeof fetch) => new ImageGenClient({ baseUrl: 'https://api.x.ai/v1', model: 'grok-imagine-image-quality', fetch: fetchImpl })

  it('defaults to the global fetch when none is injected', () => {
    expect(new ImageGenClient({ baseUrl: 'x', model: 'm' })).toBeInstanceOf(ImageGenClient)
  })

  it('posts to {base}/images/generations with the CLI wire body and bearer', async () => {
    const s = stub()
    s.setResponse(payload(b64(imageBytes)))
    const decoded = await client(s.fetch).generate('token-1', 'a red cat', '16:9')
    expect(decoded).toEqual(Buffer.from(imageBytes))
    expect(s.requests).toHaveLength(1)
    expect(s.requests[0]!.url).toBe('https://api.x.ai/v1/images/generations')
    expect(s.requests[0]!.body).toEqual({
      model: 'grok-imagine-image-quality',
      prompt: 'a red cat',
      n: 1,
      aspect_ratio: '16:9',
      resolution: '1k',
      response_format: 'b64_json',
    })
    const headers = s.requests[0]!.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer token-1')
    expect(headers['content-type']).toBe('application/json')
  })

  it('sends no per-session header', async () => {
    const s = stub()
    s.setResponse(payload(b64(imageBytes)))
    await client(s.fetch).generate('token-1', 'a cat', 'auto')
    const headers = s.requests[0]!.headers as Record<string, string>
    expect(headers['x-grok-session-id']).toBeUndefined()
  })

  it('surfaces a 401 as IMAGE_GEN_AUTH_FAILED', async () => {
    const s = stub()
    s.setResponse({ error: { message: 'unauthorized' } }, 401)
    await expect(client(s.fetch).generate('expired', 'a cat', 'auto')).rejects.toMatchObject({ code: 'IMAGE_GEN_AUTH_FAILED' })
  })

  it('surfaces a non-2xx status as IMAGE_GEN_HTTP with the status', async () => {
    const s = stub()
    s.setResponse({ error: { message: 'rate limited' } }, 429)
    await expect(client(s.fetch).generate('token-1', 'a cat', 'auto')).rejects.toMatchObject({ code: 'IMAGE_GEN_HTTP' })
  })

  it('surfaces a network rejection as IMAGE_GEN_NETWORK', async () => {
    const s = stub()
    s.rejectOnce(new Error('socket hang up'))
    await expect(client(s.fetch).generate('token-1', 'a cat', 'auto')).rejects.toMatchObject({ code: 'IMAGE_GEN_NETWORK' })
  })

  it('rejects a non-JSON response body as IMAGE_GEN_BAD_RESPONSE', async () => {
    const s = stub()
    s.setRawBody('this is not json')
    await expect(client(s.fetch).generate('token-1', 'a cat', 'auto')).rejects.toMatchObject({ code: 'IMAGE_GEN_BAD_RESPONSE' })
  })

  it('rejects an empty data payload as IMAGE_GEN_BAD_RESPONSE', async () => {
    const s = stub()
    s.setResponse(payload(undefined))
    await expect(client(s.fetch).generate('token-1', 'a cat', 'auto')).rejects.toMatchObject({ code: 'IMAGE_GEN_BAD_RESPONSE' })
  })

  it('rejects strictly invalid base64 without a network throw', async () => {
    const s = stub()
    s.setResponse(payload('!!!!'))
    await expect(client(s.fetch).generate('token-1', 'a cat', 'auto')).rejects.toMatchObject({ code: 'IMAGE_GEN_BAD_RESPONSE' })
  })

  it('accepts canonical padded base64', async () => {
    const s = stub()
    const padded = b64([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02])
    s.setResponse(payload(padded))
    await expect(client(s.fetch).generate('token-1', 'a cat', 'auto')).resolves.toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]))
  })
})
