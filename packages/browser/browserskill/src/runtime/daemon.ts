/** Own one foreground bsk daemon, with recorded startup and confirmed-exit teardown. */
import type { ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { format } from 'node:util'
import { deadline, timeoutOf } from '@shres-code/shres-code-timeout'
import { argv, BskRunner, observedChildError, parseDaemonStatus } from './runner.ts'
import { isPortOccupied } from './endpoints.ts'
import { BSK_VERSION } from './manifest.ts'
import type { ResolvedBrowserSkillConfig } from '../config.ts'

/** The daemon could not reach readiness on the requested port. */
export class DaemonStartError extends Error {
  constructor(message: string) { super(message); this.name = 'DaemonStartError' }
}
/** The requested endpoint is occupied; no peer is stopped. */
export class DaemonPortInUseError extends DaemonStartError {
  constructor(readonly port: number) {
    super('daemon port ' + String(port) + ' is already in use')
    this.name = 'DaemonPortInUseError'
  }
}
/** Exit could not be confirmed; the caller must retain the recorded pid and lease. */
export class DaemonExitError extends Error {
  constructor(message: string) { super(message); this.name = 'DaemonExitError' }
}
/** One spawned daemon, including the interval before readiness. */
export interface StartedDaemon {
  readonly child: ChildProcess
  readonly port: number
}
/** Dependencies of the owned daemon. */
export interface BskDaemonOptions {
  runner: BskRunner
  config: ResolvedBrowserSkillConfig
}

function hasExited(child: ChildProcess): boolean { return child.exitCode !== null || child.signalCode !== null }

/** One child lifetime; failed teardown retains ownership for a later retry. */
export class BskDaemon {
  private readonly runner: BskRunner
  private readonly config: ResolvedBrowserSkillConfig
  private started: (StartedDaemon & { ready: boolean; removeExitBackstop: () => void }) | undefined
  private stopping: Promise<void> | undefined
  private force = new AbortController()
  private forceError: unknown

  constructor(options: BskDaemonOptions) { this.runner = options.runner; this.config = options.config }
  /** The owned child, including startup or incomplete shutdown. */
  get current(): StartedDaemon | undefined { return this.started }

  /**
   * Read status through the owned BSK_HOME without trusting an unrelated response.
   * @param signal - optional cancellation of the status command.
   * @returns parsed status, or undefined when the CLI cannot answer.
   */
  async queryStatus(signal?: AbortSignal): Promise<ReturnType<typeof parseDaemonStatus> | undefined> {
    try { return await this.runner.runJson(argv.status(), parseDaemonStatus, { timeoutMs: this.config.commandTimeoutMs }, signal) }
    catch { return undefined } // Missing, malformed, failed and cancelled status all mean readiness is unproven.
  }

  /**
   * Check the exact recorded pid against the daemon answering on the owned home.
   * @param recordedPid - pid stored in the lease.
   * @returns whether the response names that pid.
   */
  async pidMatches(recordedPid: number): Promise<boolean> { return (await this.queryStatus())?.pid === recordedPid }

  /**
   * Spawn, persist the pid, and prove version, port and process identity.
   * @param port - persisted daemon endpoint.
   * @param options - operation cancellation and awaited durable pid recording.
   * @returns the exact child whose readiness was proved.
   * @throws DaemonStartError for startup failure; DaemonExitError if cleanup cannot confirm exit.
   */
  async start(port: number, options: { signal: AbortSignal; onSpawned: (pid: number) => Promise<void> }): Promise<StartedDaemon> {
    if (this.started !== undefined) throw new DaemonStartError('an owned daemon already exists')
    this.force = new AbortController()
    this.forceError = undefined
    options.signal.throwIfAborted()
    if (await isPortOccupied(port)) throw new DaemonPortInUseError(port)
    options.signal.throwIfAborted()
    let child: ChildProcess
    try { child = await this.runner.spawnLongLived(argv.daemonStart(port)) }
    catch (error) { throw new DaemonStartError(String(error)) }
    const killAtHostExit = (): void => { this.signalKill(child) }
    const removeExitBackstop = (): void => { process.off('exit', killAtHostExit); child.off('exit', removeExitBackstop) }
    const owned = { child, port, ready: false, removeExitBackstop }
    this.started = owned
    if (!hasExited(child)) {
      process.once('exit', killAtHostExit)
      child.once('exit', removeExitBackstop)
    }
    if (this.force.signal.aborted) this.signalKill(child)
    using bound = deadline(AbortSignal.any([options.signal, this.force.signal]), this.config.daemonReadyTimeoutMs, 'BSK_DAEMON_READY')
    let lastError = 'no status'
    try {
      if (child.pid === undefined) throw new DaemonStartError('spawned daemon has no pid')
      await options.onSpawned(child.pid)
      for (;;) {
        bound.signal.throwIfAborted()
        const failure = observedChildError(child)
        if (failure !== undefined) throw new DaemonStartError(failure.message)
        if (hasExited(child)) {
          if (await isPortOccupied(port)) throw new DaemonPortInUseError(port)
          throw new DaemonStartError('daemon exited during startup')
        }
        const status = await this.queryStatus(bound.signal)
        bound.signal.throwIfAborted()
        if (status !== undefined && status.daemonVersion === BSK_VERSION && status.wsPort === port && status.pid === child.pid) {
          owned.ready = true
          return owned
        }
        lastError = status === undefined ? 'status did not answer' : 'status version, port, or pid did not match the owned daemon'
        await delay(250, undefined, { signal: bound.signal })
      }
    } catch (error) {
      await this.stop()
      if (timeoutOf(bound.signal, 'BSK_DAEMON_READY') !== undefined) {
        throw new DaemonStartError('daemon not ready within ' + String(this.config.daemonReadyTimeoutMs) + 'ms: ' + lastError)
      }
      if (options.signal.aborted) throw options.signal.reason
      throw error
    }
  }

  /** Escalate shutdown without starting another stop; cancel the startup operation before calling. stop() retains exit verification. */
  forceStop(): void {
    if (this.force.signal.aborted) return
    this.force.abort()
    if (this.started !== undefined) this.signalKill(this.started.child)
  }

  private signalKill(child: ChildProcess): void {
    if (hasExited(child)) return
    try { child.kill('SIGKILL') }
    catch (error) { this.forceError = error }
  }

  /** Stop the owned child once; preserve it when exit cannot be confirmed. */
  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    if (!this.force.signal.aborted) this.forceError = undefined
    const pending = this.stopOwned()
    this.stopping = pending
    const clear = (): void => {
      this.stopping = undefined
      if (this.started !== undefined && this.force.signal.aborted) this.force = new AbortController()
    }
    void pending.then(clear, clear)
    return pending
  }

  private async stopOwned(): Promise<void> {
    const owned = this.started
    if (owned === undefined) return
    const { child } = owned
    const forced = this.force.signal
    if (!hasExited(child) && owned.ready && !forced.aborted) {
      const exited = this.awaitExit(child, 12_000, forced)
      try { await this.runner.run(argv.daemonStop(), { timeoutMs: Math.max(this.config.commandTimeoutMs, 15_000) }, forced) }
      catch { /* A failed graceful request is followed by signals to the owned child only. */ }
      await exited
    }
    if (!hasExited(child) && !forced.aborted) {
      const exited = this.awaitExit(child, 5_000, forced)
      child.kill('SIGTERM')
      await exited
    }
    if (!hasExited(child)) {
      const exited = this.awaitExit(child, 5_000)
      if (!forced.aborted) this.signalKill(child)
      await exited
    }
    if (!hasExited(child)) throw new DaemonExitError('shutdown incomplete: owned daemon pid ' + String(child.pid) + ' still running' + (this.forceError === undefined ? '' : ': ' + format('%s', this.forceError)))
    owned.removeExitBackstop()
    for (const stream of child.stdio) stream?.destroy()
    this.started = undefined
  }

  /** Called synchronously while exit and cancellation are pending, before any signal is sent. */
  private awaitExit(child: ChildProcess, ms: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        child.off('exit', finish)
        signal?.removeEventListener('abort', finish)
        resolve(hasExited(child))
      }
      const timer = setTimeout(finish, ms)
      child.once('exit', finish)
      signal?.addEventListener('abort', finish, { once: true })
    })
  }
}
