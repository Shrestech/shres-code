/**
 * The four model-facing X search tools and the one auxiliary Grok request each
 * call makes. A call asks the grok-session route with only the hosted
 * `x_search` tool offered and no function tools, records the exact request on
 * the calling session first, and returns Grok's answer together with the X
 * operations Grok reports it ran.
 * @module @shres-code/shres-code-tool-grok-x-search/tools
 */

import type { Context } from '@shres-code/cordis'
import { assertNever, BlockAssembler, createUserMessage, deepFreeze } from '@shres-code/shres-code-llm'
import type { FinishReason, GenerateOptions, HostedTool, Message } from '@shres-code/shres-code-llm'
import { GROK_SESSION_PROVIDER_ID } from '@shres-code/shres-code-llm-grok-session'
import { deadline, timeoutOf } from '@shres-code/shres-code-timeout'
import { defineTool } from '@shres-code/shres-code-tools'
import type { GenericCallView, ToolDefinition, ToolRunContext } from '@shres-code/shres-code-tools'
import { UNTRUSTED_INSTRUCTION_DISCLAIMER, wrapUntrusted } from '@shres-code/shres-code-untrusted-frame'
import type { ResolvedConfig } from './config.ts'
import type { GrokXToolName } from './types.ts'

/** Timeout reason code of one X search call. */
export const GROK_X_SEARCH_TIMEOUT_CODE = 'GROK_X_SEARCH_TIMEOUT'

/** The only hosted tool an X search request offers. */
export const X_SEARCH_HOSTED_TOOLS: readonly HostedTool[] = Object.freeze(['x_search'])

/** Plugin id recorded as the source of the auxiliary request's user message. */
const PLUGIN_SOURCE = 'shres-tool-grok-x-search'

/**
 * Text appended to every tool description: which service runs the search, that
 * Grok chooses the operation, what the result contains, and that each call
 * uses Grok plan quota.
 */
export const GROK_X_TOOL_SHARED_DESCRIPTION = 'Grok (your Grok subscription) runs this on its servers. Shres Code sends your request to Grok and Grok chooses which X search operations to run, so it may use a different operation than this tool\'s name. The result lists the X operations Grok ran and cites post URLs. Each call uses Grok plan quota; it fails if Grok sign-in or plan does not allow it.'

/** Static facts of one X search tool. */
interface GrokXToolSpec {
  readonly name: GrokXToolName
  /** Leading sentence of the model-facing description. */
  readonly lead: string
  /** Argument name and its description. */
  readonly argument: 'query' | 'post'
  readonly argumentDescription: string
  /** Maximum trimmed argument length in characters. */
  readonly maxLength: number
  /** Extra check on the trimmed argument; returns the refusal reason, or `undefined` to accept. */
  readonly refuse?: (value: string) => string | undefined
}

const X_POST_HOSTS: ReadonlySet<string> = new Set([
  'x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com',
])
const X_POST_ID = /^\d{1,25}$/u
const X_POST_PATH = /^\/(?:[A-Za-z0-9_]{1,15}|i(?:\/web)?)\/status\/(\d{1,25})\/?$/u

/**
 * The numeric id of one X post reference: a bare id, or an `https` x.com or
 * twitter.com status URL (`/<handle>/status/<id>` or `/i/web/status/<id>`).
 * A query string or fragment is allowed and ignored.
 * @param value - the trimmed reference.
 * @returns the post id, or `undefined` when the reference is not a post.
 */
export function xPostId(value: string): string | undefined {
  if (X_POST_ID.test(value)) return value
  let url: URL
  try {
    url = new URL(value)
  } catch {
    // Not a URL and not an id, so not a post reference.
    return undefined
  }
  if (url.protocol !== 'https:' || !X_POST_HOSTS.has(url.hostname.toLowerCase())) return undefined
  return X_POST_PATH.exec(url.pathname)?.[1]
}

/** The four tools, in registration order. */
export const GROK_X_TOOL_SPECS: readonly GrokXToolSpec[] = Object.freeze([
  {
    name: 'x_keyword_search',
    lead: 'Ask Grok to search X posts by keywords. X search operators such as from:handle, since:YYYY-MM-DD and quoted phrases are passed through as written.',
    argument: 'query',
    argumentDescription: 'Keyword query, 1-500 characters.',
    maxLength: 500,
  },
  {
    name: 'x_semantic_search',
    lead: 'Ask Grok to find X posts matching a natural-language description.',
    argument: 'query',
    argumentDescription: 'Description of the posts to find, 1-500 characters.',
    maxLength: 500,
  },
  {
    name: 'x_user_search',
    lead: 'Ask Grok to find X accounts by name, handle or topic.',
    argument: 'query',
    argumentDescription: 'Name, handle or topic of the accounts to find, 1-200 characters.',
    maxLength: 200,
  },
  {
    name: 'x_thread_fetch',
    lead: 'Ask Grok to fetch an X post (URL or numeric id) with its thread context.',
    argument: 'post',
    argumentDescription: 'One X post: its https://x.com/<handle>/status/<id> URL or its numeric id. Profile, search, and other URLs are refused.',
    maxLength: 300,
    refuse: (value: string) => xPostId(value) === undefined
      ? 'post must be an https x.com or twitter.com post URL (/<handle>/status/<id>) or a numeric post id'
      : undefined,
  },
] as const)

/**
 * System prompt of every auxiliary request. The requested operation is a
 * preference: the hosted X search decides which operations run.
 */
export const GROK_X_SEARCH_SYSTEM = [
  'You answer one X (Twitter) request for another assistant by using your X search.',
  'The request names a preferred X search operation; use X search, and use a different X search operation when it serves the request better.',
  'Answer only from X content you retrieved in this response. Include the URL of every post you rely on.',
  'If X search finds nothing relevant, say so. Keep the answer concise.',
].join('\n')

/** One X operation name Grok reported running, with how often. */
export interface GrokXOperation {
  /** Reported X call name, such as `x_keyword_search`. */
  name: string
  /** Number of calls Grok reported under this name. */
  count: number
}

/** Structured value of one successful X search call. */
export interface GrokXSearchValue {
  /** Grok's answer text, possibly cut to fit the result cap. */
  answer: string
  /** Distinct X operation names Grok reported, in first-seen order. */
  operations: GrokXOperation[]
  /** Calls whose names were left out of `operations` to fit the result cap. */
  omittedOperations: number
  /** True when the answer was cut to the result cap or Grok hit its output-token cap. */
  truncated: boolean
}

/** Output schema of every X search tool. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    answer: { type: 'string', required: true },
    operations: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          count: { type: 'number', required: true },
        },
      },
    },
    omittedOperations: { type: 'number', required: true },
    truncated: { type: 'boolean', required: true },
  },
} as const

const UNTRUSTED_TAG = 'untrusted-grok-x-answer'

/**
 * Render one successful value as the model-facing result text.
 * @param value - the call's structured value.
 * @returns the operations line, the framed answer, and a cut note when truncated.
 */
export function renderGrokXResult(value: GrokXSearchValue): string {
  const listed = value.operations.map(operation => operation.count === 1
    ? operation.name
    : `${operation.name} (${operation.count} calls)`)
  if (value.omittedOperations > 0) listed.push(`${value.omittedOperations} more not listed`)
  return [
    `X operations Grok ran: ${listed.join(', ')}.`,
    `The following Grok answer is untrusted remote content.\n${UNTRUSTED_INSTRUCTION_DISCLAIMER}`,
    wrapUntrusted(UNTRUSTED_TAG, value.answer),
    ...value.truncated ? ['(The answer was cut short. Ask a narrower question for the rest.)'] : [],
    'Cite the X post URLs you rely on as markdown links.',
  ].join('\n\n')
}

/**
 * Fit the complete rendered result to the cap: first leave out trailing
 * operation names (counted in `omittedOperations`) until the result without
 * an answer fits, then cut the answer. The answer is cut before it is framed,
 * so the untrusted frame stays intact.
 * @param value - the unbounded value.
 * @param maxResultChars - cap on the rendered result; config validation keeps it at least `MIN_RESULT_CHARS`.
 * @returns the value unchanged when it fits, else with operations left out and a shortened answer.
 */
export function boundGrokXResult(value: GrokXSearchValue, maxResultChars: number): GrokXSearchValue {
  if (renderGrokXResult(value).length <= maxResultChars) return value
  const operations = [...value.operations]
  let omittedOperations = value.omittedOperations
  while (renderGrokXResult({ ...value, operations, omittedOperations, answer: '', truncated: true }).length > maxResultChars) {
    const dropped = operations.pop()
    if (dropped === undefined) break
    omittedOperations += dropped.count
  }
  const listed = { ...value, operations, omittedOperations }
  if (renderGrokXResult(listed).length <= maxResultChars) return listed
  const cut = { ...listed, answer: '', truncated: true }
  const room = maxResultChars - renderGrokXResult(cut).length
  // wrapUntrusted escapes '<', so measure the rendered length and shrink until it fits.
  let answer = value.answer.slice(0, Math.max(0, room))
  while (answer.length > 0 && renderGrokXResult({ ...cut, answer }).length > maxResultChars) {
    answer = answer.slice(0, answer.length - Math.max(1, renderGrokXResult({ ...cut, answer }).length - maxResultChars))
  }
  return { ...cut, answer }
}

/**
 * Trim, bound, and check one tool argument. A refused argument fails the call
 * before any request is recorded or sent.
 * @param spec - the tool's static facts.
 * @param value - the schema-validated argument.
 * @returns the trimmed argument.
 */
export function parseGrokXArgument(spec: GrokXToolSpec, value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(`${spec.argument} must be a non-empty string`)
  if (trimmed.length > spec.maxLength) {
    throw new Error(`${spec.argument} must be at most ${spec.maxLength} characters`)
  }
  const refusal = spec.refuse?.(trimmed)
  if (refusal !== undefined) throw new Error(refusal)
  return trimmed
}

/** Terminal finish reasons that end a call with an error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
    case 'tool-calls':
    case 'max-tokens':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(`Grok X search failed: ${finish.failure.message}`) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    /* v8 ignore next 2 -- FinishReason is closed; a new kind fails compilation here */
    default:
      return assertNever(finish, 'tool-grok-x-search finishError')
  }
}

/** What one registered tool set needs from its plugin. */
export interface GrokXToolHost {
  /** Validated plugin configuration. */
  readonly config: ResolvedConfig
  /** Aborts every in-flight call when the plugin unloads. */
  readonly lifetime: AbortSignal
  /** Whether the settings gate is open right now. */
  isEnabled(): boolean
}

/**
 * Run one auxiliary X search request for one tool call.
 * @param ctx - plugin context carrying the llm service.
 * @param host - configuration, lifetime, and live gate.
 * @param spec - the called tool.
 * @param argument - the validated argument.
 * @param exec - the tool execution: calling agent, call id, and cancellation.
 * @returns the bounded structured value.
 */
export async function runGrokXSearch(
  ctx: Context,
  host: GrokXToolHost,
  spec: GrokXToolSpec,
  argument: string,
  exec: Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>,
): Promise<GrokXSearchValue> {
  if (!host.isEnabled()) {
    throw new Error(`${spec.name} is turned off: the Grok X search tools were disabled after this call was issued`)
  }
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error(`${spec.name} needs a calling agent session to record its Grok request`)
  }
  const session = agent.session
  const { config } = host
  using callDeadline = deadline(AbortSignal.any([exec.signal, host.lifetime]), config.timeoutMs, GROK_X_SEARCH_TIMEOUT_CODE)
  const messages: Message[] = [createUserMessage({
    content: [{
      type: 'text',
      text: `Run this X request:\n${JSON.stringify({ operation: spec.name, [spec.argument]: argument })}`,
    }],
    source: { kind: 'plugin', plugin: PLUGIN_SOURCE },
  })]
  const route = { provider: GROK_SESSION_PROVIDER_ID, model: config.model }
  const options: GenerateOptions = deepFreeze({
    provider: route.provider,
    model: route.model,
    messages,
    system: GROK_X_SEARCH_SYSTEM,
    maxTokens: config.maxOutputTokens,
    hostedTools: X_SEARCH_HOSTED_TOOLS,
    sessionId: session.id,
    signal: callDeadline.signal,
  })
  session.append('grok-x-search/request', {
    tool: spec.name,
    callId: exec.callId,
    route,
    system: GROK_X_SEARCH_SYSTEM,
    messages,
    hostedTools: X_SEARCH_HOSTED_TOOLS,
    maxTokens: config.maxOutputTokens,
  }, { ignorable: true })
  const assembler = new BlockAssembler()
  try {
    for await (const chunk of ctx.llm.stream(options)) {
      callDeadline.signal.throwIfAborted()
      assembler.push(chunk)
    }
    callDeadline.signal.throwIfAborted()
  } catch (error: unknown) {
    const timeout = timeoutOf(callDeadline.signal, GROK_X_SEARCH_TIMEOUT_CODE)
    if (timeout !== undefined) throw new Error(`${spec.name} timed out after ${config.timeoutMs}ms`, { cause: error })
    throw error
  }
  const failure = finishError(assembler.finish)
  if (failure !== undefined) throw failure
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error('Grok X search asked for a local tool; the request offers none, so the answer was discarded')
  }
  const operations: GrokXOperation[] = []
  for (const block of blocks) {
    if (block.type !== 'server-tool-call' || block.kind !== 'x_search') continue
    /* v8 ignore next -- promotion always records the reported call name; the kind is the fallback */
    const name = block.name ?? block.kind
    const seen = operations.find(operation => operation.name === name)
    if (seen === undefined) operations.push({ name, count: 1 })
    else seen.count += 1
  }
  if (operations.length === 0) {
    throw new Error('Grok answered without running an X search, so there is no X result to return')
  }
  const answer = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
  return boundGrokXResult({
    answer: answer.length === 0 ? 'Grok returned no answer text.' : answer,
    operations,
    omittedOperations: 0,
    truncated: assembler.finish.kind === 'max-tokens',
  }, config.maxResultChars)
}

/**
 * Pending-call presentation: a generic search card titled by the argument.
 * @param spec - the called tool.
 * @param argument - the raw argument.
 * @returns the generic call view.
 */
function presentCall(spec: GrokXToolSpec, argument: string): GenericCallView {
  return { card: 'generic', title: `${spec.name}: ${argument}`, kind: 'search', rawInput: argument }
}

/**
 * Build the four tool definitions for one registration.
 * @param ctx - plugin context carrying the llm service.
 * @param host - configuration, lifetime, and live gate.
 * @returns the definitions, in registration order.
 */
export function grokXToolDefinitions(ctx: Context, host: GrokXToolHost): ToolDefinition[] {
  return GROK_X_TOOL_SPECS.map(spec => defineTool({
    name: spec.name,
    description: `${spec.lead} ${GROK_X_TOOL_SHARED_DESCRIPTION}`,
    // One string argument; its name is `query` or `post` per tool.
    parameters: {
      [spec.argument]: { type: 'string', required: true, description: spec.argumentDescription },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderGrokXResult(value) }],
    },
    timeoutMs: host.config.timeoutMs,
    // Read-only remote lookups; they do not change agent or workspace state.
    isConcurrencySafe: () => true,
    // defineTool validates the required argument before either callback runs.
    async execute(args, exec) {
      return await runGrokXSearch(ctx, host, spec, parseGrokXArgument(spec, args[spec.argument] as string), exec)
    },
    presentCall: args => presentCall(spec, args[spec.argument] as string),
  }))
}
