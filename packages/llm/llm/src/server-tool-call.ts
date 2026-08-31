/**
 * The one bounded construction path for the `server-tool-call` content block.
 *
 * The block records a provider-backend-executed tool call for logging and
 * generic rendering; the agent loop never dispatches it. This module is the
 * single seam that projects provider-neutral hosted-call facts into the typed,
 * bounded block, so the later hosted-search inbound mapping and presenter both
 * build through it and cannot disagree on field shape or result bounds.
 *
 * @module @shres-code/shres-code-llm/server-tool-call
 */

import { CallId } from './brand.ts'
import type { ServerToolCallBlock, ServerToolResult } from './types.ts'

/** Upper bound on result entries one `server-tool-call` block may carry. */
export const MAX_SERVER_TOOL_CALL_RESULTS = 10

/**
 * Bounded provider-neutral hosted-call facts accepted by
 * {@link toServerToolCallBlock}: the hosted tool identity, its completion
 * state, and up to {@link MAX_SERVER_TOOL_CALL_RESULTS} result entries.
 */
export interface ServerToolCallInput {
  /** Hosted-tool category reported by the provider (for example `'web_search'`). */
  kind: string
  /** Hosted-tool name when distinct from {@link ServerToolCallInput.kind}. */
  name?: string
  /** Provider-issued call id for the hosted invocation, when reported. */
  id?: string
  /** Provider-neutral completion state of the hosted call. */
  status: 'completed' | 'failed'
  /** Provider-neutral result entries; the tail past the bound is dropped. */
  results?: readonly {
    title?: string
    url?: string
    snippet?: string
  }[]
}

/** Trim one optional string to non-empty, or drop it. */
function stringField(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

/** Normalize one hosted-call result entry, dropping a wholly-empty entry. */
function normalizeResult(
  entry: { title?: string; url?: string; snippet?: string },
): ServerToolResult | undefined {
  const title = stringField(entry.title)
  const url = stringField(entry.url)
  const snippet = stringField(entry.snippet)
  if (title === undefined && url === undefined && snippet === undefined) return undefined
  return Object.freeze({
    ...title === undefined ? {} : { title },
    ...url === undefined ? {} : { url },
    ...snippet === undefined ? {} : { snippet },
  })
}

/**
 * Project provider-neutral hosted-call facts into an immutable
 * `server-tool-call` content block, bounding and trimming every field.
 * @param input - the hosted tool identity, completion state, and optional
 *   result entries; results beyond {@link MAX_SERVER_TOOL_CALL_RESULTS} are
 *   dropped and empty/whitespace strings are omitted.
 * @returns a frozen `server-tool-call` block (block, results array, and each
 *   result entry are all frozen) safe to log and render.
 */
export function toServerToolCallBlock(input: ServerToolCallInput): ServerToolCallBlock {
  const kind = input.kind.trim()
  if (kind.length === 0) throw new TypeError('server-tool-call needs a non-empty hosted tool kind')
  const name = stringField(input.name)
  const id = stringField(input.id)
  const results = (input.results ?? [])
    .slice(0, MAX_SERVER_TOOL_CALL_RESULTS)
    .map(normalizeResult)
    .filter((entry): entry is ServerToolResult => entry !== undefined)
  // Object.freeze widens the literal to Readonly<> (readonly results), while
  // ServerToolCallBlock declares a mutable results array like ToolResultBlock;
  // the runtime object is exactly the typed block, frozen.
  return Object.freeze({
    type: 'server-tool-call',
    kind,
    ...name === undefined ? {} : { name },
    ...id === undefined ? {} : { id: CallId(id) },
    status: input.status,
    ...results.length === 0 ? {} : { results: Object.freeze(results) },
  }) as ServerToolCallBlock
}
