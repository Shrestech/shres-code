/** Scripted external model for the real native BrowserSkill Loader composition. */
import type { Context } from '@shres-code/cordis'
import { CallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@shres-code/shres-code-llm'

function record(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + String.fromCharCode(10))
}

function* call(id: string, name: string, args: unknown): Generator<StreamChunk> {
  const argumentsText = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: CallId(id), name, argumentsDelta: argumentsText }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(id), name, arguments: argumentsText } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

class BrowserSkillNativeModel extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, context: { contextWindow: 128000 } }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const blocks = options.messages.flatMap(message => message.content)
    const results = blocks.filter(block => block.type === 'tool-result')
      .map(block => block.content.filter(inner => inner.type === 'text').map(inner => inner.text).join(''))
    if (results.length === 0) {
      record({ kind: 'model-visible', tools: options.tools?.filter(tool => tool.name.startsWith('browser_')).sort((a, b) => a.name.localeCompare(b.name)),
        catalog: blocks.find(block => block.type === 'text' && block.text.includes('<available_skills>')) })
      yield* call('native-guide', 'skill', { name: 'browserskill' })
    } else if (results.length === 1) {
      record({ kind: 'guide', output: results[0] })
      yield* call('native-session', 'browser_session', { action: 'start' })
    } else if (results.length === 2) {
      record({ kind: 'session-result', output: results[1] })
      yield* call('native-navigate', 'browser_navigate', { session: 'not-a-session', url: 'http://127.0.0.1/' })
    } else {
      record({ kind: 'navigate-result', output: results[2] })
      const text = 'BROWSERSKILL_NATIVE_NOT_READY'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

/** Fixture plugin name. */
export const name = 'browserskill-native-model'
/** Registry that owns the scripted external adapter. */
export const inject = ['llm']
/**
 * Register a keyless response sequence, without replacing browser tools or runtime.
 * @param ctx - Loader-owned fixture context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.llm.registerAdapter(['browserskill-native-snapshot'], new BrowserSkillNativeModel()))
}
