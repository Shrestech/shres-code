/**
 * Keyless hosted-tools snapshot backend: serves deterministic openai-responses
 * turns whose assistant answers report, from the wire itself, whether the
 * outgoing requests were correct.
 *
 * The first agent request must carry the hosted tool entries and no local
 * function tool named web_search or any hosted X call name. Its response makes
 * one server-side custom_tool_call for each X call name Grok reports and
 * answers. With `localCall: true` (the default) it also calls the local
 * todo_write tool, so the loop runs a second step. That second request replays
 * the first assistant message: it must keep the native message id and carry
 * only the todo_write function call and its output, never a hosted call or a
 * fabricated result for one. With `localCall: false` the turn ends after the
 * one step, because hosted calls are never dispatched.
 */

import { createServer } from 'node:http'
import { PiAiAdapter, resolveProfiles } from '@shres-code/shres-code-llm-pi-ai'

/** X call names the backend reports for the one hosted x_search tool. */
const X_CALL_NAMES = ['x_search', 'x_keyword_search', 'x_semantic_search', 'x_user_search', 'x_thread_fetch']

const USAGE = { input_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 6 }

/**
 * The SSE events of one assistant message output item.
 * @param {number} index - output index.
 * @param {string} id - message item id.
 * @param {string} text - message text.
 */
function messageEvents(index, id, text) {
  return [
    { type: 'response.output_item.added', output_index: index, item: { type: 'message', id, role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', item_id: id, output_index: index, content_index: 0, delta: text },
    {
      type: 'response.output_item.done',
      output_index: index,
      item: { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
    },
  ]
}

/**
 * The first agent step: one hosted custom_tool_call per X call name, the
 * splice verdict, then optionally a local todo_write function call.
 * @param {string} verdict - the splice verdict the answer reports.
 * @param {boolean} localCall - whether the step also calls todo_write.
 */
function hostedTurn(verdict, localCall) {
  const hosted = X_CALL_NAMES.flatMap((name, index) => {
    const item = {
      id: `ctc_item_${index}`,
      call_id: `call_ctc_${index}`,
      type: 'custom_tool_call',
      name,
      input: 'hosted snapshot query',
      status: 'completed',
    }
    return [
      { type: 'response.output_item.added', output_index: index, item },
      { type: 'response.output_item.done', output_index: index, item },
    ]
  })
  const textIndex = X_CALL_NAMES.length
  const callIndex = textIndex + 1
  const args = JSON.stringify({ todos: [{ content: 'Report the hosted search verdict', status: 'completed' }] })
  const call = { type: 'function_call', id: 'fc_item_1', call_id: 'call_fc_1', name: 'todo_write', arguments: '' }
  return [
    { type: 'response.created', response: { id: 'resp_1' } },
    ...hosted,
    ...messageEvents(textIndex, 'msg_1', verdict),
    ...localCall
      ? [
        { type: 'response.output_item.added', output_index: callIndex, item: call },
        { type: 'response.function_call_arguments.delta', output_index: callIndex, item_id: 'fc_item_1', delta: args },
        { type: 'response.function_call_arguments.done', output_index: callIndex, item_id: 'fc_item_1', arguments: args },
        { type: 'response.output_item.done', output_index: callIndex, item: { ...call, arguments: args, status: 'completed' } },
      ]
      : [],
    { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: USAGE } },
  ]
}

/**
 * A later step or auxiliary call: one text answer.
 * @param {string} text - the answer text.
 */
function answerTurn(text) {
  return [
    { type: 'response.created', response: { id: 'resp_2' } },
    ...messageEvents(0, 'msg_2', text),
    { type: 'response.completed', response: { id: 'resp_2', status: 'completed', usage: USAGE } },
  ]
}

/**
 * Whether the outgoing tools array carries the hosted entries and no local
 * function tool that a hosted tool supersedes.
 * @param {unknown[]} tools - the request's tools array.
 */
function spliceVerdict(tools) {
  const hostedWeb = tools.some(tool => typeof tool === 'object' && tool !== null && tool.type === 'web_search')
  const hostedX = tools.some(tool => typeof tool === 'object' && tool !== null && tool.type === 'x_search')
  const localSuperseded = tools.some(tool => typeof tool === 'object'
    && tool !== null
    && tool.type === 'function'
    && (tool.name === 'web_search' || X_CALL_NAMES.includes(tool.name)))
  if (!hostedWeb) return 'HOSTED_MISSING_WEB_SEARCH_ENTRY'
  if (!hostedX) return 'HOSTED_MISSING_X_SEARCH_ENTRY'
  if (localSuperseded) return 'HOSTED_LOCAL_TOOL_NOT_DROPPED'
  return 'HOSTED_OK'
}

/**
 * Whether the replayed history carries only the local todo_write call and its
 * output, and kept the first message's native id.
 * @param {unknown[]} input - the request's input items.
 */
function replayVerdict(input) {
  const items = input.filter(item => typeof item === 'object' && item !== null)
  if (items.some(item => item.type === 'custom_tool_call' || item.type === 'custom_tool_call_output')) return 'REPLAY_HOSTED_CALL_SENT'
  const calls = items.filter(item => item.type === 'function_call')
  if (calls.some(item => item.name !== 'todo_write')) return 'REPLAY_HOSTED_CALL_SENT'
  const outputs = items.filter(item => item.type === 'function_call_output')
  if (calls.length !== 1 || outputs.length !== 1) return 'REPLAY_TOOL_RESULT_MISMATCH'
  if (!items.some(item => item.type === 'message' && item.id === 'msg_1')) return 'REPLAY_DEGRADED'
  return 'REPLAY_OK'
}

/**
 * Choose the turn for one request. Only agent-loop requests carry tools; an
 * auxiliary call without tools repeats the latest verdict.
 * @param {unknown} body - the parsed request body.
 * @param {{ splice: string, answer: string }} state - verdicts seen so far.
 * @param {boolean} localCall - whether the first step also calls todo_write.
 */
function turnFor(body, state, localCall) {
  const tools = typeof body === 'object' && body !== null && Array.isArray(body.tools) ? body.tools : undefined
  const input = typeof body === 'object' && body !== null && Array.isArray(body.input) ? body.input : []
  if (tools === undefined) return answerTurn(state.answer)
  const replaying = input.some(item => typeof item === 'object' && item !== null && item.type === 'function_call_output')
  if (!replaying) {
    state.splice = spliceVerdict(tools)
    state.answer = state.splice
    return hostedTurn(state.splice, localCall)
  }
  state.answer = `${state.splice} ${replayVerdict(input)}`
  return answerTurn(state.answer)
}

/** Cordis plugin name. */
export const name = 'hosted-search-snapshot-backend'
/** Required LLM registry service. */
export const inject = ['llm']

/**
 * Serve the hosted-tools turns from a local Responses endpoint and register
 * the real pi-ai adapter against it, declaring both hosted tools for the
 * default route so the request path exercises the production splice,
 * promotion, and replay machinery.
 * @param {import('@shres-code/cordis').Context} ctx - context carrying the LLM service.
 * @param {{ localCall?: boolean } | undefined} config - `localCall: false` serves the hosted-only one-step turn.
 */
export async function apply(ctx, config) {
  const localCall = config?.localCall !== false
  const state = { splice: 'HOSTED_OK', answer: 'HOSTED_OK' }
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
      const events = turnFor(body, state, localCall).map(event => JSON.stringify(event))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of events) response.write(`data: ${event}\n\n`)
      response.end()
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
