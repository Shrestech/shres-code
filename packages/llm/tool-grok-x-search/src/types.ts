/**
 * Types for the Grok X search tools: tool names and the durable pre-dispatch
 * request record. Types only.
 * @module @shres-code/shres-code-tool-grok-x-search/types
 */

import type { CallId, HostedTool, Message } from '@shres-code/shres-code-llm'

/** Model-facing names of the four X search tools. */
export type GrokXToolName = 'x_keyword_search' | 'x_semantic_search' | 'x_user_search' | 'x_thread_fetch'

/** Exact route of one auxiliary X search request. */
export interface GrokXSearchRoute {
  /** Provider route; always the grok-session route. */
  readonly provider: string
  /** Configured Grok model id. */
  readonly model: string
}

/**
 * Everything one auxiliary X search request sends to the model, recorded on
 * the calling agent's session before the request is dispatched.
 */
export interface GrokXSearchRequestEventData {
  /** Tool whose call produced the request. */
  readonly tool: GrokXToolName
  /** Tool call id in the calling session. */
  readonly callId: CallId
  /** Exact provider route and model. */
  readonly route: GrokXSearchRoute
  /** Exact system prompt. */
  readonly system: string
  /** Exact message list. */
  readonly messages: Message[]
  /** Exact hosted-tool narrowing; always `['x_search']`. */
  readonly hostedTools: readonly HostedTool[]
  /** Exact output-token cap. */
  readonly maxTokens: number
}

declare module '@shres-code/shres-code-session/types' {
  interface SessionEventMap {
    /**
     * Log-only record of one auxiliary Grok X search request, appended to the
     * calling agent's session before the request is dispatched. The request
     * is not part of the calling conversation; the tool result carries what
     * the calling model sees. Writers pass `{ ignorable: true }`.
     * @param tool - tool whose call produced the request.
     * @param callId - tool call id in the calling session.
     * @param route - exact provider route and model.
     * @param system - exact system prompt.
     * @param messages - exact message list.
     * @param hostedTools - exact hosted-tool narrowing, `['x_search']`.
     * @param maxTokens - exact output-token cap.
     */
    'grok-x-search/request': GrokXSearchRequestEventData
  }
}
