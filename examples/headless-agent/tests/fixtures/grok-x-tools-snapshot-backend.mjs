/**
 * Keyless calling-model backend for the Grok X tools snapshot: a non-Grok
 * openai-responses route whose model discovers `x_keyword_search` in its
 * offered tools, calls it once, and answers with a verdict computed from the
 * tool output it receives. The Grok side is a separate stand-in the snapshot
 * test serves; this backend never sees the Grok request.
 */

import { createServer } from 'node:http'
import { PiAiAdapter, resolveProfiles } from '@shres-code/shres-code-llm-pi-ai'

const X_TOOLS = ['x_keyword_search', 'x_semantic_search', 'x_user_search', 'x_thread_fetch']
const USAGE = { input_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 6 }

/**
 * One assistant text answer.
 * @param {string} id - response and message id suffix.
 * @param {string} text - the answer.
 */
function answer(id, text) {
  const message = { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  return [
    { type: 'response.created', response: { id: `resp_${id}` } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
    { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: { id: `resp_${id}`, status: 'completed', usage: USAGE } },
  ]
}

/** The first step: one `x_keyword_search` function call. */
function callXTool() {
  const args = JSON.stringify({ query: 'from:xai grok' })
  const call = { type: 'function_call', id: 'fc_item_1', call_id: 'call_x_1', name: 'x_keyword_search', arguments: '' }
  return [
    { type: 'response.created', response: { id: 'resp_1' } },
    { type: 'response.output_item.added', output_index: 0, item: call },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_item_1', delta: args },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_item_1', arguments: args },
    { type: 'response.output_item.done', output_index: 0, item: { ...call, arguments: args, status: 'completed' } },
    { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: USAGE } },
  ]
}

/**
 * Verdict over the tool output the calling model received.
 * @param {string} output - the function_call_output text.
 */
function outputVerdict(output) {
  if (!output.includes('X operations Grok ran: x_keyword_search.')) return 'X_TOOLS_NO_OPERATIONS'
  if (!output.includes('https://x.com/xai/status/7')) return 'X_TOOLS_NO_CITATION'
  if (!output.includes('GROK_REQUEST_OK')) return 'X_TOOLS_GROK_REQUEST_BAD'
  return 'X_TOOLS_OK'
}

/** Cordis plugin name. */
export const name = 'grok-x-tools-snapshot-backend'
/** Required LLM registry service. */
export const inject = ['llm']

/**
 * Serve the calling model from a local Responses endpoint and register the
 * real pi-ai adapter against it for the default route.
 * @param {import('@shres-code/cordis').Context} ctx - context carrying the LLM service.
 */
export async function apply(ctx) {
  let verdict = 'X_TOOLS_NOT_CALLED'
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
      const tools = Array.isArray(body?.tools) ? body.tools : undefined
      const input = Array.isArray(body?.input) ? body.input : []
      const output = input.find(item => item?.type === 'function_call_output')
      let events
      if (tools === undefined) {
        events = answer('aux', verdict)
      } else if (output === undefined) {
        const offered = tools.filter(tool => tool?.type === 'function').map(tool => tool.name)
        verdict = X_TOOLS.every(tool => offered.includes(tool)) ? 'X_TOOLS_CALLED' : 'X_TOOLS_NOT_OFFERED'
        events = verdict === 'X_TOOLS_CALLED' ? callXTool() : answer('1', verdict)
      } else {
        verdict = outputVerdict(typeof output.output === 'string' ? output.output : JSON.stringify(output.output))
        events = answer('2', verdict)
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
      response.end()
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  ctx.effect(() => () => { server.close() })
  const bound = server.address()
  if (bound === null || typeof bound === 'string') throw new Error('grok x tools snapshot backend has no port')
  ctx.llm.registerAdapter(['deepseek-official'], new PiAiAdapter({
    profiles: () => resolveProfiles({
      'deepseek-official': {
        api: 'openai-responses',
        baseURL: `http://127.0.0.1:${bound.port}`,
        models: [{ id: 'deepseek-v4-flash' }],
      },
    }),
    resolveApiKey: () => Promise.resolve('snapshot-key'),
  }))
}
