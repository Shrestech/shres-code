/**
 * The model-facing `deep_research` tool: multi-source synthesis with citations.
 * Execution goes through `ctx.web` with a request-level pin to the Perplexity
 * search provider. This module owns the schema, prompt guidance, and timeout
 * budget; presentation reuses the search card.
 */

import type { Context } from '@shres-code/cordis'
import { defineTool } from '@shres-code/shres-code-tools'
import type {} from '@shres-code/shres-code-system-prompt'
import {
  formatSearchOutput,
  parseSearchArgs,
  presentSearchCall,
  presentSearchResult,
  SEARCH_TOOL_OUTPUT_SCHEMA,
  searchMetaFromValue,
  searchToolValue,
} from './search.ts'

/** Stable search-provider id this tool pins on every call. */
export const DEEP_RESEARCH_PROVIDER_ID = 'perplexity'

/**
 * Register the `deep_research` tool and its system-prompt guidance.
 *
 * @param ctx - context whose `tools` and `systemPrompt` registries receive the
 *   registrations; both are effect-scoped and unregister on plugin dispose.
 * @param maxResults - the deployment's source cap, sent as every seam
 *   request's `maxResults`.
 * @param timeoutMs - the cooperative tool-call budget (ms) attached as the tool's
 *   `ToolDefinition.timeoutMs` for `@shres-code/shres-code-tool-call-timeout-policy` to enforce.
 * @param searchEnabled - whether the same composition exposes `web_search`.
 * @param fetchEnabled - whether the same composition exposes `web_fetch`.
 */
export function applyDeepResearchTool(
  ctx: Context,
  maxResults: number,
  timeoutMs: number,
  searchEnabled: boolean,
  fetchEnabled: boolean,
): void {
  ctx.systemPrompt.section({
    name: 'tool:deep_research',
    order: 112,
    text: deepResearchGuidance(searchEnabled, fetchEnabled),
  })

  ctx.tools.register(defineTool({
    name: 'deep_research',
    description: 'Perplexity deep web research: synthesize a multi-source research answer with citations. Not for routine queries.',
    parameters: {
      query: { type: 'string', required: true, description: 'The research question.' },
    },
    output: {
      schema: SEARCH_TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatSearchOutput(value) }],
      presentationMeta: (_args, value) => searchMetaFromValue(value),
    },
    timeoutMs,
    // Provider reads do not mutate parent-agent state.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseSearchArgs(args)
      const result = await ctx.web.search(
        { query: input.query, maxResults, provider: DEEP_RESEARCH_PROVIDER_ID },
        exec.signal,
      )
      return searchToolValue(result)
    },
    presentCall: presentSearchCall,
    presentResult: (args, result) => presentSearchResult(args, result),
  }))
}

/**
 * Model-facing guidance for `deep_research`. Mentions `web_search` and
 * `web_fetch` by name only when those tools are also config-enabled.
 *
 * @param searchEnabled - whether `web_search` is registered in this composition.
 * @param fetchEnabled - whether `web_fetch` is registered in this composition.
 * @returns the prompt-section text.
 */
export function deepResearchGuidance(searchEnabled: boolean, fetchEnabled: boolean): string {
  const head = 'Use the deep_research tool for Perplexity deep web research: multi-source synthesis with citations when depth matters. Do not use it for routine queries.'
  if (searchEnabled && fetchEnabled) {
    return `${head} Use web_search for a quick factual lookup and web_fetch to read a specific page.`
  }
  if (searchEnabled) return `${head} Use web_search for a quick factual lookup.`
  if (fetchEnabled) return `${head} Use web_fetch to read a specific page.`
  return head
}
