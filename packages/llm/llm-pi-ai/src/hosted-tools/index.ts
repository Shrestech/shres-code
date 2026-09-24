/**
 * Dialect-neutral hosted-tool machinery: the payload splice that adds hosted
 * tool entries and drops the local tools they supersede, the stream promotion
 * that keeps a hosted call out of local dispatch, and the dialect registry
 * that maps one wire protocol to the hosted tools it serves. Wire-specific
 * entry shapes and response projections live in per-dialect modules.
 *
 * @module shres-llm-pi-ai/hosted-tools
 */

import type { HostedTool } from '@shres-code/shres-code-llm'
import { toServerToolCallBlock } from '@shres-code/shres-code-llm'
import type { StreamChunk } from '@shres-code/shres-code-llm'
import { HOSTED_X_SEARCH_CALL_NAMES, hostedCallKind, LOCAL_WEB_SEARCH_NAME, webSearchToolEntry, xSearchToolEntry } from './openai-responses.ts'
import { openaiCompletionsDialect } from './openai-completions.ts'
import { markServerToolCallBlocks } from '../replay.ts'

export * from './openai-responses.ts'

/** The request-side splice facts the adapter applies per hosted-tools step. */
export interface HostedToolsSplice {
  /** Raw hosted tool entries appended to the outgoing `tools` array. */
  entries: readonly Record<string, unknown>[]
  /** Local function-tool names dropped while their hosted counterpart is enabled. */
  dropLocalTools: readonly string[]
}

/** The full plan one dialect derives from a model's effective hosted tools. */
export interface HostedToolsPlan extends HostedToolsSplice {
  /**
   * Call names a hosted tool may surface as ordinary tool calls. A call is
   * promoted to a `server-tool-call` block only when its name is listed here
   * and no client tool of that name is declared in the request that was sent;
   * see {@link promotableCallNames}.
   */
  callNames: readonly string[]
}

/**
 * Splice hosted tool entries into an outgoing payload and drop local function
 * tools they supersede. The name-collision policy is **hosted wins**: while a
 * hosted web search is enabled, the colliding local `web_search` function
 * tool is omitted from the request so the model can reach only the backend
 * tool. Returns `undefined` (pi-ai's keep-unchanged signal) when nothing
 * changed.
 * @param payload - the outgoing request params pi-ai built.
 * @param hosted - the hosted tool entries and the local tools they supersede.
 * @returns a payload with the merged hosted tools, or `undefined` to keep the original.
 */
export function applyHostedToolsPayload(
  payload: unknown,
  hosted: HostedToolsSplice,
): Record<string, unknown> | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const params = payload as Record<string, unknown>
  const drop = new Set(hosted.dropLocalTools)
  const entries = hosted.entries
  if (Array.isArray(params['tools'])) {
    const tools = params['tools'] as unknown[]
    const kept = tools.filter((tool) => {
      if (typeof tool !== 'object' || tool === null) return true
      const name = (tool as Record<string, unknown>)['name']
      return typeof name !== 'string' || !drop.has(name)
    })
    if (entries.length === 0 && kept.length === tools.length) return undefined
    return { ...params, tools: [...kept, ...entries] }
  }
  if (entries.length === 0) return undefined
  return { ...params, tools: [...entries] }
}

/**
 * The hosted call names to promote for one sent request: the plan's call
 * names minus every tool name the final outgoing `tools` array still declares
 * as a client tool. A declared name is a local tool the model may call, so a
 * call to it stays an ordinary tool call.
 * @param callNames - the plan's hosted call names.
 * @param payload - the final request body after every payload hook.
 * @returns the call names safe to treat as hosted.
 */
export function promotableCallNames(callNames: readonly string[], payload: unknown): ReadonlySet<string> {
  const declared = new Set<string>()
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const tools = (payload as Record<string, unknown>)['tools']
    if (Array.isArray(tools)) {
      for (const tool of tools as unknown[]) {
        if (typeof tool !== 'object' || tool === null) continue
        const name = (tool as Record<string, unknown>)['name']
        if (typeof name === 'string') declared.add(name)
      }
    }
  }
  return new Set(callNames.filter(name => !declared.has(name)))
}

/** Whether a chunk after a tool-call `block-start` belongs to a hosted call. */
function isHostedChunk(chunk: StreamChunk, isHosted: (name: string) => boolean): boolean {
  if (chunk.type === 'tool-call-delta') return chunk.name !== undefined && isHosted(chunk.name)
  if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') return isHosted(chunk.block.name)
  return false
}

/**
 * Rewrite a pi-ai stream so a hosted tool call that pi-ai surfaces as an
 * ordinary tool call becomes a `server-tool-call` block instead. The agent
 * loop's dispatch predicate keys on the `tool-call` tag, so promoting the
 * hosted name here is what keeps the loop from executing it. The tool-call
 * `block-start` is buffered until the first delta or end reveals the name, so
 * a hosted call is opened as `server-tool-call` and its streaming input JSON
 * is suppressed rather than rendered as a running local-style tool call.
 *
 * The promoted block's `kind` is the canonical hosted tool
 * ({@link hostedCallKind}), `name` and `id` keep the reported call, and
 * `status` is omitted because pi-ai's tool call reports none. The finish
 * chunk's replay envelope tags each promoted index `server-tool-call`, so a
 * later request replays the message without the hosted call.
 * @param chunks - the pi-ai stream chunks before hosting-aware mapping.
 * @param isHosted - whether a call name is promoted; read when each call's
 *   name is first seen, after the request payload was finalized.
 * @returns the stream with hosted tool-call blocks rewritten to `server-tool-call`.
 */
export async function* mapHostedToolCalls(
  chunks: AsyncIterable<StreamChunk>,
  isHosted: (name: string) => boolean,
): AsyncGenerator<StreamChunk> {
  let pendingStart: Extract<StreamChunk, { type: 'block-start' }> | undefined
  const promoted = new Set<number>()
  for await (const chunk of chunks) {
    if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') {
      pendingStart = chunk
      continue
    }
    if (pendingStart !== undefined) {
      const hosted = isHostedChunk(chunk, isHosted)
      if (hosted) promoted.add(pendingStart.index)
      yield hosted
        ? { type: 'block-start', index: pendingStart.index, blockType: 'server-tool-call' }
        : pendingStart
      pendingStart = undefined
    }
    if (chunk.type === 'tool-call-delta' && promoted.has(chunk.index)) {
      // A hosted call's input JSON is not a local tool invocation; suppress it.
      continue
    }
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call'
      && (promoted.has(chunk.index) || isHosted(chunk.block.name))) {
      promoted.add(chunk.index)
      yield {
        type: 'block-end',
        index: chunk.index,
        block: toServerToolCallBlock({
          kind: hostedCallKind(chunk.block.name),
          name: chunk.block.name,
          id: chunk.block.id,
        }),
      }
      continue
    }
    if (chunk.type === 'finish' && chunk.replayState !== undefined && promoted.size > 0) {
      yield { ...chunk, replayState: markServerToolCallBlocks(chunk.replayState, promoted) }
      continue
    }
    yield chunk
  }
}

/**
 * One wire protocol's hosted-tool support: which tools it can serve on the
 * wire and how a model's effective declarations become a splice plan.
 */
export interface HostedToolDialect {
  /** Hosted tools this dialect can serve; a declaration beyond them fails resolution. */
  readonly served: readonly HostedTool[]
  /**
   * Derive the splice plan for one model's effective hosted tools.
   * @param tools - the effective hosted tools resolution computed for the model.
   * @returns the entries to splice, local tools to drop, and hosted call names.
   */
  spliceFor(tools: readonly HostedTool[]): HostedToolsPlan
}

/** The `openai-responses` dialect: the hosted tools Grok and xAI proxies serve. */
const openaiResponsesDialect: HostedToolDialect = {
  served: ['web_search', 'x_search'],
  spliceFor(tools) {
    const entries: Record<string, unknown>[] = []
    const dropLocalTools: string[] = []
    const callNames: string[] = []
    if (tools.includes('web_search')) {
      entries.push(webSearchToolEntry())
      // hosted wins: the colliding local web_search function tool is omitted
      dropLocalTools.push(LOCAL_WEB_SEARCH_NAME)
    }
    if (tools.includes('x_search')) {
      entries.push(xSearchToolEntry())
      // pi-ai surfaces each hosted X custom tool call as a tool call; hosted
      // wins, so client function tools with those names are omitted
      callNames.push(...HOSTED_X_SEARCH_CALL_NAMES)
      dropLocalTools.push(...HOSTED_X_SEARCH_CALL_NAMES)
    }
    return { entries, dropLocalTools, callNames }
  },
}

/** Hosted-tool dialects by pi-ai api id; protocols without an entry serve none. */
const DIALECTS: Readonly<Record<string, HostedToolDialect>> = {
  'openai-responses': openaiResponsesDialect,
  'openai-completions': openaiCompletionsDialect,
}

/**
 * The hosted-tool dialect for one wire protocol.
 * @param api - the model's resolved pi-ai api id.
 * @returns the dialect, or `undefined` when the protocol serves no hosted tools.
 */
export function hostedToolsDialectFor(api: string): HostedToolDialect | undefined {
  return DIALECTS[api]
}
