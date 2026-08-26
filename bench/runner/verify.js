/**
 * Task verifier execution: run the task's `verify` command against the trial's
 * scratch directory and map the outcome onto the Trial verifier record. Exit
 * code 0 means resolved; any other outcome (including verifier timeout) means
 * `VERIFY_FAILED` — a delivered verdict, so the trial keeps status `success`.
 *
 * @module bench/runner/verify
 */

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { killOnAbort } from './execute.js'

/** Verifier runs are local and fast; two minutes is generous headroom. */
export const VERIFY_TIMEOUT_MS = 120_000

/** Conventional exit codes for outcomes the verifier itself never reported. */
const EXIT_TIMEOUT = 124
const EXIT_SPAWN_FAILURE = 127

/** Captured verifier output is capped so a runaway print cannot exhaust memory. */
const MAX_CAPTURE_BYTES = 1 << 20

/**
 * @typedef {object} VerifierOutcome
 * @property {string} command - the recorded command: task `verify` string plus scratch dir.
 * @property {number} exitCode - process exit code, or a conventional code for timeout/spawn failure.
 * @property {string} [detail] - last non-empty output line, truncated.
 * @property {boolean} resolved - whether the verifier passed.
 * @property {string | null} failureMode - `VERIFY_FAILED` when unresolved, else null.
 */

/**
 * Turn `node verify.mjs` into an argv: the launcher `node` becomes the current
 * executable and script arguments resolve against the task directory.
 * @param {string} verify - the task.json `verify` string.
 * @param {string} taskDir - absolute task directory.
 * @returns {string[]} argv without the scratch-dir argument.
 */
function verifyArgv(verify, taskDir) {
  const tokens = verify.split(/\s+/).filter(token => token.length > 0)
  if (tokens.length === 0) throw new Error('task verify command is empty')
  return tokens.map((token, index) => {
    if (index === 0 && token === 'node') return process.execPath
    if (index > 0 && /\.(mjs|cjs|js)$/.test(token)) return resolve(taskDir, token)
    return token
  })
}

/**
 * Run the verifier in the scratch directory. Never rejects for an ordinary
 * nonzero exit; spawn failures and timeouts fold into conventional exit codes.
 * @param {{ taskDir: string, verify: string, scratchDir: string, timeoutMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<VerifierOutcome>} the verifier outcome.
 */
export async function runVerifier({ taskDir, verify, scratchDir, timeoutMs = VERIFY_TIMEOUT_MS, signal }) {
  const command = `${verify} ${scratchDir}`
  const argv = [...verifyArgv(verify, taskDir), scratchDir]
  const child = spawn(argv[0], argv.slice(1), { cwd: scratchDir, stdio: ['ignore', 'pipe', 'pipe'] })

  let output = ''
  const capture = chunk => {
    if (output.length < MAX_CAPTURE_BYTES) output += chunk.toString()
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)

  const outcome = await new Promise(resolvePromise => {
    let settled = false
    /** @type {ReturnType<typeof setTimeout>} */
    let timer
    const detachAbort = killOnAbort(child, signal)
    const settle = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      detachAbort()
      resolvePromise(result)
    }
    timer = setTimeout(() => {
      child.kill('SIGTERM')
      settle({ exitCode: EXIT_TIMEOUT, detail: `verifier timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    child.on('error', error => {
      settle({ exitCode: EXIT_SPAWN_FAILURE, detail: `verifier failed to start: ${error.message}` })
    })
    child.on('close', code => {
      settle({ exitCode: code ?? EXIT_SPAWN_FAILURE, detail: undefined })
    })
  })

  const resolved = outcome.exitCode === 0
  const lastLine = output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .at(-1)
  const detail = outcome.detail ?? lastLine?.slice(0, 200)
  return {
    command,
    exitCode: outcome.exitCode,
    ...(detail === undefined ? {} : { detail }),
    resolved,
    failureMode: resolved ? null : 'VERIFY_FAILED',
  }
}
