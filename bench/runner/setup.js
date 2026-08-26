/**
 * Optional per-task setup: run `node setup.mjs <scratch-dir> <session-log-root>`
 * after the fixture copy and before the harness spawn. Used to plant a prior
 * session into the trial persistence root. A failed setup is infrastructure
 * (HARNESS_ERROR), not a verifier miss.
 *
 * @module bench/runner/setup
 */

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

/** Setup is local filesystem work; thirty seconds is generous. */
export const SETUP_TIMEOUT_MS = 30_000

const EXIT_TIMEOUT = 124
const EXIT_SPAWN_FAILURE = 127
const MAX_CAPTURE_BYTES = 1 << 20

/**
 * Turn `node setup.mjs` into an argv: `node` becomes the current executable
 * and script arguments resolve against the task directory.
 * @param {string} setup - the task.json `setup` string.
 * @param {string} taskDir - absolute task directory.
 * @returns {string[]} argv without scratch-dir / session-root arguments.
 */
function setupArgv(setup, taskDir) {
  const tokens = setup.split(/\s+/).filter(token => token.length > 0)
  if (tokens.length === 0) throw new Error('task setup command is empty')
  return tokens.map((token, index) => {
    if (index === 0 && token === 'node') return process.execPath
    if (index > 0 && /\.(mjs|cjs|js)$/.test(token)) return resolve(taskDir, token)
    return token
  })
}

/**
 * Run the task setup against the trial scratch dir and persistence root.
 * Resolves on exit 0; rejects on nonzero, timeout, or spawn failure.
 * @param {object} options
 * @param {string} options.taskDir - absolute task directory.
 * @param {string} options.setup - task.json `setup` string.
 * @param {string} options.scratchDir - trial scratch dir (becomes header cwd).
 * @param {string} options.sessionLogRoot - per-spawn persistence root.
 * @param {number} [options.timeoutMs]
 * @returns {Promise<void>}
 */
export async function runSetup({ taskDir, setup, scratchDir, sessionLogRoot, timeoutMs = SETUP_TIMEOUT_MS }) {
  const argv = [...setupArgv(setup, taskDir), scratchDir, sessionLogRoot]
  const child = spawn(argv[0], argv.slice(1), { cwd: scratchDir, stdio: ['ignore', 'pipe', 'pipe'] })

  let output = ''
  const capture = chunk => {
    if (output.length < MAX_CAPTURE_BYTES) output += chunk.toString()
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)

  const outcome = await new Promise(resolvePromise => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      resolvePromise({ exitCode: EXIT_TIMEOUT, detail: `setup timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ exitCode: EXIT_SPAWN_FAILURE, detail: `setup failed to start: ${error.message}` })
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ exitCode: code ?? EXIT_SPAWN_FAILURE, detail: undefined })
    })
  })

  if (outcome.exitCode === 0) return
  const lastLine = output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .at(-1)
  const detail = outcome.detail ?? lastLine ?? `exit ${outcome.exitCode}`
  throw new Error(`setup failed (exit ${outcome.exitCode}): ${detail}`.slice(0, 200))
}
