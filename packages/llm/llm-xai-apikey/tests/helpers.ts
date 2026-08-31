/**
 * Test fixtures: a local stand-in for the xAI Responses endpoint that records
 * request bodies and replays one event stream.
 * @module tests/helpers
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface MockUpstream {
  url: string
  paths: string[]
  authHeaders: string[]
  bodies: unknown[]
  close: () => Promise<void>
}

/** Local xAI stand-in: records requests, replays one responses stream. */
export async function mockUpstream(events: string[]): Promise<MockUpstream> {
  const paths: string[] = []
  const authHeaders: string[] = []
  const bodies: unknown[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      paths.push(request.url ?? '')
      authHeaders.push(request.headers.authorization ?? '')
      bodies.push(body.length === 0 ? undefined : JSON.parse(body))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      let index = 0
      const writeNext = (): void => {
        const event = events[index++]
        if (event === undefined) {
          response.end()
          return
        }
        response.write('data: ' + event + '\n\n')
        writeNext()
      }
      writeNext()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: 'http://127.0.0.1:' + String(address.port),
    paths,
    authHeaders,
    bodies,
    close: () => new Promise(resolve => server.close(() => { resolve() })),
  }
}

/** One assistant text turn in the xAI responses stream, with usage. */
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
