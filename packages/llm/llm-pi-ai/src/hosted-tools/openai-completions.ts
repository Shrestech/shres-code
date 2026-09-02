/**
 * Hosted-tool wire facts for the `openai-completions` dialect as z.ai serves
 * it: the request-side `web_search` tool entry (a fixed engine code, the same
 * external spec `web-search-attached-cli` sends) and the splice plan for it.
 * The response surface carries no search artifact — z.ai executes the search
 * server-side and folds it into the answer text — so no call names surface
 * and nothing is promoted; the search's existence rides the billing, the
 * answer text, and this declaration.
 *
 * @module @shres-code/shres-code-llm-pi-ai/hosted-tools/openai-completions
 */

import type { HostedTool } from '@shres-code/shres-code-llm'
import type { HostedToolDialect, HostedToolsPlan } from './index.ts'

/**
 * z.ai's search engine code for the `web_search` tool entry. An
 * external-spec constant the endpoint defines, not a deployment tunable.
 */
const ZAI_SEARCH_ENGINE = 'search-prime'

/** The local `tool-web` function-tool name a hosted web search supersedes. */
const LOCAL_WEB_SEARCH_NAME = 'web_search'

/**
 * The splice plan for one model's effective hosted tools on an
 * `openai-completions` route.
 * @param tools - the effective hosted tools resolution computed for the model.
 * @returns the entry to splice and the local tool it supersedes; z.ai
 *   surfaces no hosted tool calls, so `callNames` is always empty.
 */
function spliceFor(tools: readonly HostedTool[]): HostedToolsPlan {
  const entries: Record<string, unknown>[] = []
  const dropLocalTools: string[] = []
  if (tools.includes('web_search')) {
    entries.push({ type: 'web_search', web_search: { search_engine: ZAI_SEARCH_ENGINE } })
    // hosted wins: the colliding local web_search function tool is omitted
    dropLocalTools.push(LOCAL_WEB_SEARCH_NAME)
  }
  return { entries, dropLocalTools, callNames: [] }
}

/** The `openai-completions` dialect: z.ai's hosted web search. */
export const openaiCompletionsDialect: HostedToolDialect = {
  served: ['web_search'],
  spliceFor,
}
