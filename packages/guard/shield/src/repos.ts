/**
 * Per-repo enable/disable gate for the Shield seat. Pure evaluation over the
 * `repos` exception map in the `shres-shield` settings namespace: the global
 * switch stays master, entries only disable, and a repo under audit can never
 * author its own exemption because the map lives in the host-owned settings
 * document outside every repo tree.
 * @module @shres-code/shres-code-shield/repos
 */

import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/** One `repos` map entry. `enabled: true` is legal but inert under carve-out-only precedence. */
export interface ShieldRepoEntry {
  /** False keeps Shield off for this repo while the global switch stays on. */
  enabled: boolean
}

/** Repo path → entry exception map stored in the settings namespace. */
export type ShieldRepos = Record<string, ShieldRepoEntry>

/** Live-session store face the gate reads; structural so tests stay cordis-free. */
export interface SessionCwdSource {
  /** All live sessions, in creation order; cwd may be absent from a header. */
  list?(): Array<{ header: { cwd?: string } }>
}

/**
 * Reject a `repos` map whose keys could never match a session cwd. Keys must
 * be absolute, non-empty paths; relative or empty keys fail the write loudly
 * at the settings boundary instead of silently never matching.
 * @param repos - the resolved `repos` section, schema-valid by construction.
 * @throws `Error` naming the first invalid key.
 */
export function validateRepoKeys(repos: ShieldRepos): void {
  for (const key of Object.keys(repos)) {
    if (key.length === 0 || !isAbsolute(key)) {
      throw new Error(`shres-shield: repos key ${JSON.stringify(key)} must be a non-empty absolute path`)
    }
  }
}

/**
 * Realpath one stored key when it exists on disk, so a path stored through a
 * symlink still matches the session-side realpath. A key that no longer
 * exists compares exactly.
 * @param key - stored `repos` key.
 * @returns the normalized lookup key.
 */
function normalizeKey(key: string): string {
  try {
    return realpathSync(key)
  } catch {
    return key
  }
}

/**
 * Realpath one live-session cwd; a vanished workspace falls back to the raw
 * path so the entry that disabled it keeps matching.
 * @param cwd - session workspace path from the session header.
 * @returns the normalized cwd.
 */
export function resolveRepoPath(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
}

/**
 * Normalize the whole exception map for one evaluation. Keys that exist on
 * disk realpath; entries for distinct stored keys that normalize to the same
 * path collapse to the later entry.
 * @param repos - stored exception map.
 * @returns path-normalized map for lookups.
 */
function normalizeRepos(repos: ShieldRepos): ShieldRepos {
  const normalized: ShieldRepos = {}
  for (const [key, entry] of Object.entries(repos)) {
    normalized[normalizeKey(key)] = entry
  }
  return normalized
}

/**
 * Whether one repo is disabled by an exception entry.
 * @param repos - stored exception map.
 * @param cwd - already-normalized session workspace path.
 * @returns true when an entry disables this repo.
 */
export function repoDisabled(repos: ShieldRepos, cwd: string): boolean {
  const entry = normalizeRepos(repos)[cwd]
  return entry !== undefined && !entry.enabled
}

/**
 * Collect the normalized cwds of every live session that has one. Sessions
 * without a cwd are unknown repos and default to enabled.
 * @param sessions - live-session store, or `undefined` when unmounted.
 * @returns deduped normalized cwd list.
 */
export function liveSessionCwds(sessions: SessionCwdSource | undefined): string[] {
  const listed = sessions?.list?.() ?? []
  const cwds = new Set<string>()
  for (const row of listed) {
    const cwd = row.header.cwd
    if (typeof cwd === 'string' && cwd.length > 0) cwds.add(resolveRepoPath(cwd))
  }
  return [...cwds]
}

/**
 * Mount gate: the engine may apply unless every live session's repo is
 * disabled. No live sessions (idle harness, or none with a cwd) stays
 * mounted, preserving boot behavior and avoiding mount churn at idle. One
 * enabled live repo keeps the engine mounted even while other live repos are
 * exempt — those stay screened until the engine-side exclusion contract
 * lands; over-screening is the fail-secure direction.
 * @param repos - stored exception map.
 * @param cwds - normalized live-session cwds from {@link liveSessionCwds}.
 * @returns true when the seat must stay unmounted with `'repo-disabled'`.
 */
export function repoGateBlocksMount(repos: ShieldRepos, cwds: readonly string[]): boolean {
  if (cwds.length === 0) return false
  return cwds.every(cwd => repoDisabled(repos, cwd))
}
