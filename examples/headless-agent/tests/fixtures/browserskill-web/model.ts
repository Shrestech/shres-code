/** Scripted external model for opt-in native Web evidence; all browser tools remain real. */
import type { Context } from '@shres-code/cordis'
import { CallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@shres-code/shres-code-llm'

/** Local form endpoint and non-sensitive value used by the isolated evidence run. */
export interface Config { url: string; marker: string }

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Browser fixture expected an object result')
  return value as Record<string, unknown>
}

function result(text: string | undefined): Record<string, unknown> {
  if (text === undefined) throw new Error('Browser fixture is missing a tool result')
  const opening = '<browser-result>'
  const start = text.indexOf(opening)
  const json = start === -1 ? text : text.slice(start + opening.length, text.lastIndexOf('</browser-result>'))
  const parsed = object(JSON.parse(json))
  if (parsed.ok !== true) throw new Error('Real browser tool refused the fixture task: ' + String(parsed.reason) + ': ' + String(parsed.detail))
  return parsed
}

function observation(text: string | undefined): string {
  const value = object(result(text).value)
  if (typeof value.text !== 'string') throw new Error('Real browser observation did not contain text')
  return value.text
}

function elementRef(text: string, label: string): string {
  // The a11y text lists ref-less ancestor rows that share the label (the form
  // row precedes the field row it names); the interactive element is the first
  // line that names the label AND carries the framed `@e<digits>` reference
  // the runtime enforces.
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(label)) continue
    const ref = line.match(/@e[0-9]+/u)?.[0]
    if (ref !== undefined) return ref
  }
  throw new Error('Real browser observation did not expose a ref for ' + label)
}

function* call(id: string, name: string, args: unknown): Generator<StreamChunk> {
  const argumentsText = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: CallId(id), name, argumentsDelta: argumentsText }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(id), name, arguments: argumentsText } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

class NativeWebModel extends LlmAdapter {
  constructor(private readonly config: Config) { super() }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, context: { contextWindow: 128000 } }
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const results = options.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')
      .map(block => block.content.filter(inner => inner.type === 'text').map(inner => inner.text).join(''))
    if (results.length === 0) { yield* call('web-guide', 'skill', { name: 'browserskill' }); return }
    if (results.length === 1) { yield* call('web-session', 'browser_session', { action: 'start' }); return }
    const session = result(results[1]).session
    if (typeof session !== 'string') throw new Error('Real browser session start did not return its id')
    if (results.length === 2) { yield* call('web-navigate', 'browser_navigate', { session, url: this.config.url }); return }
    result(results.at(-1))
    if (results.length === 3) { yield* call('web-observe-input', 'browser_observe', { session }); return }
    if (results.length === 4) {
      yield* call('web-fill', 'browser_act', { session, action: { kind: 'fill', ref: elementRef(observation(results[3]), 'Probe marker'), value: this.config.marker } })
      return
    }
    if (results.length === 5) { yield* call('web-observe-button', 'browser_observe', { session }); return }
    if (results.length === 6) {
      yield* call('web-click', 'browser_act', { session, action: { kind: 'click', ref: elementRef(observation(results[5]), 'Submit probe') } })
      return
    }
    if (results.length === 7) { yield* call('web-observe-receipt', 'browser_observe', { session }); return }
    const last = result(results.at(-1))
    if (last.action !== 'stop') {
      const observed = observation(results.at(-1))
      if (observed.includes('BSK-WEB-RECEIVED') && observed.includes(this.config.marker)) {
        yield* call('web-stop', 'browser_session', { action: 'stop', session })
      } else {
        if (results.length >= 12) throw new Error('Real page did not confirm the form submission')
        yield* call('web-observe-receipt-' + String(results.length), 'browser_observe', { session })
      }
      return
    }
    const text = 'BROWSERSKILL_WEB_CONTROL_COMPLETE'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Test-only provider name. */
export const name = 'browserskill-web-model'
/** The external model registry is the only replaced service. */
export const inject = ['llm']
/**
 * Register a deterministic external adapter for an isolated loopback form task.
 * @param ctx - real Loader context; no browser runtime or tool is replaced.
 * @param config - explicit local endpoint and non-sensitive marker.
 */
export function apply(ctx: Context, config: Config): void {
  const url = new URL(config.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username !== '' || url.password !== '') {
    throw new Error('Native Web fixture requires a credential-free IPv4 loopback form URL')
  }
  if (typeof config.marker !== 'string' || config.marker.length === 0 || config.marker.length > 200) throw new Error('Native Web fixture marker is invalid')
  ctx.effect(() => ctx.llm.registerAdapter(['browserskill-web-fixture'], new NativeWebModel(config)))
}
