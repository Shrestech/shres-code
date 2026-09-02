/**
 * Keyless hosted-tools snapshot backend: serves one deterministic
 * openai-responses turn whose assistant answer reports, from the wire itself,
 * whether the outgoing request carried the hosted tool entries and dropped the
 * colliding local web_search function tool. The hosted x_search call rides a
 * custom_tool_call item, so the assembled transcript must show it as a
 * server-tool-call block the loop never dispatches.
 */

import { createServer } from 'node:http'
import { PiAiAdapter, resolveProfiles } from '@shres-code/shres-code-llm-pi-ai'

/**
 * One deterministic Responses SSE turn: a hosted x_search call, then the given
 * answer text.
 * @param {string} text - the assistant answer this turn serves.
 */
function hostedTurn(text) {
  const custom = {
    id: 'ctc_item_1',
    call_id: 'call_ctc_1',
    type: 'custom_tool_call',
    name: 'x_search',
    input: 'hosted snapshot query',
    status: 'completed',
  }
  return [
    JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }),
    JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: custom }),
    JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: custom }),
    JSON.stringify({ type: 'response.output_item.added', output_index: 1, item: { type: 'message', role: 'assistant' } }),
    JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: text }),
    JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 6 } } }),
  ]
}

/**
 * Whether the outgoing tools array carries the hosted entries and no local
 * web_search function tool.
 * @param {unknown} body - the parsed request body.
 */
function spliceVerdict(body) {
  const tools = typeof body === 'object' && body !== null && Array.isArray(body.tools) ? body.tools : []
  const hostedWeb = tools.some(tool => typeof tool === 'object' && tool !== null && tool.type === 'web_search')
  const hostedX = tools.some(tool => typeof tool === 'object' && tool !== null && tool.type === 'x_search')
  const localWeb = tools.some(tool => typeof tool === 'object'
    && tool !== null
    && tool.type === 'function'
    && tool.name === 'web_search')
  if (!hostedWeb) return 'HOSTED_MISSING_WEB_SEARCH_ENTRY'
  if (!hostedX) return 'HOSTED_MISSING_X_SEARCH_ENTRY'
  if (localWeb) return 'HOSTED_LOCAL_WEB_SEARCH_NOT_DROPPED'
  return 'HOSTED_OK'
}

/** Cordis plugin name. */
export const name = 'hosted-search-snapshot-backend'
/** Required LLM registry service. */
export const inject = ['llm']

/**
 * Serve the hosted-tools turn from a local Responses endpoint and register the
 * real pi-ai adapter against it, declaring both hosted tools for the default
 * route so the request path exercises the production splice machinery. The
 * first request's splice verdict becomes every turn's answer, so later
 * auxiliary calls (which carry no tools) cannot flip the transcript's text.
 * @param {import('@shres-code/cordis').Context} ctx - context carrying the LLM service.
 */
export async function apply(ctx) {
  let answer = 'HOSTED_OK'
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk.toString('utf8') })
    request.on('end', () => {
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        body = undefined
      }
      if (answer === 'HOSTED_OK') answer = spliceVerdict(body)
      const events = hostedTurn(answer)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      let index = 0
      const writeNext = () => {
        const event = events[index++]
        if (event === undefined) {
          response.end()
          return
        }
        response.write(`data: ${event}\n\n`)
        writeNext()
      }
      writeNext()
    })
  })
  // Bind before registering: registration resolves the profiles (and their
  // baseURL) synchronously, so the port must already exist.
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  ctx.effect(() => () => { server.close() })
  const bound = server.address()
  if (bound === null || typeof bound === 'string') throw new Error('hosted snapshot backend has no port')
  const baseURL = `http://127.0.0.1:${bound.port}`
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({
      'deepseek-official': {
        api: 'openai-responses',
        baseURL,
        hostedTools: { webSearch: true, xSearch: true },
        models: [{ id: 'deepseek-v4-flash' }],
      },
    }),
    resolveApiKey: () => Promise.resolve('snapshot-key'),
  })
  ctx.llm.registerAdapter(['deepseek-official'], adapter)
}
