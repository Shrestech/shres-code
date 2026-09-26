/**
 * The pnpm runner the plugin transaction core uses for profile plugin
 * installs and removals: one no-shell pnpm spawn per call, bounded collected
 * output, a scrubbed child environment, and abort that reaches quiescence
 * before rejecting. Boot-time glue cannot route through `ctx.subprocess`
 * (the profile may provision before any host context exists), and
 * `runNativeCommand` is not reusable: its signature carries no cwd or env,
 * and it turns nonzero exits and startup failures into rejections instead of
 * outcomes.
 * @module @shres-code/shres-code-app-boot/profile-pnpm
 */

import { spawn } from 'node:child_process'
import { scrubbedParentEnv } from '@shres-code/shres-code-subprocess'

/**
 * Per-stream collected-output bound; the stream's tail is kept past it. A
 * bound, not a tunable: pnpm output lands in journals and error messages the
 * core prints, so no deployment wants unbounded collection.
 */
const MAX_OUTPUT_BYTES = 1024 * 1024

/** How long an aborted child may keep running after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2_000

/** POSIX signal numbers, reported as a 128 offset in a signal-terminated run's exit code. */
const SIGNAL_EXIT_NUMBERS: Partial<Record<NodeJS.Signals, number>> = {
  SIGKILL: 9,
  SIGTERM: 15,
}

/**
 * One completed pnpm run: its exit code and collected output. Startup
 * failures that never produced a process also resolve here: a pnpm missing
 * from the child PATH reports 127, one that cannot be executed reports 126,
 * and the spawn error's message arrives as stderr.
 */
export interface PnpmOutcome {
  /** The child's exit code, or 127/126 for a run that never started. */
  exitCode: number
  /** Collected stdout: the tail past the output bound, then the truncation label when bytes were dropped. */
  stdout: string
  /** Collected stderr under the same bound, plus the spawn error message for a run that never started. */
  stderr: string
}

/**
 * Run one pnpm invocation to completion.
 * @param args - pnpm argv, forwarded verbatim; never shell-interpreted.
 * @param options - `cwd` the child runs in; `signal` aborts the run.
 * @returns the run's outcome. The abort signal rejects — after the child was
 * killed and its close was observed — while every completed or
 * failed-to-start spawn resolves.
 */
export type PnpmRunner = (
  args: readonly string[],
  options: { cwd: string; signal: AbortSignal },
) => Promise<PnpmOutcome>

/**
 * Collected text for one stdio stream: the last {@link MAX_OUTPUT_BYTES}
 * bytes, plus the count of everything dropped before them.
 */
class BoundedStream {
  private parts: Buffer[] = []
  private bytes = 0
  private droppedBytes = 0

  /**
   * Record one stream chunk, trimming to the tail once the bound is passed.
   * @param chunk - the next bytes the child wrote.
   */
  push(chunk: Buffer): void {
    this.parts.push(chunk)
    this.bytes += chunk.length
    if (this.bytes <= MAX_OUTPUT_BYTES) return
    const merged = Buffer.concat(this.parts)
    this.droppedBytes += merged.length - MAX_OUTPUT_BYTES
    this.parts = [merged.subarray(merged.length - MAX_OUTPUT_BYTES)]
    this.bytes = MAX_OUTPUT_BYTES
  }

  /**
   * Collect the stream's text.
   * @returns the kept tail, followed by the truncation label when bytes were dropped.
   */
  text(): string {
    const body = Buffer.concat(this.parts).toString('utf8')
    return this.droppedBytes === 0
      ? body
      : `${body}\n[output truncated: ${this.droppedBytes} earlier bytes dropped]`
  }
}

/**
 * The production pnpm runner: spawns `pnpm` from the scrubbed parent PATH
 * with `shell: false`, an ignored stdin, and bounded piped stdout/stderr.
 * Refuses to run on win32 — the core's platform gate refuses earlier, this
 * is the backstop for a direct call. Abort sends SIGTERM and escalates to
 * SIGKILL after the grace period, and the rejection happens only after the
 * child's close, so a settled runner promise never leaves a live child.
 * @param args - literal pnpm arguments, passed without a shell.
 * @param options - profile cwd and the operation's cancellation signal.
 * @returns the settled exit code and bounded process output.
 */
export const nodePnpmRunner: PnpmRunner = (args, options) => {
  if (process.platform === 'win32') {
    return Promise.reject(new Error('nodePnpmRunner refuses to spawn pnpm on win32; the caller\'s platform gate must refuse before reaching the runner'))
  }
  if (options.signal.aborted) {
    return Promise.reject(new Error('pnpm aborted before spawn: the caller\'s signal was already aborted'))
  }
  return new Promise((resolve, reject) => {
    const stdout = new BoundedStream()
    const stderr = new BoundedStream()
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let aborted = false

    const child = spawn('pnpm', [...args], {
      cwd: options.cwd,
      env: scrubbedParentEnv(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const onAbort = (): void => {
      aborted = true
      child.kill('SIGTERM')
      graceTimer = setTimeout(() => { child.kill('SIGKILL') }, KILL_GRACE_MS)
    }
    const finish = (): void => {
      options.signal.removeEventListener('abort', onAbort)
      clearTimeout(graceTimer)
    }

    options.signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk) })

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish()
      resolve({
        exitCode: error.code === 'ENOENT' ? 127 : 126,
        stdout: stdout.text(),
        stderr: `pnpm: ${error.message}\n`,
      })
    })
    child.on('close', (code, signalName) => {
      finish()
      if (aborted) {
        reject(new Error('pnpm run aborted: the caller\'s signal killed the child and its close was awaited'))
        return
      }
      resolve({
        // When code is null the close contract guarantees signalName. A
        // spawn-failure close (a negative marker code on some platforms)
        // settled through the error handler already, so this outcome is
        // discarded by first settlement; unknown signals report 128.
        exitCode: code ?? 128 + (SIGNAL_EXIT_NUMBERS[signalName as NodeJS.Signals] ?? 0),
        stdout: stdout.text(),
        stderr: stderr.text(),
      })
    })
  })
}
