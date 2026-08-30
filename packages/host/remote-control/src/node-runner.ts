/**
 * Node adapter for the controller's {@link SshRunner} process seam: short
 * executions run piped-and-awaited; long-lived masters and forwards run as
 * children with a SIGTERM-then-SIGKILL disposer and an optional exit
 * observation. The adapter prepends the configured ssh command to the ssh
 * arguments every caller passes, so a deployment wrapper or a test fixture
 * substitutes the binary without touching the argument contract.
 * @module @shres-code/shres-code-host-remote-control/node-runner
 */

import { execFile, spawn } from 'node:child_process'
import type { SshRunner } from './controller.ts'

/** Short-ssh execution bound; long enough for a describe probe, short enough to fail usefully. */
const EXEC_TIMEOUT_MS = 15_000

/** Grace period a SIGTERM'd child gets before the disposer escalates to SIGKILL. */
const DISPOSE_ESCALATE_MS = 1_000

/**
 * Build the node adapter for the controller's runner seam — the executor used
 * by `shres remote connect` and the remoteAdmin gateway.
 * @param sshCommand - ssh binary or wrapper to execute; plain `ssh` by default.
 * @returns the runner over the given binary.
 */
export function nodeSshRunner(sshCommand = 'ssh'): SshRunner {
  return {
    async run(args) {
      return new Promise((resolveRun) => {
        execFile(sshCommand, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
          // Nonzero exits, timeouts, and missing binaries are all probe data: the controller's typed retry loop decides.
          const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : 255
          const stderrText = error !== null && typeof error.code !== 'number' ? `${stderr}${error.message}`.trim() : stderr
          resolveRun({ exitCode, stdout, stderr: stderrText })
        })
      })
    },
    spawn(args, onExit) {
      return new Promise((resolveSpawn, rejectSpawn) => {
        const child = spawn(sshCommand, args, { stdio: 'ignore' })
        child.once('error', (spawnError) => { rejectSpawn(new Error(`ssh spawn failed: ${String(spawnError)}`)) })
        if (onExit !== undefined) child.once('exit', (exitCode) => { onExit(exitCode) })
        child.once('spawn', () => {
          // The spawn event proves the process started, so the pid is set.
          // oxlint-disable-next-line typescript/no-non-null-assertion -- spawn event precedes this line
          const pid = child.pid!
          const exited = new Promise<void>((resolveExit) => { child.once('exit', () => { resolveExit() }) })
          const disposer = async (): Promise<void> => {
            if (child.exitCode !== null || child.signalCode !== null) return
            child.kill('SIGTERM')
            // Killing an already-exited child is a no-op, so the escalation timer
            // needs no liveness re-check; the normal path clears it before it fires.
            const escalate = setTimeout(() => { child.kill('SIGKILL') }, DISPOSE_ESCALATE_MS)
            await exited
            clearTimeout(escalate)
          }
          resolveSpawn({ pid, dispose: disposer })
        })
      })
    },
  }
}
