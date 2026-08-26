/**
 * Out-of-process SDK subagent backend. Each child is a complete DeepSeek
 * Harness runtime in its own process — own `cordis.yml`-decided composition,
 * session, model route, and tools — driven over stdio JSON-RPC through the
 * TypeScript SDK client, so it shares no Cordis context. Parent-side
 * `maxDepth` is enforced before spawn; `toolFilter`, `persona`, and
 * `outputSchema` are rejected loud. The ONE other thing it reads off
 * `request.parent` is the session's workspace cwd. This plugin uses named
 * exports only; a default would hide its loader metadata (see
 * `docs/postmortem/0001-acp-default-export-drops-inject.md`).
 * @module @shres-code/shres-code-subagent-shres-sdk
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import type { SubagentCapabilities, SubagentProvider, SubagentStartRequest } from '@shres-code/shres-code-subagent'
import { assertPositiveFinite, assertStartCapabilities, REMOTE_START_CAPABILITIES, resolveChildCwd, validateConfiguredCwd } from '@shres-code/shres-code-subagent'
import {
  DEFAULT_DISPOSE_EOF_GRACE_MS,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  startSdkRun,
  type SdkRunSpec,
} from './run.ts'

export const name = 'subagent-shres-sdk'
export const inject = ['subagents']

/** Config: how to spawn and drive the child SDK runtime process. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `shres-sdk`). */
  providerName: string
  /** The executable to spawn for each run (the child runtime bin or packaged exe). */
  command: string
  /** Arguments passed to {@link command} (typically the child's `cordis.yml` path). */
  args: string[]
  /**
   * Working directory override for the child process and its SDK session
   * workspace. Must be non-empty; a relative path resolves against the
   * harness launch directory at load, and the result must be an existing
   * directory. When omitted, each child inherits its delegating parent
   * session's cwd — and starting one from a parent session that has no cwd
   * fails.
   */
  cwd?: string
  /** Provider route the child runtime initializes with (default `deepseek-official`). */
  provider: string
  /** Model the child runtime initializes with (default `deepseek-v4-flash`). */
  model: string
  /** Optional per-request output-token cap for the child runtime. */
  maxTokens?: number
  /**
   * Extra environment variables for the child process — e.g. the child
   * runtime's own `DEEPSEEK_API_KEY`, or `SHRES_CORDIS_CONFIG` naming its
   * config. Forwarded on top of a credential-scrubbed copy of the parent
   * env, so an explicit key here reaches the child while ambient secrets do
   * not leak implicitly.
   */
  env: Record<string, string>
  /** Bound (ms) on the protocol `shutdown` exchange during dispose. */
  shutdownTimeoutMs?: number
  /**
   * Grace period (ms) for the child's EOF-driven quiesce on dispose — its
   * window to flush persistence and tear down its own nested subprocesses
   * before the parent escalates to a signal.
   */
  disposeEofGraceMs?: number
  /** Termination confirmation window (ms), including forced exit on every platform. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('shres-sdk'),
  command: z.string().required(),
  args: z.array(z.string()).default([]),
  cwd: z.string(),
  provider: z.string().default('deepseek-official'),
  model: z.string().default('deepseek-v4-flash'),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  env: z.dict(z.string()).default({}),
  shutdownTimeoutMs: z.number().default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
  disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

/** The shape after schemastery applied the defaults (`cwd` and `maxTokens` have none). */
type ResolvedConfig = Required<Omit<Config, 'cwd' | 'maxTokens'>> & Pick<Config, 'cwd' | 'maxTokens'>

/**
 * The SDK provider. Parent-side `maxDepth` is enforced before spawn;
 * `toolFilter`, `persona`, and `outputSchema` are rejected rather than ignored.
 */
class SdkSubagentProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = REMOTE_START_CAPABILITIES
  // Context contract: an out-of-process SDK child starts fresh — no parent conversation crosses the process boundary.
  readonly inheritsParentContext = false

  constructor(readonly name: string, private readonly ctx: Context, private readonly config: ResolvedConfig) {}

  start(request: SubagentStartRequest) {
    assertStartCapabilities(this.name, request, this.capabilities)
    const spec: SdkRunSpec = {
      command: this.config.command,
      args: this.config.args,
      cwd: resolveChildCwd('subagent-shres-sdk', this.config.cwd, request.parent.session.header.cwd),
      provider: this.config.provider,
      model: this.config.model,
      ...this.config.maxTokens === undefined ? {} : { maxTokens: this.config.maxTokens },
      env: this.config.env,
      shutdownTimeoutMs: this.config.shutdownTimeoutMs,
      disposeEofGraceMs: this.config.disposeEofGraceMs,
      disposeGraceMs: this.config.disposeGraceMs,
      onError: (error, stopReason) => {
        // The seam forbids `result` rejecting, so a child-level failure is
        // flattened to a stop reason — preserve it here rather than losing it.
        this.ctx.logger.warn(`subagent-shres-sdk "${this.name}": child run failed (${stopReason}): ${error.message}`)
      },
    }
    return startSdkRun(request, spec)
  }
}

export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveFinite('subagent-shres-sdk', 'shutdownTimeoutMs', resolved.shutdownTimeoutMs)
  assertPositiveFinite('subagent-shres-sdk', 'disposeEofGraceMs', resolved.disposeEofGraceMs)
  assertPositiveFinite('subagent-shres-sdk', 'disposeGraceMs', resolved.disposeGraceMs)
  if (resolved.maxTokens !== undefined && (!Number.isSafeInteger(resolved.maxTokens) || resolved.maxTokens <= 0)) {
    throw new TypeError('subagent-shres-sdk maxTokens must be a positive safe integer')
  }
  // Interpret a relative configured cwd against the harness launch directory
  // ONCE, at load, and fail a misconfigured directory here — not per start.
  const configuredCwd = validateConfiguredCwd('subagent-shres-sdk', resolved.cwd)
  const validated: ResolvedConfig = configuredCwd === undefined
    ? resolved
    : { ...resolved, cwd: configuredCwd }
  ctx.subagents.registerProvider(new SdkSubagentProvider(validated.providerName, ctx, validated))
}
