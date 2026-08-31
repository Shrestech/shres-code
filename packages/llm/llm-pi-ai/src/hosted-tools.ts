/**
 * Provider-neutral hosted-search wire helpers for the `openai-responses`
 * dialect that Grok and xAI proxies serve.
 *
 * The provider backend executes a hosted search on the model's behalf; this
 * module only (a) builds the tool-array entries the request must carry, (b)
 * splices them into the outgoing payload while dropping a colliding local
 * `web_search` function tool, and (c) projects the response-side output items
 * into the bounded `server-tool-call` block through the single
 * {@link toServerToolCallBlock} seam. Tool names and entry JSON mirror the
 * Grok Build CLI's own sampler (crates/codegen/xai-grok-sampling-types), so
 * the harness speaks the same wire a signed-in `grok` CLI does.
 *
 * @module @shres-code/shres-code-llm-pi-ai/hosted-tools
 */

import { toServerToolCallBlock } from '@shres-code/shres-code-llm'
import type { ServerToolCallBlock, ServerToolResult, StreamChunk } from '@shres-code/shres-code-llm'

/** Wire name of the hosted Responses `web_search` tool. */
export const HOSTED_WEB_SEARCH_NAME = 'web_search'
/** Wire name of the hosted Responses `x_search` tool. */
export const HOSTED_X_SEARCH_NAME = 'x_search'

/** The local `tool-web` function-tool name a hosted web search supersedes. */
export const LOCAL_WEB_SEARCH_NAME = 'web_search'

/** One source a hosted web search's `action.sources` array reports. */
export interface WebSearchCallSource {
  /** Source heading supplied by the hosted search. */
  title?: unknown
  /** Provider-returned location of the source. */
  url?: unknown
  /** Short excerpt supplied by the hosted search. */
  snippet?: unknown
}

/** The search action a `web_search_call` item carries. */
export interface WebSearchCallAction {
  /** Action discriminator; the hosted search uses `'search'`. */
  type?: unknown
  /** The query the backend executed. */
  query?: unknown
  /** Source entries the backend search produced. */
  sources?: readonly WebSearchCallSource[]
}

/** A Responses `web_search_call` output item (server-executed web search). */
export interface HostedWebSearchCallItem {
  type: 'web_search_call'
  /** Provider-issued item id. */
  id?: unknown
  /** Provider-reported completion state. */
  status?: unknown
  /** The search action the backend executed. */
  action?: WebSearchCallAction
}

/** A Responses `custom_tool_call` output item for a hosted custom tool. */
export interface HostedCustomToolCallItem {
  type: 'custom_tool_call'
  /** Provider-issued item id (`id`) and call id (`call_id`). */
  id?: unknown
  call_id?: unknown
  /** Custom-tool name the provider executed (for example `x_search`). */
  name?: unknown
  /** Provider-reported completion state. */
  status?: unknown
}

/** The pure string of an optional wire value, or `undefined`. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Project one source entry, dropping a wholly-empty one. */
function resultOf(entry: unknown): ServerToolResult | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const record = entry as Record<string, unknown>
  const title = stringOf(record['title'])
  const url = stringOf(record['url'])
  const snippet = stringOf(record['snippet'])
  if (title === undefined && url === undefined && snippet === undefined) return undefined
  return {
    ...title === undefined ? {} : { title },
    ...url === undefined ? {} : { url },
    ...snippet === undefined ? {} : { snippet },
  }
}

/**
 * The web search tool entry spliced into the Responses `tools` array,
 * mirroring grok-build's default.
 * @returns the raw `web_search` tool entry JSON.
 */
export function webSearchToolEntry(): Record<string, unknown> {
  return { type: HOSTED_WEB_SEARCH_NAME }
}

/**
 * The x search tool entry spliced into the Responses `tools` array, mirroring
 * grok-build's default.
 * @returns the raw `x_search` tool entry JSON.
 */
export function xSearchToolEntry(): Record<string, unknown> {
  return { type: HOSTED_X_SEARCH_NAME }
}

/** The request-side splice facts the adapter applies per hosted-search step. */
export interface HostedToolsSplice {
  /** Raw hosted tool entries appended to the outgoing `tools` array. */
  entries: readonly Record<string, unknown>[]
  /** Local function-tool names dropped while their hosted counterpart is enabled. */
  dropLocalTools: readonly string[]
}

/**
 * Splice hosted tool entries into an outgoing Responses payload and drop local
 * function tools they supersede. The name-collision policy is **hosted wins**:
 * while a hosted web search is enabled, the colliding local `web_search`
 * function tool is omitted from the request so the model can reach only the
 * backend tool. Returns `undefined` (pi-ai's keep-unchanged signal) when
 * nothing changed.
 * @param payload - the outgoing response params pi-ai built.
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
 * Project a Responses `web_search_call` output item into a bounded
 * `server-tool-call` block, carrying the backend's `action.sources` as
 * result entries. This is the live seam for a server-executed web search once
 * a producer surfaces the item; the pinned pi-ai dependency drops
 * `web_search_call` before the harness sees it, so today this converter is
 * exercised by tests and ready for a pi-ai change or a raw-wire read.
 * @param item - the `web_search_call` output item the backend returned.
 * @returns the frozen block carrying the backend's bounded source entries.
 */
export function webSearchCallToServerToolCall(item: HostedWebSearchCallItem): ServerToolCallBlock {
  const sources = item.action?.sources
  const results = (Array.isArray(sources) ? sources : [])
    .map(resultOf)
    .filter((entry): entry is ServerToolResult => entry !== undefined)
  const id = stringOf(item.id)
  return toServerToolCallBlock({
    kind: HOSTED_WEB_SEARCH_NAME,
    ...id === undefined ? {} : { id },
    status: item.status === 'failed' ? 'failed' : 'completed',
    results,
  })
}

/**
 * Project a Responses `custom_tool_call` output item for a hosted custom tool
 * into a bounded `server-tool-call` block. Caller must only supply an item
 * whose `name` is a hosted tool (for example `x_search`); a local custom
 * tool keeps mapping to an ordinary tool call.
 * @param item - the `custom_tool_call` output item the backend executed.
 * @param hostedName - the hosted tool name the item's `name` field carries.
 * @returns the frozen block recording the hosted invocation.
 */
export function hostedCustomToolCallToServerToolCall(
  item: HostedCustomToolCallItem,
  hostedName: string,
): ServerToolCallBlock {
  const id = stringOf(item.call_id) ?? stringOf(item.id)
  return toServerToolCallBlock({
    kind: hostedName,
    name: hostedName,
    ...id === undefined ? {} : { id },
    status: item.status === 'failed' ? 'failed' : 'completed',
  })
}

/** Whether a chunk after a tool-call `block-start` belongs to a hosted call. */
function isHostedChunk(chunk: StreamChunk, hostedNames: ReadonlySet<string>): boolean {
  if (chunk.type === 'tool-call-delta') return chunk.name !== undefined && hostedNames.has(chunk.name)
  if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') return hostedNames.has(chunk.block.name)
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
 * @param chunks - the pi-ai stream chunks before hosting-aware mapping.
 * @param hostedNames - hosted tool names to promote; other calls pass through.
 * @returns the stream with hosted tool-call blocks rewritten to `server-tool-call`.
 */
export async function* mapHostedToolCalls(
  chunks: AsyncIterable<StreamChunk>,
  hostedNames: ReadonlySet<string>,
): AsyncGenerator<StreamChunk> {
  let pendingStart: Extract<StreamChunk, { type: 'block-start' }> | undefined
  for await (const chunk of chunks) {
    if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') {
      pendingStart = chunk
      continue
    }
    if (pendingStart !== undefined) {
      yield isHostedChunk(chunk, hostedNames)
        ? { type: 'block-start', index: pendingStart.index, blockType: 'server-tool-call' }
        : pendingStart
      pendingStart = undefined
    }
    if (chunk.type === 'tool-call-delta' && chunk.name !== undefined && hostedNames.has(chunk.name)) {
      // A hosted call's input JSON is not a local tool invocation; suppress it.
      continue
    }
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call' && hostedNames.has(chunk.block.name)) {
      yield {
        type: 'block-end',
        index: chunk.index,
        block: toServerToolCallBlock({
          kind: chunk.block.name,
          name: chunk.block.name,
          id: chunk.block.id,
          // pi-ai's toolCall carries no completion status, so a hosted call is
          // recorded completed even when the backend failed it.
          status: 'completed',
        }),
      }
      continue
    }
    yield chunk
  }
}
