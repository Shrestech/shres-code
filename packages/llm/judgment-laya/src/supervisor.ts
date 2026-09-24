/**
 * Supervisor for one local Laya gateway process.
 *
 * The supervisor launches the gateway through the subprocess seam, publishes
 * `ready` only after the readiness line, a health check, and a smoke ask have
 * all succeeded, and serves asks through the one Shield wire client. A crash
 * publishes `unavailable` before any restart is scheduled; restarts back off
 * within a budget. Disposal clears status listeners, fails in-flight asks,
 * terminates the process tree, and waits for it to exit.
 *
 * @module @shres-code/shres-code-judgment-laya/supervisor
 */

import { JudgmentError, judgmentQuestionId } from '@shres-code/shres-code-judgment'
import type {
  JudgmentFittingInput,
  JudgmentFittingResult,
  JudgmentInput,
  JudgmentResult,
} from '@shres-code/shres-code-judgment'
import { createShieldWireEngine, resolveConfig as resolveShieldConfig } from '@shres-code/shres-code-judgment-shield'
import type { ShieldWireEngine } from '@shres-code/shres-code-judgment-shield'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@shres-code/shres-code-subprocess'
import type { ResolvedLayaJudgmentConfig } from './config.ts'
import { lastLines } from './installation.ts'
import type { LayaGatewayExit, LayaGatewayStatus } from './types.ts'

/** One fully specified gateway launch. */
export interface LaunchPlan {
  /** Interpreter and arguments. */
  readonly argv: readonly string[]
  /** Working directory. */
  readonly cwd: string
  /** Explicit environment entries merged over the scrubbed parent environment. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/** A launch plan, or the reason the gateway cannot launch. */
export type LaunchPreflight =
  | { readonly kind: 'launch'; readonly plan: LaunchPlan }
  | { readonly kind: 'not-installed' | 'unsupported-host'; readonly detail: string }

/** Diagnostics sink for listener failures and restart decisions. */
export interface SupervisorLogger {
  /** Report a contained failure. */
  error(...args: unknown[]): void
  /** Report an expected degradation. */
  warn(...args: unknown[]): void
}

/** Collaborators the supervisor needs; each is supplied by the owning service. */
export interface LayaSupervisorOptions {
  /** Resolved provider configuration. */
  readonly config: ResolvedLayaJudgmentConfig
  /** Decide how, or whether, to launch; called before every launch. */
  readonly preflight: () => Promise<LaunchPreflight>
  /** The subprocess seam's spawn. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Deployment redaction, consulted once per state before serialization. */
  readonly redact: (state: string) => string | Promise<string>
  /** Diagnostics sink. */
  readonly logger: SupervisorLogger
}

/** The gateway's readiness record. */
interface Readiness {
  readonly port: number
}

/** One launched gateway process and what is known about it. */
interface Child {
  readonly handle: SubprocessHandle
  /** The wire client, set once the gateway passed every readiness check. */
  wire?: ShieldWireEngine
  /** Whether the supervisor stopped the process for missing its startup deadline. */
  timedOut: boolean
  /** A deterministic failure: the gateway will not be restarted automatically. */
  terminal?: string
  /** Why startup failed, when it did. */
  failure?: string
  /** Rejects once this process ends or is stopped, so in-flight asks fail promptly. */
  readonly closed: Promise<never>
  /** Settle {@link closed}. */
  readonly close: (reason: JudgmentError) => void
}

/** Stderr bytes retained for exit diagnostics. */
export const STDERR_TAIL_BYTES = 8 * 1024
/** Largest accepted readiness line. */
const MAX_READINESS_BYTES = 64 * 1024
/** Question id of the startup smoke ask. */
export const SMOKE_QUESTION_ID = judgmentQuestionId('laya-startup-check')
/** Gateway exit code for a manifest or checkpoint mismatch; never restarted automatically. */
const EXIT_CHECKPOINT_MISMATCH = 3

/** Supervises one gateway process for one provider instance. */
export class LayaGatewaySupervisor {
  private current: LayaGatewayStatus = { state: 'stopped', detail: 'not started' }
  private readonly listeners = new Set<(status: LayaGatewayStatus) => void>()
  private generation = 0
  private child: Child | undefined
  private lastExit: LayaGatewayExit | undefined
  private restarts: number[] = []
  private consecutiveFailures = 0
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private disposed = false
  private disposal: Promise<void> | undefined

  /**
   * @param options - configuration, preflight, spawn, redaction, and logger.
   */
  constructor(private readonly options: LayaSupervisorOptions) {}

  /**
   * The current published status.
   * @returns the latest status.
   */
  status(): LayaGatewayStatus {
    return this.current
  }

  /**
   * Facts about the last gateway exit.
   * @returns the exit record, or undefined before any exit.
   */
  exit(): LayaGatewayExit | undefined {
    return this.lastExit
  }

  /**
   * Observe status changes. Listener exceptions are logged and never
   * interrupt publication to other listeners.
   * @param listener - receives each published status.
   * @returns the unsubscribe function.
   */
  onStatus(listener: (status: LayaGatewayStatus) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Begin supervising: launch now and restart on crashes. Idempotent. */
  start(): void {
    if (this.disposed || this.running) return
    this.running = true
    void this.launch()
  }

  /**
   * Stop supervising and wait for the gateway to exit. The restart budget resets.
   * @param detail - reason published with the `stopped` status.
   */
  async stop(detail: string): Promise<void> {
    this.running = false
    this.clearRestart()
    await this.stopChild(detail)
    this.restarts = []
    this.consecutiveFailures = 0
    this.publish({ state: 'stopped', detail })
  }

  /** Stop, reset the restart budget, and launch again. */
  async restart(): Promise<void> {
    await this.stop('restarting')
    this.start()
  }

  /**
   * Dispose: clear listeners first so late completions stay silent, fail
   * in-flight asks, terminate the process tree, and wait for it to exit.
   * @returns a promise settled once the gateway has exited; repeated calls share it.
   */
  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.disposed = true
      this.running = false
      this.listeners.clear()
      this.clearRestart()
      this.current = { state: 'stopped', detail: 'disposed' }
      await this.stopChild('was disposed')
    })()
    return this.disposal
  }

  /**
   * Answer one ask through the ready gateway.
   * @param input - state, questions, tier, and caller signal.
   * @returns the validated answers.
   * @throws JudgmentError `UNAVAILABLE` when the gateway is not ready or stops
   *   during the ask, otherwise the wire client's classified failure.
   */
  async ask(input: JudgmentInput): Promise<JudgmentResult> {
    const child = this.readyChild()
    return race(child.wire.ask(input), child)
  }

  /**
   * Fit and answer one ask through the ready gateway.
   * @param input - ordered states, questions, tier, and caller signal.
   * @returns the measured fit and answers, or a capacity rejection.
   * @throws JudgmentError as {@link ask}.
   */
  async askFitted(input: JudgmentFittingInput): Promise<JudgmentFittingResult> {
    const child = this.readyChild()
    return race(child.wire.fitting.ask(input), child)
  }

  /** The ready child, or an UNAVAILABLE failure naming the current status. */
  private readyChild(): Child & { wire: ShieldWireEngine } {
    const child = this.child
    if (child?.wire === undefined) {
      const { state, detail } = this.current
      throw new JudgmentError('UNAVAILABLE', `judgment-laya gateway is ${state}${detail === undefined ? '' : `: ${detail}`}`)
    }
    return child as Child & { wire: ShieldWireEngine }
  }

  /** One launch attempt; every await re-checks that this attempt is still current. */
  private async launch(): Promise<void> {
    const generation = ++this.generation
    this.publish({ state: 'starting' })
    let preflight: LaunchPreflight
    try {
      preflight = await this.options.preflight()
    } catch (error: unknown) {
      if (this.generation === generation) this.publish({ state: 'unavailable', detail: `launch preflight failed: ${describeError(error)}` })
      return
    }
    if (this.generation !== generation) return
    if (preflight.kind !== 'launch') {
      this.publish({ state: preflight.kind, detail: preflight.detail })
      return
    }
    const child = this.spawnChild(preflight.plan)
    if (child === undefined) return
    try {
      const { port } = await this.awaitReadiness(child)
      const endpoint = `http://127.0.0.1:${port}`
      await this.checkHealth(endpoint)
      const { config } = this.options
      const wire = createShieldWireEngine({
        ...resolveShieldConfig({
          endpoint,
          models: { fast: config.modelId, accurate: config.modelId },
          timeoutMs: config.requestTimeoutMs,
          maxRequestBytes: config.maxRequestBytes,
          maxResponseBytes: config.maxResponseBytes,
        }),
        redact: this.options.redact,
        label: 'judgment-laya',
      })
      await wire.ask({
        state: 'startup check',
        questions: [{ kind: 'binary', id: SMOKE_QUESTION_ID, instructions: 'Is this text a startup check?' }],
      })
      if (this.child !== child) return
      child.wire = wire
      this.consecutiveFailures = 0
      this.publish({ state: 'ready' })
    } catch (error: unknown) {
      if (this.child !== child) return
      child.failure ??= describeError(error)
      child.handle.terminate()
    }
  }

  /** Spawn one gateway process and attach its exit handling. */
  private spawnChild(plan: LaunchPlan): Child | undefined {
    let handle: SubprocessHandle
    try {
      handle = this.options.spawn({
        argv: plan.argv,
        cwd: plan.cwd,
        env: plan.env,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: STDERR_TAIL_BYTES } },
        graceMs: this.options.config.shutdownGraceMs,
      })
    } catch (error: unknown) {
      this.publish({ state: 'unavailable', detail: `the gateway could not be spawned: ${describeError(error)}` })
      return undefined
    }
    let close!: (reason: JudgmentError) => void
    const closed = new Promise<never>((_resolve, reject) => {
      close = reject
    })
    // Asks race against this promise; a process that ends with no ask in flight
    // must not surface an unhandled rejection.
    closed.catch(() => undefined)
    const child: Child = { handle, timedOut: false, closed, close }
    this.child = child
    handle.done.then(
      (outcome) => {
        this.onExit(child, outcome.exitCode, outcome.signal)
      },
      (error: unknown) => {
        child.failure ??= `the gateway failed to start: ${describeError(error)}`
        this.onExit(child, null, null)
      },
    )
    return child
  }

  /** Record one exit, fail in-flight asks, publish unavailable, then maybe restart. */
  private onExit(child: Child, exitCode: number | null, signal: string | null): void {
    const exit: LayaGatewayExit = {
      exitCode,
      signal,
      timedOut: child.timedOut,
      /* v8 ignore next -- stderr is always spawned in collect mode, so its reader exists. */
      stderrTail: child.handle.collected.stderr?.readFrom(0).text ?? '',
    }
    this.lastExit = exit
    const detail = describeExit(exit, child)
    child.close(new JudgmentError('UNAVAILABLE', `judgment-laya gateway exited: ${detail}`))
    // A child is current only while supervision runs: stop() and dispose()
    // detach it before terminating it, so a detached child's exit ends here.
    if (this.child !== child) return
    this.child = undefined
    this.publish({ state: 'unavailable', detail })
    if (child.terminal !== undefined || exitCode === EXIT_CHECKPOINT_MISMATCH) return
    this.scheduleRestart(detail)
  }

  /** Schedule one restart with exponential backoff, or exhaust the budget. */
  private scheduleRestart(detail: string): void {
    const { maxRestarts, windowMs, backoffMs, maxBackoffMs } = this.options.config.restart
    const now = Date.now()
    this.restarts = this.restarts.filter(at => now - at < windowMs)
    if (this.restarts.length >= maxRestarts) {
      this.publish({
        state: 'unavailable',
        detail: `${detail}; restart budget of ${maxRestarts} per ${windowMs} ms exhausted; run /laya restart`,
      })
      return
    }
    this.restarts.push(now)
    const delay = Math.min(backoffMs * 2 ** this.consecutiveFailures, maxBackoffMs)
    this.consecutiveFailures += 1
    this.options.logger.warn(`judgment-laya: restarting the gateway in ${delay} ms: ${detail}`)
    // stop() and dispose() clear this timer, so it only fires while running.
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      void this.launch()
    }, delay)
  }

  /** Cancel a pending restart. */
  private clearRestart(): void {
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer)
    this.restartTimer = undefined
  }

  /** Invalidate the running attempt, fail its asks, terminate it, and await its exit. */
  private async stopChild(detail: string): Promise<void> {
    this.generation += 1
    const child = this.child
    this.child = undefined
    if (child === undefined) return
    child.close(new JudgmentError('UNAVAILABLE', `judgment-laya gateway ${detail}`))
    child.handle.terminate()
    await child.handle.waitForExit()
    // `done` settles at process close, after which onExit has run; a spawn
    // failure already reported through onExit.
    await Promise.allSettled([child.handle.done])
  }

  /** Read and validate the first stdout line within the startup deadline. */
  private awaitReadiness(child: Child): Promise<Readiness> {
    const stdout = child.handle.stdout
    /* v8 ignore next -- the supervisor always spawns with stdout: 'pipe'. */
    if (stdout === undefined) return Promise.reject(new Error('the gateway has no stdout pipe'))
    const { startupTimeoutMs } = this.options.config
    // Decoding here keeps a multi-byte character split across chunks intact.
    stdout.setEncoding('utf8')
    return new Promise<Readiness>((resolve, reject) => {
      let buffer = ''
      // finish() removes both listeners and clears the timer, so it runs once.
      const finish = (outcome: { readiness: Readiness } | { error: Error }): void => {
        clearTimeout(timer)
        stdout.off('data', onData)
        stdout.off('end', onEnd)
        // Later stdout output is discarded so it can never fill the pipe.
        stdout.resume()
        if ('error' in outcome) reject(outcome.error)
        else resolve(outcome.readiness)
      }
      const timer = setTimeout(() => {
        child.timedOut = true
        finish({ error: new Error(`no readiness line within startupTimeoutMs ${startupTimeoutMs}`) })
      }, startupTimeoutMs)
      const onData = (chunk: string): void => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline >= 0) {
          const readiness = this.readReadiness(child, buffer.slice(0, newline))
          finish(typeof readiness === 'string' ? { error: new Error(readiness) } : { readiness })
        } else if (buffer.length > MAX_READINESS_BYTES) {
          finish({ error: new Error('the readiness line exceeds 64 KiB') })
        }
      }
      const onEnd = (): void => {
        finish({ error: new Error('the gateway exited before printing its readiness line') })
      }
      stdout.on('data', onData)
      stdout.on('end', onEnd)
    })
  }

  /**
   * Validate the readiness record against the configured pin.
   * @returns the readiness facts, or the failure message. An identity,
   *   manifest, or checkpoint-context mismatch also marks the child terminal.
   */
  private readReadiness(child: Child, line: string): Readiness | string {
    const { config } = this.options
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch (error: unknown) {
      return `the readiness line is not JSON: ${describeError(error)}`
    }
    if (!isRecord(record) || record.ready !== true) return 'the readiness line does not report ready'
    const port = record.port
    if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
      return 'the readiness line has no valid port'
    }
    if (record.model !== config.modelId) {
      child.terminal = `the gateway serves ${String(record.model)}, the configuration pins ${config.modelId}`
      return child.terminal
    }
    const limits = isRecord(record.limits) ? record.limits : {}
    if (record.manifestSha256 !== config.model.manifestSha256 || limits.manifestSha256 !== config.model.manifestSha256) {
      child.terminal = `manifest mismatch: the gateway reports ${String(record.manifestSha256)}, model.manifestSha256 pins ${config.model.manifestSha256}`
      return child.terminal
    }
    if (limits.maxSequenceTokens !== config.checkpointContext) {
      child.terminal = `checkpoint context mismatch: the gateway reports ${String(limits.maxSequenceTokens)}, checkpointContext is ${config.checkpointContext}`
      return child.terminal
    }
    return { port: port as number }
  }

  /** Require the gateway's health record to name the pinned model and manifest. */
  private async checkHealth(endpoint: string): Promise<void> {
    const { config } = this.options
    const response = await fetch(`${endpoint}/healthz`, {
      signal: AbortSignal.timeout(config.requestTimeoutMs),
      redirect: 'error',
    })
    if (!response.ok) throw new Error(`the gateway health check returned HTTP ${response.status}`)
    const body = await response.json() as unknown
    if (!isRecord(body) || body.ok !== true || body.model !== config.modelId || body.manifestSha256 !== config.model.manifestSha256) {
      throw new Error('the gateway health check does not report the pinned model and manifest')
    }
  }

  /** Publish one status to the current status and every listener. */
  private publish(status: LayaGatewayStatus): void {
    if (this.disposed) return
    this.current = status
    for (const listener of [...this.listeners]) {
      try {
        listener(status)
      } catch (error: unknown) {
        this.options.logger.error('judgment-laya: a status listener failed', error)
      }
    }
  }
}

/** Race an ask against its gateway's end, so a crash fails the ask as UNAVAILABLE. */
function race<T>(operation: Promise<T>, child: Child): Promise<T> {
  // The ask may settle after the gateway ended; its rejection is then unobserved.
  operation.catch(() => undefined)
  return Promise.race([operation, child.closed])
}

/** One-line description of a gateway exit. */
function describeExit(exit: LayaGatewayExit, child: Child): string {
  const parts: string[] = []
  if (child.failure !== undefined) parts.push(child.failure)
  parts.push(exit.signal === null ? `the gateway exited with code ${exit.exitCode}` : `the gateway exited on ${exit.signal}`)
  const tail = lastLines(exit.stderrTail, 1)
  if (tail !== '') parts.push(tail)
  return parts.join('; ')
}

/**
 * Render an unknown failure as text.
 * @param error - a thrown or rejected value.
 * @returns the error message, or the value's string form.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a value is a JSON object rather than null or an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
