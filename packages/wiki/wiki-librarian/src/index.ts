/**
 * Cheap-model wiki librarian seat. Dispatches one batched auxiliary LLM call
 * per cycle on the bound wiki model (settings → project config.yaml → plugin
 * Config). Unbound is dormant and never uses the session frontier model.
 * Triggers: successful `jspace_ship`, session dispose, and an optional
 * `ctx.jobs` registration of the same cycle.
 *
 * @module @shres-code/shres-code-wiki-librarian
 */

import type { Context } from '@shres-code/cordis'
import type { Agent } from '@shres-code/shres-code-agent'
import type { Session } from '@shres-code/shres-code-session'
import type { ToolExecution, ToolExecutionResult } from '@shres-code/shres-code-tools'
import type {} from '@shres-code/shres-code-jobs'
import type {} from '@shres-code/shres-code-tools'
import type {} from '@shres-code/shres-code-session'
import { runLibrarianCycle } from './cycle.ts'
import type { LibrarianCycleResult } from './cycle.ts'
import { resolveLibrarianConfig, type Config } from './resolve.ts'

export {
  frameLibrarianPrompt,
  LIBRARIAN_SYSTEM,
  parseLibrarianProposal,
  resolveLibrarianRoute,
  runLibrarianCycle,
  WIKI_LIBRARIAN_TIMEOUT_CODE,
} from './cycle.ts'

export type { LibrarianCycleResult, LibrarianPageProposal, LibrarianProposal } from './cycle.ts'
export { Config, resolveLibrarianConfig, type ResolvedWikiLibrarianConfig } from './resolve.ts'

declare module '@shres-code/shres-code-jobs' {
  interface JobKindMap {
    'wiki-librarian': 'wiki-librarian'
  }
}

/**
 * Format a librarian job failure for `ctx.jobs`.
 * @param error - rejection reason from the inflight cycle.
 * @returns a message string.
 */
export function librarianJobErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register the inflight cycle on `ctx.jobs` when a controller is attached.
 * @param jobs - live job registry.
 * @param agent - owning agent.
 * @param work - inflight cycle.
 */
export function startLibrarianJob(
  jobs: { start(spec: { kind: 'wiki-librarian'; label: string; owner: Agent; run: () => { cancel(): void; done: Promise<{ status: 'completed' } | { status: 'failed'; detail: string }> } }): unknown },
  agent: Agent,
  work: Promise<LibrarianCycleResult>,
): void {
  jobs.start({
    kind: 'wiki-librarian',
    label: 'wiki librarian cycle',
    owner: agent,
    run: () => ({
      cancel() {},
      done: work.then(
        (): { status: 'completed' } => ({ status: 'completed' }),
        (error: unknown): { status: 'failed'; detail: string } => ({
          status: 'failed',
          detail: librarianJobErrorDetail(error),
        }),
      ),
    }),
  })
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'wiki-librarian'
/** Services required by the librarian seat. */
export const inject = ['wiki', 'llm']

/**
 * Remount ship/dispose triggers for the librarian seat.
 * @param ctx - context with wiki and llm.
 * @param config - plugin config.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveLibrarianConfig(config)
  const inflight = new Map<string, Promise<LibrarianCycleResult>>()

  const start = (session: Session, agent: Agent | undefined, signal?: AbortSignal): Promise<LibrarianCycleResult> => {
    const existing = inflight.get(session.id)
    /* v8 ignore next -- coalesces overlapping ship/dispose on one session */
    if (existing !== undefined) return existing
    const work = runLibrarianCycle(ctx, session, resolved, 'wiki-summarize', signal, agent)
      .finally(() => { inflight.delete(session.id) })
    inflight.set(session.id, work)
    const jobs = ctx.get('jobs')
    if (jobs !== undefined && agent !== undefined) {
      try {
        startLibrarianJob(jobs, agent, work)
      } catch {
        // No job controller is attached; the cycle still runs as the inflight promise.
      }
    }
    return work
  }

  ctx.effect(() => {
    const tools = ctx.get('tools')
    const stopPost = tools === undefined
      ? undefined
      : ctx.on('tools/post-execute', async (exec: ToolExecution, result: ToolExecutionResult, next) => {
        const decision = await next()
        if (exec.name === 'jspace_ship' && !result.isError && exec.agent !== undefined) {
          await start(exec.agent.session, exec.agent, exec.signal)
        }
        /* v8 ignore next -- non-ship results and missing agents skip the cycle */
        return decision
      })
    const stopDispose = ctx.on('session/disposed', (session) => {
      const agents = ctx.get('agents')
      const owner = agents?.list().find(agent => agent.session === session)
      void start(session, owner)
    })
    return () => {
      stopPost?.()
      stopDispose()
    }
  }, 'wiki-librarian triggers')

  ctx.effect(() => () => {
    const pending = [...inflight.values()]
    /* v8 ignore next -- drain rejection is swallowed so plugin dispose cannot fail */
    return Promise.all(pending).then(() => undefined, () => undefined)
  }, 'wiki-librarian drain')
}
