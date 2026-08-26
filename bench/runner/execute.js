/**
 * Trial execution: spawn one headless harness run inside the trial's scratch
 * directory and locate the session log it leaves behind.
 *
 * The launch mirrors the repo's `pnpm shres` script (`node --import tsx/esm
 * apps/cli/src/bin.ts`) but pins the child cwd to the scratch dir, which the
 * CLI takes as the workspace root. tsx resolves through the repo root's own
 * node_modules, so a worktree without `pnpm install` fails loud at launch
 * resolution rather than mid-run.
 *
 * @module bench/runner/execute
 */

import { spawn } from 'node:child_process'
import { open, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isSeededPriorSession } from './session-layout.js'

/** Captured stdout/stderr are capped so a stuck loop cannot exhaust memory. */
const MAX_CAPTURE_BYTES = 8 << 20

/** Grace period between SIGTERM and SIGKILL when a run exceeds its timeout. */
export const KILL_GRACE_MS = 5_000

/**
 * SIGTERM a child on abort, then SIGKILL after `graceMs`. The disposer
 * removes the listener and cancels the SIGKILL timer; call it when the
 * child has closed so a late abort cannot SIGKILL an already-reaped pid,
 * and so dispose waits for exit (kill → await `close`) rather than
 * returning while the child is still dying.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {AbortSignal | undefined} signal
 * @param {number} [graceMs]
 * @returns {() => void} disposer.
 */
export function killOnAbort(child, signal, graceMs = KILL_GRACE_MS) {
  if (signal === undefined) return () => {}
  /** @type {ReturnType<typeof setTimeout> | null} */
  let killTimer = null
  const onAbort = () => {
    child.kill('SIGTERM')
    if (killTimer === null) killTimer = setTimeout(() => child.kill('SIGKILL'), graceMs)
  }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort)
  return () => {
    signal.removeEventListener('abort', onAbort)
    if (killTimer !== null) clearTimeout(killTimer)
  }
}

/**
 * @typedef {object} HarnessLaunch
 * @property {string} command - the node executable.
 * @property {string[]} argsPrefix - `--import tsx/esm` plus the CLI entry, before CLI flags.
 */

/**
 * Resolve the source-launch argv for the harness CLI. Throws when the repo's
 * dependencies are not installed, naming the remedy.
 * @param {string} repoRoot - absolute repository root (the dir with package.json).
 * @returns {HarnessLaunch} executable plus leading arguments.
 */
export function resolveHarnessLaunch(repoRoot) {
  const repoRequire = createRequire(join(repoRoot, 'package.json'))
  let tsxEsmPath
  try {
    tsxEsmPath = repoRequire.resolve('tsx/esm')
  } catch {
    // createRequire#resolve only fails here when node_modules is absent.
    throw new Error(`cannot resolve tsx/esm from ${repoRoot}; run \`pnpm install\` in the harness repo first`)
  }
  return {
    command: process.execPath,
    argsPrefix: ['--import', pathToFileURL(tsxEsmPath).href, join(repoRoot, 'apps/cli/src/bin.ts')],
  }
}

/**
 * @typedef {object} ExecutionResult
 * @property {number | null} exitCode - process exit code; null when killed by a signal.
 * @property {boolean} timedOut - the run exceeded timeoutMs and was killed.
 * @property {string} stdout - captured stdout (capped).
 * @property {string} stderr - captured stderr (capped).
 * @property {number} durationMs - wall time from spawn to exit.
 * @property {string | null} sessionLogPath - absolute top-level session log, when found.
 */

/**
 * Read just the first line of a text file without loading the whole log.
 * @param {string} path - file to read.
 * @returns {Promise<string>} contents up to the first newline.
 */
async function readFirstLine(path) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.toString('utf8', 0, bytesRead).split('\n', 1)[0]
  } finally {
    await handle.close()
  }
}

/**
 * Locate the trial's top-level session log under its per-trial persistence
 * root. Child sessions (subagents) share the root, so candidates filter on the
 * header's `delegationDepth: 0` and prefer the header whose cwd is the scratch
 * dir. Seeded prior-session fixtures (`bench-prior-*`) are never the trial
 * transcript, even when they share cwd. Remaining ties prefer newer
 * `createdAt`, then sorted path.
 * @param {string} sessionLogRoot - per-trial persistence root from the arm overlay.
 * @param {string} scratchDir - the trial's scratch cwd.
 * @returns {Promise<string | null>} absolute session.jsonl path, or null when absent.
 */
export async function findSessionLog(sessionLogRoot, scratchDir) {
  /** @type {string[]} */
  const candidates = []
  /** @param {string} dir */
  const walk = async dir => {
    /** @type {import('node:fs').Dirent[]} */
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // The root simply does not exist when the run died before first append.
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name === 'session.jsonl') candidates.push(path)
    }
  }
  await walk(sessionLogRoot)

  /** @type {{ path: string, cwdMatch: boolean, createdAt: number }[]} */
  const eligible = []
  for (const path of candidates) {
    /** @type {{ type?: unknown, delegationDepth?: unknown, cwd?: unknown, id?: unknown, createdAt?: unknown }} */
    let header
    try {
      header = JSON.parse(await readFirstLine(path))
    } catch {
      // A header that does not parse cannot vouch for its depth; skip it.
      continue
    }
    if (header.type !== 'session' || header.delegationDepth !== 0) continue
    if (isSeededPriorSession(header.id)) continue
    eligible.push({
      path,
      cwdMatch: header.cwd === scratchDir,
      createdAt: typeof header.createdAt === 'number' && Number.isFinite(header.createdAt) ? header.createdAt : 0,
    })
  }
  const cwdHits = eligible.filter(entry => entry.cwdMatch)
  const pool = cwdHits.length > 0 ? cwdHits : eligible
  if (pool.length === 0) return null
  pool.sort((a, b) => b.createdAt - a.createdAt || a.path.localeCompare(b.path))
  return pool[0].path
}

/**
 * Run one headless trial to completion or timeout. Never rejects for an
 * ordinary nonzero exit; only spawn-level failures (node missing) throw.
 * @param {object} options
 * @param {string} options.repoRoot - harness repository root.
 * @param {string} options.overlayPath - absolute path of the arm `--patch` overlay.
 * @param {string[]} [options.extraPatchPaths] - additional `--patch` overlays (e.g. tier patch), applied after the arm overlay.
 * @param {string} options.taskText - the task instruction, passed as the app argument.
 * @param {string} options.scratchDir - trial scratch dir; becomes the child cwd.
 * @param {string} options.sessionLogRoot - per-trial persistence root baked into the overlay.
 * @param {number} options.timeoutMs - task timeout from task.json.
 * @param {NodeJS.ProcessEnv} options.env - child environment (carries API key, SHRES_HOME).
 * @param {AbortSignal} [options.signal] - abort kills the child (SIGTERM, then SIGKILL) and waits for exit.
 * @returns {Promise<ExecutionResult>} the execution record.
 */
export async function executeTrial({ repoRoot, overlayPath, extraPatchPaths = [], taskText, scratchDir, sessionLogRoot, timeoutMs, env, signal }) {
  const launch = resolveHarnessLaunch(repoRoot)
  const patchArgs = ['--patch', overlayPath, ...extraPatchPaths.flatMap(p => ['--patch', p])]
  const argv = [...launch.argsPrefix, '--profile', 'headless', ...patchArgs, taskText]
  const startedAt = Date.now()

  if (signal?.aborted) {
    return { exitCode: null, timedOut: false, stdout: '', stderr: '', durationMs: 0, sessionLogPath: null }
  }

  const child = spawn(launch.command, argv, { cwd: scratchDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString()
  })
  child.stderr.on('data', chunk => {
    if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString()
  })

  const { exitCode, timedOut } = await new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let timeoutFired = false
    /** @type {ReturnType<typeof setTimeout> | null} */
    let killTimer = null
    const detachAbort = killOnAbort(child, signal)
    const timer = setTimeout(() => {
      if (settled) return
      timeoutFired = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
    }, timeoutMs)
    const finish = (result, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      detachAbort()
      if (error !== undefined) rejectPromise(error)
      else resolvePromise(result)
    }
    child.on('error', error => {
      finish(undefined, error)
    })
    child.on('close', code => {
      finish({ exitCode: code, timedOut: timeoutFired })
    })
  })

  return {
    exitCode,
    timedOut,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
    sessionLogPath: await findSessionLog(sessionLogRoot, scratchDir),
  }
}
