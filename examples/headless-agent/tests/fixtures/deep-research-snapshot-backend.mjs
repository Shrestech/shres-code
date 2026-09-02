/**
 * Keyless deep_research snapshot backend: a canned web-search provider pinned
 * as `perplexity` plus a deterministic LLM adapter whose first turn issues a
 * `deep_research` tool call and whose second turn answers with a verdict
 * derived from the tool result the loop fed back. The transcript therefore
 * proves the model-facing tool exists, executes through the request-level
 * provider pin, and its synthesized result reaches the next model turn.
 */

import { LlmAdapter } from '@shres-code/shres-code-llm'

/** The canned synthesis the pinned provider serves. */
const SYNTHESIS = 'RESEARCH_SYNTHESIS: the answer is 42, per one cited source.'

/** Cordis plugin name. */
export const name = 'deep-research-snapshot-backend'
/** Required LLM and web services. */
export const inject = ['llm', 'web']

/**
 * Register the pinned fake search provider and the two-turn model adapter.
 * @param {import('@shres-code/cordis').Context} ctx - context carrying the LLM and web services.
 */
export function apply(ctx) {
  let seenQuery
  ctx.web.registerSearchProvider({
    id: 'perplexity',
    available: () => true,
    search: (request) => {
      seenQuery = request.query
      return Promise.resolve({
        content: SYNTHESIS,
        sources: [{ url: 'https://snapshot.test/fable-5', title: 'Fable 5' }],
        truncated: false,
      })
    },
  })

  let requests = 0
  class DeepResearchAdapter extends LlmAdapter {
    async * stream(options) {
      requests++
      if (requests === 1) {
        const call = { type: 'tool-call', id: 'call_dr_1', name: 'deep_research', arguments: '{"query":"the ultimate question"}' }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
        yield { type: 'block-end', index: 0, block: call }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      // Second turn: the tool result must have reached the model through the
      // loop, and the pinned provider must have seen the model's query.
      const messages = JSON.stringify(options.messages)
      const sawSynthesis = messages.includes(SYNTHESIS)
      const answer = sawSynthesis && seenQuery === 'the ultimate question'
        ? 'RESEARCH_OK'
        : 'RESEARCH_UNEXPECTED'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
      yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['deepseek-official'], new DeepResearchAdapter())
}
