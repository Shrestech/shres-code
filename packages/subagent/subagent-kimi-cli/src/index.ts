/**
 * Fixed Kimi Code CLI one-shot subagent provider. Every accepted run starts a
 * fresh official `kimi -p` process in the delegating Session's workspace.
 *
 * @module @shres-code/shres-code-subagent-kimi-cli
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { MAX_TIMER_DELAY_MS } from '@shres-code/shres-code-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@shres-code/shres-code-subagent'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_EXECUTABLE,
  startKimiCliRun,
  type KimiCliRunSpec,
} from './run.ts'

export { DEFAULT_DISPOSE_GRACE_MS, DEFAULT_EXECUTABLE, kimiHeadlessArgv, textTask } from './run.ts'
export { parseKimiStreamJson } from './parse.ts'

export const name = 'subagent-kimi-cli'
export const inject = ['subagents', 'subprocess']

/* jscpd:ignore-start -- sibling CLI providers expose the same deployment-owned fields. */
/** Deployment-owned environment, process-release bound, and executable override. */
export interface Config {
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment. An API key reaches the child
   * only when named here.
   */
  env?: Record<string, string>
  /** Grace in milliseconds for Kimi CLI process-tree termination. */
  disposeGraceMs?: number
  /** Absolute path or PATH name of the `kimi` binary; default `kimi`. */
  executable?: string
}

export const Config: z<Config> = z.object({
  env: z.dict(z.string()).default({}),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  executable: z.string(),
})

type ResolvedConfig = {
  env: Record<string, string>
  disposeGraceMs: number
  executable?: string
}
/* jscpd:ignore-end */

/* jscpd:ignore-start -- Cordis registration mirrors the Grok sibling. */
class KimiCliProvider implements SubagentProvider {
  readonly name = 'kimi-cli'
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  async start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-kimi-cli: no working directory for the child — delegate from a parent session that has one',
      )
    }
    const executable = this.config.executable
      ?? await this.ctx.subprocess.resolveExecutable(
        DEFAULT_EXECUTABLE,
        this.config.env,
        request.signal,
      )
    const spec: KimiCliRunSpec = {
      cwd: resolveChildCwd('subagent-kimi-cli', undefined, parentCwd),
      executable,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-kimi-cli: child run failed (${stopReason}): ${error.message}`,
        )
      },
    }
    return startKimiCliRun(request, spec)
  }
}

/**
 * Register the fixed `kimi-cli` provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - explicit child environment, disposal grace, and executable.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite(
    'subagent-kimi-cli',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-kimi-cli: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  if (resolved.executable !== undefined && resolved.executable.length === 0) {
    throw new Error('subagent-kimi-cli: executable must not be empty')
  }
  ctx.subagents.registerProvider(new KimiCliProvider(ctx, resolved))
}
/* jscpd:ignore-end */
