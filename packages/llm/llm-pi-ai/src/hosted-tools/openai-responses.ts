/**
 * Hosted-tool wire facts for the `openai-responses` dialect: the tool-array
 * entries Grok and xAI proxies expect and the response-side projections of
 * the `web_search_call` and hosted `custom_tool_call` output items into the
 * bounded `server-tool-call` block. Tool names and entry JSON mirror the Grok
 * Build CLI's own sampler (crates/codegen/xai-grok-sampling-types), so the
 * harness speaks the same wire a signed-in `grok` CLI does.
 *
 * @module @shres-code/shres-code-llm-pi-ai/hosted-tools/openai-responses
 */

import { toServerToolCallBlock } from '@shres-code/shres-code-llm'
import type { ServerToolCallBlock, ServerToolResult } from '@shres-code/shres-code-llm'

/** Wire name of the hosted Responses `web_search` tool. */
export const HOSTED_WEB_SEARCH_NAME = 'web_search'
/** Wire name of the hosted Responses `x_search` tool. */
export const HOSTED_X_SEARCH_NAME = 'x_search'

/**
 * Call names the backend reports for the one hosted `x_search` tool entry.
 * Grok's sampler executes each as a `custom_tool_call` and normalizes them to
 * `x_search` (grok-build `xai-grok-sampler/src/stream/responses.rs`); its
 * pager recognizes the four subtypes (`xai-grok-pager/src/acp/tracker.rs`).
 * A name outside this list is not treated as hosted.
 */
export const HOSTED_X_SEARCH_CALL_NAMES: readonly string[] = Object.freeze([
  HOSTED_X_SEARCH_NAME,
  'x_keyword_search',
  'x_semantic_search',
  'x_user_search',
  'x_thread_fetch',
])

/**
 * The canonical `server-tool-call` kind for one hosted call name: `x_search`
 * for every member of {@link HOSTED_X_SEARCH_CALL_NAMES}, otherwise the name.
 * @param name - the call name the backend reported.
 * @returns the hosted tool kind to record.
 */
export function hostedCallKind(name: string): string {
  return HOSTED_X_SEARCH_CALL_NAMES.includes(name) ? HOSTED_X_SEARCH_NAME : name
}

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

/** The reported completion state, or `undefined` when the item carries none. */
function statusOf(value: unknown): 'completed' | 'failed' | undefined {
  return value === 'completed' || value === 'failed' ? value : undefined
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
  const status = statusOf(item.status)
  return toServerToolCallBlock({
    kind: HOSTED_WEB_SEARCH_NAME,
    ...id === undefined ? {} : { id },
    ...status === undefined ? {} : { status },
    results,
  })
}

/**
 * Project a Responses `custom_tool_call` output item for a hosted custom tool
 * into a bounded `server-tool-call` block. Caller must only supply an item
 * whose `name` is a hosted call name (for example `x_keyword_search`); a
 * local custom tool keeps mapping to an ordinary tool call. The block's
 * `kind` is {@link hostedCallKind} of that name and `name` keeps the
 * subtype; `status` is present only when the item reports one.
 * @param item - the `custom_tool_call` output item the backend executed.
 * @param hostedName - the hosted call name the item's `name` field carries.
 * @returns the frozen block recording the hosted invocation.
 */
export function hostedCustomToolCallToServerToolCall(
  item: HostedCustomToolCallItem,
  hostedName: string,
): ServerToolCallBlock {
  const id = stringOf(item.call_id) ?? stringOf(item.id)
  const status = statusOf(item.status)
  return toServerToolCallBlock({
    kind: hostedCallKind(hostedName),
    name: hostedName,
    ...id === undefined ? {} : { id },
    ...status === undefined ? {} : { status },
  })
}
