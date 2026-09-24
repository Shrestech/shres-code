/**
 * Local Laya provider for the typed-judgment seam.
 *
 * The provider supervises one loopback gateway process that runs a pinned Laya
 * checkpoint through laya-mlx on Apple silicon, and answers `ctx.judgment`
 * asks over the Shield judgment wire. No judgment state leaves the machine.
 * Installing the gateway environment and checkpoint is an explicit action
 * (`/laya install` or {@link LayaJudgmentEngine.install}); startup never
 * downloads. Until the gateway is ready every ask fails `UNAVAILABLE`, which
 * consumers treat as an absent engine.
 *
 * @module @shres-code/shres-code-judgment-laya
 */

import { Context, Service } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { MAX_TIMER_DELAY_MS } from '@shres-code/shres-code-timeout'
import { JudgmentService } from '@shres-code/shres-code-judgment'
import type {
  JudgmentFittingEngine,
  JudgmentInput,
  JudgmentResult,
} from '@shres-code/shres-code-judgment'
import type { CommandResult } from '@shres-code/shres-code-commands'
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_DTYPE,
  DEFAULT_INSTALL_TIMEOUT_MS,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_PYTHON,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_GRACE_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_UV_PATH,
  MAX_STARTUP_TIMEOUT_MS,
  resolveConfig,
} from './config.ts'
import type { ResolvedLayaJudgmentConfig } from './config.ts'
import { currentHost, installLaya, preflightLaunch, subprocessRunner } from './installation.ts'
import { describeError, LayaGatewaySupervisor } from './supervisor.ts'
import type { LayaGatewayExit, LayaGatewayStatus, LayaInstallResult, LayaJudgmentConfig } from './types.ts'

export {
  DEFAULT_BATCH_SIZE,
  DEFAULT_DTYPE,
  DEFAULT_INSTALL_TIMEOUT_MS,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_PYTHON,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RESTART,
  DEFAULT_SHUTDOWN_GRACE_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_UV_PATH,
  defaultLocations,
  MAX_STARTUP_TIMEOUT_MS,
  resolveConfig,
} from './config.ts'
export type { LayaDefaultLocations, ResolvedLayaJudgmentConfig } from './config.ts'
export {
  currentHost,
  gatewayEnv,
  hostSupported,
  installLaya,
  lastLines,
  preflightLaunch,
  sha256File,
  subprocessRunner,
  unsupportedHostDetail,
} from './installation.ts'
export type { CommandRunner, HostFacts, InstallDependencies } from './installation.ts'
export { describeError, LayaGatewaySupervisor, SMOKE_QUESTION_ID, STDERR_TAIL_BYTES } from './supervisor.ts'
export type { LaunchPlan, LaunchPreflight, LayaSupervisorOptions, SupervisorLogger } from './supervisor.ts'
export type {
  LayaGatewayExit,
  LayaGatewayState,
  LayaGatewayStatus,
  LayaInstallResult,
  LayaJudgmentConfig,
  LayaJudgmentModel,
  LayaRestartPolicy,
} from './types.ts'

/** Name of the `/laya` command. */
export const LAYA_COMMAND = 'laya'

/** Config omitted by a direct `ctx.plugin(LayaJudgmentEngine)` call. */
const NO_CONFIG = {} as LayaJudgmentConfig

/** Positive integer timer field bounded by the platform timer limit. */
const timer = (fallback: number, max = MAX_TIMER_DELAY_MS): z<number> =>
  z.natural().min(1).max(max).default(fallback)

/**
 * Local Laya judgment provider. One instance registers `ctx.judgment`,
 * supervises one gateway process, and registers the `/laya` command.
 */
export class LayaJudgmentEngine extends JudgmentService {
  static inject = ['subprocess']

  /**
   * Composition schema consumed by the Loader. {@link resolveConfig} repeats
   * every check because direct programmatic construction bypasses Schemastery.
   */
  static Config: z<LayaJudgmentConfig> = z.object({
    model: z.object({
      repo: z.string().required(),
      revision: z.string().required(),
      manifestSha256: z.string().required(),
    }).required(),
    checkpointContext: z.union([z.const(512), z.const(1024)]).required(),
    dtype: z.union(['float16', 'float32']).default(DEFAULT_DTYPE),
    runtimeDir: z.string(),
    hfHome: z.string(),
    gatewayProject: z.string(),
    uvPath: z.string().default(DEFAULT_UV_PATH),
    python: z.string().default(DEFAULT_PYTHON),
    batchSize: z.natural().min(1).max(64).default(DEFAULT_BATCH_SIZE),
    startupTimeoutMs: timer(DEFAULT_STARTUP_TIMEOUT_MS, MAX_STARTUP_TIMEOUT_MS),
    requestTimeoutMs: timer(DEFAULT_REQUEST_TIMEOUT_MS),
    shutdownGraceMs: timer(DEFAULT_SHUTDOWN_GRACE_MS),
    installTimeoutMs: timer(DEFAULT_INSTALL_TIMEOUT_MS),
    maxRequestBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BYTES),
    maxResponseBytes: z.natural().min(1).max(64 * 1024 * 1024).default(DEFAULT_MAX_RESPONSE_BYTES),
    restart: z.object({
      maxRestarts: z.natural().min(1),
      windowMs: z.natural().min(1),
      backoffMs: z.natural().min(1),
      maxBackoffMs: z.natural().min(1),
    }),
  })

  /** Resolved pin, paths, limits, and restart budget. */
  readonly config: ResolvedLayaJudgmentConfig
  /** Atomic tokenizer fitting and judgment through the gateway. */
  override readonly fitting: JudgmentFittingEngine
  private readonly supervisor: LayaGatewaySupervisor
  private readonly lifetime = new AbortController()
  private installation: Promise<LayaInstallResult> | undefined

  /**
   * @param ctx - context receiving `ctx.judgment`; it must carry `ctx.subprocess`.
   * @param config - pinned checkpoint, checkpoint context, and optional limits.
   * @throws Error when any configuration field is invalid.
   */
  constructor(ctx: Context, config: LayaJudgmentConfig = NO_CONFIG) {
    super(ctx)
    this.config = resolveConfig(config)
    this.supervisor = new LayaGatewaySupervisor({
      config: this.config,
      preflight: () => preflightLaunch(this.config, currentHost()),
      spawn: spec => this.ctx.subprocess.spawn(spec),
      redact: state => this.redactState(state),
      logger: this.ctx.logger,
    })
    this.fitting = { ask: input => this.supervisor.askFitted(input) }
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: LAYA_COMMAND,
        description: 'Report, install, or restart the local Laya judgment gateway',
        input: { hint: '[status|install|restart]' },
        handler: ({ rawInput, signal }) => this.runCommand(rawInput, signal),
      })
    })
  }

  /** Start supervising; disposal waits for the gateway and any install to finish. */
  protected *[Service.init](): Generator<() => Promise<void>, void, void> {
    yield async () => {
      this.lifetime.abort(new Error('the judgment-laya provider was disposed'))
      await this.supervisor.dispose()
      // A running install was cancelled above; wait for it to settle.
      if (this.installation !== undefined) await Promise.allSettled([this.installation])
    }
    this.supervisor.start()
  }

  /**
   * Answer one ask through the local gateway.
   * @param input - state, typed questions, optional tier, and caller signal.
   * @returns validated answers with the gateway's engine and exact model id.
   * @throws JudgmentError `UNAVAILABLE` while the gateway is not ready or when
   *   it stops during the ask, `INPUT_TOO_LARGE` over `maxRequestBytes`,
   *   `INVALID_ANSWER` for an unusable response, and `ABORTED` when the
   *   caller cancels.
   */
  override ask(input: JudgmentInput): Promise<JudgmentResult> {
    return this.supervisor.ask(input)
  }

  /**
   * The gateway's current status.
   * @returns the latest published status.
   */
  status(): LayaGatewayStatus {
    return this.supervisor.status()
  }

  /**
   * Facts about the last gateway exit.
   * @returns the exit record, or undefined before any exit.
   */
  lastExit(): LayaGatewayExit | undefined {
    return this.supervisor.exit()
  }

  /**
   * Observe gateway status changes.
   * @param listener - receives each published status; its exceptions are logged.
   * @returns the unsubscribe function.
   */
  onStatus(listener: (status: LayaGatewayStatus) => void): () => void {
    return this.supervisor.onStatus(listener)
  }

  /**
   * Install the gateway environment and pinned checkpoint, then restart the
   * gateway. Concurrent calls share one install. This is the only operation
   * that downloads.
   * @param signal - cancels the running install step.
   * @returns the verified checkpoint directory and recorded digests.
   * @throws Error naming the failed step; the gateway restarts either way.
   */
  install(signal?: AbortSignal): Promise<LayaInstallResult> {
    this.installation ??= (async () => {
      try {
        await this.supervisor.stop('stopped for install')
        const cancel = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
        return await installLaya(this.config, {
          host: currentHost(),
          resolveExecutable: (command, stepSignal) => this.ctx.subprocess.resolveExecutable(command, undefined, stepSignal),
          run: subprocessRunner(this.ctx.subprocess, this.config),
        }, cancel)
      } finally {
        this.installation = undefined
        this.supervisor.start()
      }
    })()
    return this.installation
  }

  /** Stop the gateway, reset its restart budget, and launch it again. */
  async restart(): Promise<void> {
    await this.supervisor.restart()
  }

  /** Run one `/laya` subcommand. */
  private async runCommand(rawInput: string, signal: AbortSignal): Promise<CommandResult> {
    const verb = rawInput.trim()
    switch (verb) {
      case '':
      case 'status':
        return { kind: 'success', text: this.describeStatus() }
      case 'install':
        try {
          const result = await this.install(signal)
          return { kind: 'success', text: `Installed ${this.config.modelId} into ${result.modelDir}; the gateway is starting.` }
        } catch (error: unknown) {
          return { kind: 'error', text: `Laya install failed: ${describeError(error)}` }
        }
      case 'restart':
        await this.restart()
        return { kind: 'success', text: 'Restarting the local Laya gateway.' }
      default:
        return { kind: 'error', text: `Unknown /laya subcommand "${verb}"; use status, install, or restart.` }
    }
  }

  /** One-line status for `/laya status`. */
  private describeStatus(): string {
    const { state, detail } = this.supervisor.status()
    const exit = this.supervisor.exit()
    const lines = [`Laya ${this.config.modelId} (${this.config.dtype}, ${this.config.checkpointContext} tokens): ${state}${detail === undefined ? '' : ` — ${detail}`}`]
    if (exit !== undefined && state !== 'ready') {
      lines.push(`Last exit: ${exit.signal ?? `code ${exit.exitCode}`}${exit.timedOut ? ' after the startup deadline' : ''}.`)
    }
    return lines.join('\n')
  }

  /** Consult the optional deployment redactor exactly once. */
  private redactState(state: string): string | Promise<string> {
    const redactor = this.ctx.get('judgmentRedactor')
    return redactor === undefined ? state : redactor.redactState(state)
  }
}

export default LayaJudgmentEngine
