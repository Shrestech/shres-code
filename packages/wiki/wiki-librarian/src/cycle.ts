/**
 * One batched wiki librarian cycle: route resolve, pre-dispatch log, one
 * auxiliary LLM call, then page/log writes. Unbound routes are dormant.
 *
 * @module @shres-code/shres-code-wiki-librarian/cycle
 */

import type { Context } from '@shres-code/cordis'
import type { Agent } from '@shres-code/shres-code-agent'
import {
  BlockAssembler,
  createUserMessage,
  deepFreeze,
} from '@shres-code/shres-code-llm'
import type { FinishReason, GenerateOptions, Message } from '@shres-code/shres-code-llm'
import type { Session } from '@shres-code/shres-code-session'
import { deadline } from '@shres-code/shres-code-timeout'
import {
  boundRole,
  type WikiLibrarianPurpose,
  type WikiLintIssue,
  type WikiPage,
  type WikiRoleBinding,
  type WikiWriteRequest,
} from '@shres-code/shres-code-wiki'
import type { ResolvedWikiLibrarianConfig } from './resolve.ts'

/** Capability-owned timeout reason code for auxiliary wiki librarian requests. */
export const WIKI_LIBRARIAN_TIMEOUT_CODE = 'WIKI_LIBRARIAN_TIMEOUT'

/** One page create/update/merge proposal from the librarian model. */
export interface LibrarianPageProposal {
  readonly op: 'create' | 'update' | 'merge'
  readonly path: string
  readonly body: string
  readonly title?: string
  readonly tags?: readonly string[]
  readonly contradicts?: readonly string[]
  readonly superseded_by?: string
}

/** Parsed librarian JSON payload. */
export interface LibrarianProposal {
  readonly pages: readonly LibrarianPageProposal[]
  readonly log?: string
  readonly summary?: string
}

/** Outcome of one cycle. */
export interface LibrarianCycleResult {
  readonly kind: 'applied' | 'dormant' | 'empty' | 'failed'
  readonly detail: string
  readonly paths: readonly string[]
}

/**
 * Resolve the librarian route: settings namespace, then project config.yaml,
 * then plugin Config. Never the session frontier model.
 * @param settings - wiki settings overlay.
 * @param project - project `config.yaml` overlay.
 * @param config - plugin config pair.
 * @param enabled - whether the wiki seat is active.
 * @returns the bound pair, or `undefined` when dormant.
 */
export function resolveLibrarianRoute(
  settings: { enabled?: boolean; roles?: { librarian?: WikiRoleBinding } },
  project: { roles?: { librarian?: WikiRoleBinding } },
  config: WikiRoleBinding,
  enabled: boolean,
): { provider: string; model: string } | undefined {
  if (!enabled || settings.enabled === false) return undefined
  return boundRole(settings.roles?.librarian)
    ?? boundRole(project.roles?.librarian)
    ?? boundRole(config)
}

/**
 * Extract a JSON object from model text, including fenced blocks.
 * @param text - raw model output.
 * @returns the parsed proposal, or `undefined` when no object is present.
 */
export function parseLibrarianProposal(text: string): LibrarianProposal | undefined {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/u)
  const candidate = fenced?.[1]?.trim() ?? trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown
  } catch {
    // Model JSON is untrusted; a malformed payload is an empty cycle, not a crash.
    return undefined
  }
  /* v8 ignore next -- JSON objects that start with `{` are plain objects or throw */
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const data = parsed as Record<string, unknown>
  const pages: LibrarianPageProposal[] = []
  if (Array.isArray(data.pages)) {
    for (const item of data.pages) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
      const record = item as Record<string, unknown>
      if (typeof record.path !== 'string' || record.path.trim().length === 0) continue
      if (typeof record.body !== 'string') continue
      const op = record.op === 'update' || record.op === 'merge' ? record.op : 'create'
      pages.push({
        op,
        path: record.path,
        body: record.body,
        ...typeof record.title === 'string' ? { title: record.title } : {},
        ...Array.isArray(record.tags)
          ? { tags: record.tags.filter((tag): tag is string => typeof tag === 'string') }
          : {},
        ...Array.isArray(record.contradicts)
          ? { contradicts: record.contradicts.filter((tag): tag is string => typeof tag === 'string') }
          : {},
        ...typeof record.superseded_by === 'string' ? { superseded_by: record.superseded_by } : {},
      })
    }
  }
  return {
    pages,
    ...typeof data.log === 'string' && data.log.trim().length > 0 ? { log: data.log } : {},
    ...typeof data.summary === 'string' && data.summary.trim().length > 0 ? { summary: data.summary } : {},
  }
}

/** Stable librarian instruction. */
export const LIBRARIAN_SYSTEM = [
  'You are the project wiki librarian. Consolidate durable knowledge from the supplied session traces into wiki pages.',
  'Return ONLY a JSON object with optional keys pages, log, and summary.',
  'pages is an array of {op, path, body, title?, tags?, contradicts?, superseded_by?} where op is create, update, or merge.',
  'Write durable knowledge only — no task trackers, no working-memory cards, no session chatter.',
  'Keep pages concise. Use contradicts and superseded_by for structural disagreement.',
  'log is optional plain text appended to the day log; the system timestamps every entry, so never include a date or time. summary is a one-line notice for the session.',
].join('\n')

/**
 * Build the user prompt for one cycle.
 * @param pages - current wiki pages.
 * @param lint - current lint issues.
 * @param events - sampled session events.
 * @returns the framed prompt.
 */
export function frameLibrarianPrompt(
  pages: readonly WikiPage[],
  lint: readonly WikiLintIssue[],
  events: readonly { type: string; data: unknown }[],
): string {
  return [
    'Current wiki pages:',
    JSON.stringify(pages.map(page => ({
      path: page.path,
      title: page.title,
      /* v8 ignore next -- pages may omit tags */
      tags: page.frontmatter.tags ?? [],
      status: page.frontmatter.status,
      body: page.body.slice(0, 1200),
    }))),
    'Lint issues:',
    JSON.stringify(lint),
    'Session traces:',
    JSON.stringify(events),
  ].join('\n')
}

function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error('wiki-librarian: output reached maxOutputTokens')
    case 'tool-calls':
      return new Error('wiki-librarian: librarian model unexpectedly requested a tool')
    default:
      return new Error(`wiki-librarian: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/**
 * Run one librarian cycle against a bound route.
 * @param ctx - context exposing wiki and llm.
 * @param session - owning session; request and page events are appended here.
 * @param config - validated plugin policy.
 * @param purpose - auxiliary purpose stamp.
 * @param signal - optional cancellation.
 * @param agent - optional owner for a completion notice.
 * @returns the cycle outcome.
 */
export async function runLibrarianCycle(
  ctx: Context,
  session: Session,
  config: ResolvedWikiLibrarianConfig,
  purpose: WikiLibrarianPurpose = 'wiki-summarize',
  signal?: AbortSignal,
  agent?: Agent,
): Promise<LibrarianCycleResult> {
  if (!ctx.wiki.status.active) {
    return { kind: 'dormant', detail: 'wiki is disabled', paths: [] }
  }
  const route = resolveLibrarianRoute(
    ctx.wiki.settings,
    await ctx.wiki.projectConfig(session),
    {
      ...config.provider === undefined ? {} : { provider: config.provider },
      ...config.model === undefined ? {} : { model: config.model },
    },
    ctx.wiki.status.active,
  )
  if (route === undefined) {
    return { kind: 'dormant', detail: 'wiki librarian is unbound', paths: [] }
  }
  const pages = await ctx.wiki.list(session, { includeArchive: false })
  const lint = await ctx.wiki.lint(session)
  const events = session.events.slice(-config.maxLogEvents).map(event => ({
    type: event.type,
    data: event.data,
  }))
  const prompt = frameLibrarianPrompt(pages, lint, events)
  const inputBytes = Buffer.byteLength(prompt, 'utf8')
  if (inputBytes > config.maxInputBytes) {
    return {
      kind: 'failed',
      detail: `wiki-librarian: input is ${String(inputBytes)} bytes, exceeding maxInputBytes ${String(config.maxInputBytes)}`,
      paths: [],
    }
  }
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: 'wiki-librarian' },
  })]
  using callDeadline = deadline(signal, config.timeoutMs, WIKI_LIBRARIAN_TIMEOUT_CODE)
  const options: GenerateOptions = deepFreeze({
    provider: route.provider,
    model: route.model,
    messages,
    system: LIBRARIAN_SYSTEM,
    maxTokens: config.maxOutputTokens,
    sessionId: session.id,
    purpose,
    signal: callDeadline.signal,
  })
  session.append('wiki/librarian-request', {
    purpose,
    route,
    system: LIBRARIAN_SYSTEM,
    prompt,
    maxTokens: config.maxOutputTokens,
  }, { ignorable: true })
  callDeadline.signal.throwIfAborted()
  const assembler = new BlockAssembler()
  try {
    for await (const chunk of ctx.llm.stream(options)) {
      callDeadline.signal.throwIfAborted()
      assembler.push(chunk)
    }
  } catch (error) {
    /* v8 ignore next -- adapters may reject with Error or a string */
    return {
      kind: 'failed',
      detail: error instanceof Error ? error.message : String(error),
      paths: [],
    }
  }
  const terminalError = finishError(assembler.finish)
  if (terminalError !== undefined) {
    return { kind: 'failed', detail: terminalError.message, paths: [] }
  }
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    return { kind: 'failed', detail: 'wiki-librarian: librarian output must contain text only', paths: [] }
  }
  const text = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
  const proposal = parseLibrarianProposal(text)
  if (proposal === undefined) {
    return { kind: 'empty', detail: 'wiki-librarian: no JSON proposal', paths: [] }
  }
  const paths: string[] = []
  for (const page of proposal.pages) {
    const request: WikiWriteRequest = {
      path: page.path,
      body: page.body,
      ...page.title === undefined ? {} : { title: page.title },
      ...page.tags === undefined ? {} : { tags: page.tags },
      ...page.contradicts === undefined ? {} : { contradicts: page.contradicts },
      /* v8 ignore next -- optional proposal fields */
      ...page.superseded_by === undefined ? {} : { superseded_by: page.superseded_by },
    }
    const written = await ctx.wiki.writePage(session, request)
    if (written.kind === 'written') paths.push(written.page.path)
  }
  if (proposal.log !== undefined) {
    const logged = await ctx.wiki.appendLog(session, { body: proposal.log })
    /* v8 ignore next -- parseLibrarianProposal only keeps a non-empty log body */
    if (logged.kind === 'appended') paths.push(logged.path)
  }
  const summary = proposal.summary
    ?? (paths.length === 0 ? 'Wiki librarian produced no writes.' : `Wiki librarian updated ${paths.join(', ')}.`)
  if (agent !== undefined) {
    try {
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: summary }],
        source: { kind: 'plugin', plugin: 'wiki-librarian' },
      }))
    } catch {
      // The owner may already be disposed; the wiki writes are the durable result.
    }
  }
  return {
    kind: paths.length === 0 ? 'empty' : 'applied',
    detail: summary,
    paths,
  }
}
