/** Read-only process-group observation; a recorded group id never grants post-exit kill authority. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const execFileAsync = promisify(execFile)
const PS_ENV = { PATH: '/usr/bin:/bin' }

/**
 * Observe whether an owned child leads its own process group.
 * @param pid - live owned child pid.
 * @returns its group id only when it equals pid; otherwise no group authority.
 */
export async function observeOwnedGroup(pid: number): Promise<number | undefined> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL', maxBuffer: 1024, env: PS_ENV,
    }))
  } catch { return undefined } // Failed observation grants no authority to signal a group.
  const value = stdout.trim()
  return /^[0-9]+$/.test(value) && Number(value) === pid ? pid : undefined
}

/**
 * Match the owned-profile token in an untruncated process command line.
 * ps flattens argv: whitespace-suffixed sibling paths inside the owned root remain ambiguous.
 * @param pid - process identity being checked; no signal is sent.
 * @param profileDir - canonical profile path used in Chrome's launch arguments.
 * @param timeoutMs - query deadline, bounded by the caller's remaining shutdown grace.
 * @returns true for the exact profile token, false for a gone or positively unmarked process.
 * @throws Error when identity cannot be read; unreadable is not treated as foreign.
 */
export async function isOwnedChromeProcess(pid: number, profileDir: string, timeoutMs = 2_000): Promise<boolean> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8', timeout: Math.min(2_000, Math.max(1, timeoutMs)), killSignal: 'SIGKILL', maxBuffer: 1 << 16, env: PS_ENV,
    }))
  } catch (cause) {
    const failure = cause as { code?: string | number; stdout?: string; stderr?: string }
    // ps exits 1 with no output when the selected pid disappeared between observations.
    if (failure.code === 1 && failure.stdout === '' && failure.stderr === '') return false
    throw new Error('cannot verify Chrome process identity for pid ' + String(pid), { cause })
  }
  const command = stdout.trimEnd()
  const token = ' --user-data-dir=' + profileDir
  for (let index = command.indexOf(token); index !== -1; index = command.indexOf(token, index + token.length)) {
    const after = index + token.length
    if (after === command.length || /\s/.test(command.charAt(after))) return true
  }
  return false
}

/**
 * Wait until no profile-verified member occupies a recorded process group.
 * Unmarked members may be reused foreign processes or unidentifiable helpers; neither is signalled.
 * @param pgid - previously observed group id, which may have been reused after exit.
 * @param timeoutMs - remaining shutdown grace shared with the leader-exit wait.
 * @param isOwned - identity check using the canonical owned profile and remaining query budget.
 * @returns unmarked pids left untouched; these are not claimed to belong to Shres.
 * @throws Error on unverifiable or lingering marked membership; callers retain ownership for retry.
 */
export async function waitForOwnedGroupMembers(
  pgid: number, timeoutMs: number, isOwned: (pid: number, remainingMs: number) => Promise<boolean>,
): Promise<readonly number[]> {
  const expires = Date.now() + timeoutMs
  let marked: number[] | undefined
  for (;;) {
    const remaining = expires - Date.now()
    if (remaining <= 0) {
      const detail = marked === undefined ? 'membership could not be verified before the shutdown deadline' : 'profile-marked processes ' + marked.slice(0, 16).join(', ') + ' remain'
      throw new Error('recorded Chrome group ' + String(pgid) + ': ' + detail + '; quit the Chrome using the owned profile, then retry Close')
    }
    let stdout: string
    try {
      ;({ stdout } = await execFileAsync('/bin/ps', ['-A', '-o', 'pid=', '-o', 'pgid='], {
        encoding: 'utf8', timeout: Math.min(2_000, remaining), killSignal: 'SIGKILL', maxBuffer: 1 << 20, env: PS_ENV,
      }))
    } catch (cause) { throw new Error('cannot verify recorded Chrome group ' + String(pgid) + '; retry Close after checking the owned profile', { cause }) }
    const members: number[] = []
    let rows = 0
    for (const row of stdout.split(/\r?\n/)) {
      if (row.trim() === '') continue
      const match = /^\s*([0-9]+)\s+([0-9]+)\s*$/.exec(row)
      if (match === null) throw new Error('cannot parse process-group status; recorded Chrome ownership was retained')
      const pid = Number(match[1])
      const group = Number(match[2])
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(group)) throw new Error('invalid process-group identity; recorded Chrome ownership was retained')
      rows++
      if (group === pgid) members.push(pid)
    }
    if (rows === 0) throw new Error('empty process-group status; recorded Chrome ownership was retained')
    marked = []
    const unmarked: number[] = []
    for (const pid of members) {
      const budget = expires - Date.now()
      if (budget <= 0) throw new Error('Chrome member identity could not be verified within the shutdown deadline')
      if (await isOwned(pid, budget)) marked.push(pid)
      else unmarked.push(pid)
    }
    if (marked.length === 0) return unmarked
    await delay(Math.min(100, Math.max(0, expires - Date.now())))
  }
}
