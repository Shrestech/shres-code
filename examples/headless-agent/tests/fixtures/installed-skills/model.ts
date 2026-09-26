/** Scripted external model for a real installed-skill tool round trip. */
import type { Context } from '@shres-code/cordis'
import { CallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@shres-code/shres-code-llm'

class InstalledSkillModel extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, context: { contextWindow: 128000 } }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const toolResult = options.messages.flatMap(message => message.content).find(block => block.type === 'tool-result')
    if (toolResult === undefined) {
      const args = JSON.stringify({ name: 'installed-probe' })
      const id = CallId('installed-skill-load')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'skill', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'skill', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const catalog = options.messages.flatMap(message => message.content)
      .filter(block => block.type === 'text').find(block => block.text.includes('<available_skills>'))?.text
    const loaded = toolResult.content.filter(block => block.type === 'text').map(block => block.text).join('')
    process.stdout.write(JSON.stringify({ kind: 'model-visible', catalog: catalog ?? null, loaded }) + '\n')
    const text = 'INSTALLED_SKILL_READY'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Fixture plugin name. */
export const name = 'installed-skill-model'
/** The model registry owns the scripted route. */
export const inject = ['llm']
/**
 * Register the deterministic external model used by the installed-skill snapshot.
 * @param ctx - Loader-owned fixture context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.llm.registerAdapter(['installed-skill-snapshot'], new InstalledSkillModel()))
}
