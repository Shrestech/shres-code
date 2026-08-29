/**
 * Model-facing wiki tools over `ctx.wiki`: `wiki_search`, `wiki_read`,
 * `wiki_write`, and `wiki_log`. Wiki content reaches the model only through
 * these tools. Registrations remount from `ctx.wiki.watch()` so the catalog
 * is empty while the seat is disabled. The read path bumps `touched` itself.
 *
 * @module @shres-code/shres-code-tool-wiki
 */

import type { Context } from '@shres-code/cordis'
import { defineTool } from '@shres-code/shres-code-tools'
import type { GenericCallView, ToolRunContext } from '@shres-code/shres-code-tools'
import { temperatureOf, type WikiSearchHit, type WikiStatus, type WikiWriteRequest } from '@shres-code/shres-code-wiki'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-wiki'
/** Services required by the wiki tools. */
export const inject = ['tools', 'wiki']

/** Canonical `wiki_search` output. */
export interface SearchOutput {
  readonly hits: ReadonlyArray<{
    readonly path: string
    readonly title: string
    readonly temperature: string
    readonly score: number
    readonly excerpt: string
  }>
}

/** Canonical `wiki_read` output. */
export interface ReadOutput {
  readonly path: string
  readonly title: string
  readonly body: string
  readonly temperature: string
  readonly created: string
  readonly updated: string
  readonly touched: string
}

/** Canonical `wiki_write` output. */
export interface WriteOutput {
  readonly path: string
  readonly status: 'written' | 'failed'
  readonly reason?: string
}

/** Canonical `wiki_log` output. */
export interface LogOutput {
  readonly path: string
  readonly status: 'appended' | 'failed'
  readonly reason?: string
}

/**
 * Require the calling agent so wiki writes have a session log.
 * @param exec - the tool execution context.
 * @param toolName - the tool's name for the error message.
 * @returns the owning agent.
 * @throws when the caller has no owning agent session.
 */
function requireAgent(exec: ToolRunContext, toolName: string): NonNullable<ToolRunContext['agent']> {
  if (exec.agent === undefined) {
    throw new Error(`${toolName} requires an owning agent session`)
  }
  return exec.agent
}

/**
 * Format search hits as a list.
 * @param value - canonical search output.
 * @returns model-facing text.
 */
export function formatSearchOutput(value: SearchOutput): string {
  if (value.hits.length === 0) return 'No wiki pages matched.'
  return value.hits
    .map(hit => `- [${hit.temperature}] ${hit.path} ${hit.title} (${hit.score.toFixed(2)})\n  ${hit.excerpt}`)
    .join('\n')
}

/**
 * Format a read page.
 * @param value - canonical read output.
 * @returns model-facing text.
 */
export function formatReadOutput(value: ReadOutput): string {
  return `# ${value.title}\n\npath: ${value.path}\ntemperature: ${value.temperature}\ntouched: ${value.touched}\n\n${value.body}`
}

/**
 * Format a write outcome.
 * @param value - canonical write output.
 * @returns model-facing text.
 */
export function formatWriteOutput(value: WriteOutput): string {
  if (value.status === 'written') return `Wrote wiki page ${value.path}.`
  return `Wiki page ${value.path} was not written (reason: ${value.reason ?? 'unknown'}).`
}

/**
 * Format a log outcome.
 * @param value - canonical log output.
 * @returns model-facing text.
 */
export function formatLogOutput(value: LogOutput): string {
  if (value.status === 'appended') return `Appended wiki log ${value.path}.`
  return `Wiki log was not appended (reason: ${value.reason ?? 'unknown'}).`
}

function present(title: string, kind: NonNullable<GenericCallView['kind']>, raw: string): GenericCallView {
  return { card: 'generic', title, kind, rawInput: raw }
}

function projectHits(hits: readonly WikiSearchHit[]): SearchOutput['hits'] {
  return hits.map(hit => ({
    path: hit.path,
    title: hit.title,
    temperature: hit.temperature,
    score: hit.score,
    excerpt: hit.excerpt,
  }))
}

/**
 * Register the four wiki tools while the seat is active.
 * @param ctx - context with tools and wiki.
 * @returns disposer that unregisters all four.
 */
function registerTools(ctx: Context): () => void {
  const disposeSearch = ctx.tools.register(defineTool({
    name: 'wiki_search',
    description:
      'Search the project wiki for durable knowledge pages. Results are temperature-ranked: HOT pages outrank COLD. Archive is omitted unless includeArchive is true. Use this before writing a page to avoid duplicates.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search query.' },
      limit: { type: 'integer', description: 'Maximum hits to return.' },
      includeArchive: { type: 'boolean', description: 'When true, include archived pages.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                title: { type: 'string', required: true },
                temperature: { type: 'string', required: true },
                score: { type: 'number', required: true },
                excerpt: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSearchOutput(value as SearchOutput) }],
    },
    async execute(args, exec) {
      requireAgent(exec, 'wiki_search')
      const hits = await ctx.wiki.search(args.query, {
        ...args.limit === undefined ? {} : { limit: args.limit },
        ...args.includeArchive === undefined ? {} : { includeArchive: args.includeArchive },
      }, Date.now(), exec.signal)
      return { hits: [...projectHits(hits)] }
    },
    presentCall: args => present(`Search wiki: ${args.query}`, 'search', args.query),
  }))

  const disposeRead = ctx.tools.register(defineTool({
    name: 'wiki_read',
    description:
      'Read one wiki page by wiki-relative path. The read records access (bumps touched) so temperature stays honest. Missing pages fail.',
    parameters: {
      path: { type: 'string', required: true, description: 'Wiki-relative markdown path, for example notes.md.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          title: { type: 'string', required: true },
          body: { type: 'string', required: true },
          temperature: { type: 'string', required: true },
          created: { type: 'string', required: true },
          updated: { type: 'string', required: true },
          touched: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatReadOutput(value as ReadOutput) }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec, 'wiki_read')
      const touched = await ctx.wiki.touch(agent.session, args.path)
      if (touched.kind === 'failed') throw new Error(touched.detail)
      const page = touched.page
      return {
        path: page.path,
        title: page.title,
        body: page.body,
        temperature: temperatureOf(page.frontmatter.touched, Date.now(), ctx.wiki.engineConfig),
        created: page.frontmatter.created,
        updated: page.frontmatter.updated,
        touched: page.frontmatter.touched,
      }
    },
    presentCall: args => present(`Read wiki ${args.path}`, 'read', args.path),
  }))

  const disposeWrite = ctx.tools.register(defineTool({
    name: 'wiki_write',
    description:
      'Create or update a durable wiki knowledge page. Use for long-term facts, not task trackers or working-memory cards. Path is wiki-relative markdown (for example patterns/foo.md).',
    parameters: {
      path: { type: 'string', required: true, description: 'Wiki-relative markdown path.' },
      body: { type: 'string', required: true, description: 'Markdown body. Frontmatter is filled by the harness.' },
      title: { type: 'string', description: 'Optional title override.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      contradicts: { type: 'array', items: { type: 'string' }, description: 'Wiki-relative paths this page contradicts.' },
      superseded_by: { type: 'string', description: 'Wiki-relative path of a successor page.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['written', 'failed'] },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatWriteOutput(value as WriteOutput) }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec, 'wiki_write')
      const request: WikiWriteRequest = {
        path: args.path,
        body: args.body,
        ...args.title === undefined ? {} : { title: args.title },
        ...args.tags === undefined ? {} : { tags: args.tags },
        ...args.contradicts === undefined ? {} : { contradicts: args.contradicts },
        ...args.superseded_by === undefined ? {} : { superseded_by: args.superseded_by },
      }
      const result = await ctx.wiki.writePage(agent.session, request)
      return result.kind === 'written'
        ? { path: result.page.path, status: 'written' as const }
        : { path: args.path, status: 'failed' as const, reason: result.reason }
    },
    presentCall: args => present(`Write wiki ${args.path}`, 'edit', args.path),
  }))

  const disposeLog = ctx.tools.register(defineTool({
    name: 'wiki_log',
    description:
      'Append a short note to the wiki day log (log/YYYY-MM-DD.md). Use for session traces that should not become knowledge pages.',
    parameters: {
      body: { type: 'string', required: true, description: 'Markdown to append to today\'s shard.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['appended', 'failed'] },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatLogOutput(value as LogOutput) }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec, 'wiki_log')
      const result = await ctx.wiki.appendLog(agent.session, { body: args.body })
      return result.kind === 'appended'
        ? { path: result.path, status: 'appended' as const }
        : { path: '', status: 'failed' as const, reason: result.reason }
    },
    presentCall: args => present('Append wiki log', 'edit', args.body),
  }))

  return () => {
    disposeSearch()
    disposeRead()
    disposeWrite()
    disposeLog()
  }
}

/**
 * Remount the four tools while the wiki seat is active.
 * @param ctx - context with tools and wiki.
 */
export function apply(ctx: Context): void {
  let disposeTools: (() => void) | undefined
  const remount = (status: WikiStatus): void => {
    disposeTools?.()
    disposeTools = undefined
    if (!status.active) return
    disposeTools = registerTools(ctx)
  }
  remount(ctx.wiki.status)
  ctx.effect(() => {
    const stop = ctx.wiki.watch(remount)
    return () => {
      stop()
      disposeTools?.()
      disposeTools = undefined
    }
  }, 'tool-wiki remount')
}
