/** Parent adapter that fails if the composition-only Loader test starts a turn. */

import type { Context } from '@shres-code/cordis'
import type { GenerateOptions, StreamChunk } from '@shres-code/shres-code-llm'
import { LlmAdapter } from '@shres-code/shres-code-llm'

class CompositionOnlyAdapter extends LlmAdapter {
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('subagent-kimi-cli Loader composition must not invoke a model')
  }
}

export const name = 'kimi-cli-loader-composition-fixture'
export const inject = ['llm']

/**
 * Register a parent adapter solely so the host composition is complete.
 * @param ctx - Loader context supplying the LLM seam.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['mock'], new CompositionOnlyAdapter())
}
