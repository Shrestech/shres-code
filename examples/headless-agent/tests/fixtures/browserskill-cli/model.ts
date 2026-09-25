/** Scripted external model for a real skill-tool plus bash-tool bsk round trip. */
import type { Context } from '@shres-code/cordis'
import { CallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@shres-code/shres-code-llm'

/** Final assistant text the driver reports as the completed output. */
const READY_OUTPUT = 'BROWSER_SKILL_READY'

/** One scripted bash-tool call: the exact command plus its display metadata. */
interface BashStep {
  readonly command: string
  readonly description: string
}

/** Text of every tool result so far, in message order. */
function toolResultTexts(options: GenerateOptions): string[] {
  return options.messages.flatMap(message => message.content)
    .flatMap(block => block.type === 'tool-result' ? [block] : [])
    .map(block => block.content.filter(inner => inner.type === 'text').map(inner => inner.text).join(''))
}

/** Read the session id the scripted workflow threads from the start output into later argv. */
function parseSessionId(startOutput: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(startOutput)
  } catch {
    throw new Error('browser-skill fixture: session start output is not JSON')
  }
  const sessionId = (parsed as { session_id?: unknown } | null)?.session_id
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('browser-skill fixture: session start output has no session_id')
  }
  return sessionId
}

/** Build the whole scripted workflow; the id-dependent steps need the start output. */
function workflow(results: readonly string[]): BashStep[] {
  const help: BashStep = { command: 'bsk --help', description: 'Print the bsk command summary' }
  const start: BashStep = { command: 'bsk session start --no-focus --json', description: 'Start a headless bsk session' }
  if (results.length < 3) return [help, start]
  const sessionId = parseSessionId(results[2]!)
  return [
    help,
    start,
    { command: `bsk navigate https://example.com --session ${sessionId}`, description: 'Navigate the bsk session to example.com' },
    { command: `bsk observe --session ${sessionId}`, description: 'Observe the current bsk page state' },
    { command: `bsk session stop ${sessionId}`, description: 'Stop the bsk session' },
    { command: `bsk session restart ${sessionId}`, description: 'Probe an unsupported bsk verb' },
  ]
}

class BrowserSkillModel extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, context: { contextWindow: 128000 } }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const results = toolResultTexts(options)
    if (results.length === 0) {
      yield* toolCallChunks(0, CallId('browser-skill-load'), 'skill', JSON.stringify({ name: 'browser-skill' }))
      return
    }
    if (results.length === 1) {
      writeModelVisibleRecord(options, results[0]!)
      yield* toolCallChunks(0, CallId('bsk-step-0'), 'bash', JSON.stringify(workflow(results)[0]!))
      return
    }
    // results[0] is the skill load; every later result completed one scripted bash step.
    const steps = workflow(results)
    const stepIndex = results.length - 2
    process.stdout.write(JSON.stringify({
      kind: 'bash-result', command: steps[stepIndex]!.command, output: results.at(-1),
    }) + '\n')
    const next = steps.at(stepIndex + 1)
    if (next === undefined) {
      yield* textChunks(0, READY_OUTPUT)
      return
    }
    yield* toolCallChunks(0, CallId(`bsk-step-${stepIndex + 1}`), 'bash', JSON.stringify(next))
  }
}

function* toolCallChunks(index: number, id: ReturnType<typeof CallId>, name: string, args: string): Generator<StreamChunk> {
  yield { type: 'block-start', index, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index, id, name, argumentsDelta: args }
  yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function* textChunks(index: number, text: string): Generator<StreamChunk> {
  yield { type: 'block-start', index, blockType: 'text' }
  yield { type: 'text-delta', index, text }
  yield { type: 'block-end', index, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** Publish the model-visible evidence: the session catalog and the loaded untrusted skill frame. */
function writeModelVisibleRecord(options: GenerateOptions, loaded: string): void {
  const catalog = options.messages.flatMap(message => message.content)
    .filter(block => block.type === 'text').find(block => block.text.includes('<available_skills>'))?.text
  process.stdout.write(JSON.stringify({ kind: 'model-visible', catalog: catalog ?? null, loaded }) + '\n')
}

/** Fixture plugin name. */
export const name = 'browser-skill-model'
/** The model registry owns the scripted route. */
export const inject = ['llm']
/**
 * Register the deterministic external model used by the browser-skill CLI snapshot.
 * @param ctx - Loader-owned fixture context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.llm.registerAdapter(['browser-skill-snapshot'], new BrowserSkillModel()))
}
