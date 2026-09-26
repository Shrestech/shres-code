/**
 * The bounded bsk CLI runner. Every invocation spawns the pinned executable
 * by absolute path with an argument array (never a shell), rechecks the
 * executable hash immediately before spawning, and runs under an explicit
 * allowlisted environment: no inherited `BSK_*` variable, no per-harness home
 * overrides, no harness credentials — only the fixed system paths plus the
 * owned home directories this package creates.
 *
 * Commands await exit and bounded pipe drainage. Abort, deadline, and output
 * overflow stop the child; inherited pipes cannot keep a result pending after
 * exit. Complete stdout is retained or explicitly refused, never truncated.
 *
 * @module @shres-code/shres-code-browserskill/runtime/runner
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { deadline, timeoutOf } from '@shres-code/shres-code-timeout'
import { isJsonValue } from '@shres-code/shres-code-session'
import { BSK_OWNED_LABEL, BSK_VERSION } from './manifest.ts'
import { sha256File } from './extract.ts'
import type { ResolvedBrowserSkillConfig } from '../config.ts'
import type { BskSessionId, BrowserInstanceId } from '../types.ts'

/** Fixed command search path handed to every spawned child. */
const CHILD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

/** Combined stdout/stderr resource bound; exceeding it refuses the whole reply. */
const OUTPUT_BYTES = 1 << 20
/** Bounded process-exit and inherited-pipe grace after a stop or exit. */
const SETTLEMENT_GRACE_MS = 2_000
const childErrors = new WeakMap<ChildProcess, Error>()

/**
 * Read an asynchronously observed child failure without adding an unhandled error event.
 * @param child - daemon process created by this runner.
 * @returns the most recent child error, if any.
 */
export function observedChildError(child: ChildProcess): Error | undefined { return childErrors.get(child) }

/** Deadline code stamped on this runner's timeouts. */
const COMMAND_DEADLINE = 'BSK_COMMAND'

/** One completed CLI invocation; orthogonal outcomes are reported independently. */
export interface BskRunResult {
  /** Process exit code; `null` when terminated by a signal. */
  exitCode: number | null
  /** Terminating signal, when the child was killed. */
  signal: NodeJS.Signals | null
  /** Whether the deadline elapsed before the child closed. */
  timedOut: boolean
  /** Whether the caller's abort signal fired before the child closed. */
  aborted: boolean
  /** Complete bounded stdout, decoded as UTF-8. */
  stdout: string
  /** Complete bounded stderr, decoded as UTF-8. */
  stderr: string
}

/** The CLI invocation failed: nonzero exit, spawn error, or lost outcome. */
export class BskCommandError extends Error {
  constructor(message: string, readonly result: BskRunResult | undefined) {
    super(message)
    this.name = 'BskCommandError'
  }
}

/** A bsk wire reply did not carry the fields this runner requires. */
export class BskWireError extends Error {
  constructor(message: string) {
    super(`browserskill wire: ${message}`)
    this.name = 'BskWireError'
  }
}

/**
 * The explicit environment every spawned child receives. Nothing from
 * `process.env` is inherited: the map is built from fixed values plus the
 * owned directories under the root.
 * @param root - owned runtime root (holds `home`, `tmp`, `bsk-home`).
 * @param updateManifestUrl - update-manifest override, passed only when configured.
 * @returns the exact environment map for the child.
 */
export function buildChildEnv(root: string, updateManifestUrl: string | undefined): Record<string, string> {
  const env: Record<string, string> = {
    PATH: CHILD_PATH,
    HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    BSK_HOME: join(root, 'bsk-home'),
    BSK_AUTO_START: '0',
    BSK_AUTO_UPDATE: 'off',
  }
  if (updateManifestUrl !== undefined) env.BSK_UPDATE_MANIFEST_URL = updateManifestUrl
  return env
}

/**
 * Fixed argv templates for the bounded command set. Model-controlled values
 * (URL, ref, value, key) are validated by the supervisor before reaching
 * here; no value is ever placed where it could parse as a flag: positionals
 * follow the `--` separator, and the fill value rides the `--value=` form.
 */
export const argv = {
  status: (): string[] => ['status', '--json'],
  browsers: (): string[] => ['browsers', '--json'],
  daemonStart: (port: number): string[] => ['daemon', 'start', '--foreground', '--port', String(port)],
  daemonStop: (): string[] => ['daemon', 'stop'],
  sessionStart: (instance: BrowserInstanceId): string[] =>
    ['session', 'start', '--json', '--browser', instance, '--no-focus', '--name', BSK_OWNED_LABEL],
  sessionStop: (session: BskSessionId): string[] => ['session', 'stop', '--json', session],
  navigate: (session: BskSessionId, url: URL): string[] => ['navigate', '--json', '--session', session, '--', url.href],
  observe: (session: BskSessionId): string[] => ['observe', '--json', '--session', session],
  click: (session: BskSessionId, ref: string): string[] => ['click', '--json', '--session', session, '--ref', ref],
  fill: (session: BskSessionId, ref: string, value: string): string[] =>
    ['fill', '--json', '--session', session, '--ref', ref, `--value=${value}`],
  press: (session: BskSessionId, key: string): string[] => ['press', '--json', '--session', session, '--', key],
} as const

/** The daemon status wire reply fields the readiness check requires. */
export interface DaemonStatusWire {
  daemonVersion: string
  pid: number
  wsPort: number
}

/** One connected-browser entry of the daemon status wire reply. */
export interface DaemonBrowserWire {
  instanceId: BrowserInstanceId
  label: string
}

/** Unknown wire content — validate before trusting, at this parse point. */
function assertObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BskWireError(`${what} is not a JSON object`)
  }
  return raw as Record<string, unknown>
}

function assertInt(raw: unknown, what: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new BskWireError(`${what} is not an integer`)
  }
  return raw
}

function assertString(raw: unknown, what: string): string {
  if (typeof raw !== 'string') throw new BskWireError(`${what} is not a string`)
  return raw
}

/**
 * Parse and validate the `status --json` wire reply.
 * @param raw - parsed JSON output of the status call.
 * @returns the fields the readiness and health checks consume.
 * @throws BskWireError when a required field is missing or mistyped.
 */
export function parseDaemonStatus(raw: unknown): DaemonStatusWire {
  const wire = assertObject(raw, 'status reply')
  return {
    daemonVersion: assertString(wire.daemon_version, 'status daemon_version'),
    pid: assertInt(wire.pid, 'status pid'),
    wsPort: assertInt(wire.ws_port, 'status ws_port'),
  }
}

/**
 * Parse and validate the `browsers --json` wire reply.
 * @param raw - parsed JSON output of the browsers call.
 * @returns the connected instances with their labels.
 * @throws BskWireError when the reply is not an array of entries.
 */
export function parseBrowsers(raw: unknown): readonly DaemonBrowserWire[] {
  if (!Array.isArray(raw)) throw new BskWireError('browsers reply is not an array')
  return raw.map((entry) => {
    const wire = assertObject(entry, 'browsers entry')
    return { instanceId: assertString(wire.instance_id, 'browsers instance_id') as BrowserInstanceId, label: assertString(wire.label, 'browsers label') }
  })
}

/**
 * Parse and validate the `session start --json` wire reply.
 * @param raw - parsed JSON output of the start call.
 * @returns the session id and the browser instance it bound.
 * @throws BskWireError when a required field is missing or mistyped.
 */
export function parseSessionStart(raw: unknown): { sessionId: BskSessionId; browserInstanceId: BrowserInstanceId } {
  const wire = assertObject(raw, 'session start reply')
  return {
    sessionId: assertString(wire.session_id, 'start session_id') as BskSessionId,
    browserInstanceId: assertString(wire.browser_instance_id, 'start browser_instance_id') as BrowserInstanceId,
  }
}

/** Constructor dependencies of {@link BskRunner}. */
export interface BskRunnerOptions {
  /** Owned runtime root the child homes resolve under. */
  root: string
  /** Validated deployment config. */
  config: ResolvedBrowserSkillConfig
  /** Absolute path of the pinned bsk executable. */
  executablePath: string
  /** Expected SHA-256 of the executable; rechecked before every spawn. */
  binarySha256: string
  /** Effective update-manifest URL passed through the environment. */
  updateManifestUrl: string | undefined
}

/**
 * Runs bounded bsk CLI commands against the pinned executable. One instance
 * per runtime; every method is safe to call while another is outstanding.
 */
export class BskRunner {
  private readonly options: BskRunnerOptions

  constructor(options: BskRunnerOptions) {
    this.options = options
  }

  /**
   * Verify the executable hash and fail closed on a mismatch. Called
   * immediately before every spawn: a replaced binary never runs.
   * @throws BskCommandError when the hash differs from the pin.
   */
  async verifyExecutable(): Promise<void> {
    const actual = await sha256File(this.options.executablePath)
    if (actual !== this.options.binarySha256) {
      throw new BskCommandError(
        `browserskill: bsk executable hash mismatch: expected ${this.options.binarySha256}, found ${actual}`,
        undefined,
      )
    }
  }

  /**
   * Run one CLI command to completion under the command deadline. The child
   * gets no shell, the allowlisted environment, and SIGKILL on timeout or
   * abort. Exit and inherited-pipe waits are bounded; overflow refuses the reply.
   * @param argv_ - the exact argument array after the executable.
   * @param overrides - optional per-call deadline in milliseconds.
   * @param signal - optional caller abort; the child is killed and the run reports `aborted`.
   * @returns the orthogonal run outcomes.
   * @throws BskCommandError when the hash recheck fails or the child cannot spawn.
   */
  async run(argv_: readonly string[], overrides?: { timeoutMs?: number }, signal?: AbortSignal): Promise<BskRunResult> {
    const abortedResult = (): BskRunResult => ({ exitCode: null, signal: null, timedOut: false, aborted: true, stdout: '', stderr: '' })
    if (signal?.aborted) return abortedResult()
    await this.verifyExecutable()
    if (signal?.aborted) return abortedResult()
    const { executablePath, root, config, updateManifestUrl } = this.options
    const child = spawn(executablePath, [...argv_], {
      env: buildChildEnv(root, updateManifestUrl), stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
    })
    using bound = deadline(signal, overrides?.timeoutMs ?? config.commandTimeoutMs, COMMAND_DEADLINE)
    return await new Promise<BskRunResult>((resolve, reject) => {
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let bytes = 0
      let overflow = false
      let failure: Error | undefined
      let exited = false
      let settled = false
      let exitTimer: NodeJS.Timeout | undefined
      let pipeTimer: NodeJS.Timeout | undefined
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(exitTimer)
        clearTimeout(pipeTimer)
        bound.signal.removeEventListener('abort', stop)
        for (const stream of child.stdio) stream?.destroy()
        if (overflow) { reject(new BskWireError('command output exceeds ' + String(OUTPUT_BYTES) + ' bytes')); return }
        if (failure !== undefined) { reject(new BskCommandError('bsk child failed: ' + failure.message, undefined)); return }
        resolve({ exitCode: child.exitCode, signal: child.signalCode,
          timedOut: timeoutOf(bound.signal, COMMAND_DEADLINE) !== undefined, aborted: signal?.aborted ?? false,
          stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
      }
      const stop = (): void => {
        if (settled || exited || exitTimer !== undefined) return
        exitTimer = setTimeout(() => {
          failure = new Error('owned command pid ' + String(child.pid) + ' did not exit after SIGKILL')
          finish()
        }, SETTLEMENT_GRACE_MS)
        child.kill('SIGKILL')
      }
      const collect = (chunks: Buffer[], chunk: Buffer): void => {
        if (settled || overflow) return
        if (chunk.byteLength > OUTPUT_BYTES - bytes) { overflow = true; stop(); return }
        bytes += chunk.byteLength
        chunks.push(chunk)
      }
      child.stdout.on('data', (chunk: Buffer) => { collect(stdout, chunk) })
      child.stderr.on('data', (chunk: Buffer) => { collect(stderr, chunk) })
      // Keep containment installed after settlement; late child errors cannot escape to the host.
      child.on('error', (error) => {
        if (settled) return
        failure = error
        if (child.pid === undefined) finish()
        else stop()
      })
      child.once('exit', () => {
        exited = true
        clearTimeout(exitTimer)
        pipeTimer = setTimeout(finish, SETTLEMENT_GRACE_MS)
      })
      child.once('close', finish)
      bound.signal.addEventListener('abort', stop, { once: true })
      if (bound.signal.aborted) stop()
    })
  }

  /**
   * Run one `--json` CLI command and parse its stdout. A nonzero exit or a
   * spawn failure becomes {@link BskCommandError}; a malformed reply becomes
   * {@link BskWireError}. Timed-out runs surface their independent
   * `timedOut` flag inside the error's result.
   * @param argv_ - the exact argument array after the executable.
   * @param validate - parse-point validator over the parsed JSON.
   * @param overrides - optional per-call deadline in milliseconds.
   * @param signal - optional caller abort.
   * @returns the validated wire value.
   * @throws BskCommandError on nonzero exit, timeout, abort, or spawn failure.
   * @throws BskWireError when the reply does not validate.
   */
  async runJson<T>(
    argv_: readonly string[],
    validate: (raw: unknown) => T,
    overrides?: { timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<T> {
    const result = await this.run(argv_, overrides, signal)
    if (result.aborted) {
      throw new BskCommandError(`bsk ${argv_[0]} aborted before completion`, result)
    }
    if (result.timedOut || result.signal !== null) {
      throw new BskCommandError(`bsk ${argv_[0]} did not complete within its deadline`, result)
    }
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).slice(0, 400)
      throw new BskCommandError(`bsk ${argv_.join(' ')} exited ${String(result.exitCode)}: ${detail}`, result)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout)
    } catch (error) {
      throw new BskWireError(`bsk ${argv_[0]} printed invalid JSON: ${String(error)}`)
    }
    if (!isJsonValue(parsed)) {
      throw new BskWireError(`bsk ${argv_[0]} printed non-JSON-compatible output`)
    }
    return validate(parsed)
  }

  /**
   * Spawn one long-lived child (the foreground daemon) with the same
   * environment and executable guarantees as {@link run}.
   * @param argv_ - the exact argument array after the executable.
   * @returns the spawned child with an error observer and drained output pipes.
   * @throws BskCommandError when the hash recheck fails or the child cannot spawn.
   */
  async spawnLongLived(argv_: readonly string[]): Promise<ChildProcess> {
    await this.verifyExecutable()
    const { executablePath, root, updateManifestUrl } = this.options
    const child = spawn(executablePath, [...argv_], {
      env: buildChildEnv(root, updateManifestUrl), stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
    })
    child.on('error', (error) => { childErrors.set(child, error) })
    return new Promise((resolve, reject) => {
      const failed = (error: Error): void => {
        child.off('spawn', spawned)
        for (const stream of child.stdio) stream?.destroy()
        reject(new BskCommandError('bsk daemon could not spawn: ' + error.message, undefined))
      }
      const spawned = (): void => {
        child.off('error', failed)
        child.stdout.resume()
        child.stderr.resume()
        resolve(child)
      }
      child.once('error', failed)
      child.once('spawn', spawned)
    })
  }

}

/** The pinned CLI version the wire replies must match. */
export const EXPECTED_DAEMON_VERSION = BSK_VERSION
