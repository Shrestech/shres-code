/**
 * JSONL session-persistence path encoding, copied from
 * `shres-session-persistence-jsonl` so the bench can plant a prior-session
 * artifact at the identity path the backend will list. Bench stays a
 * zero-dependency tree and does not import workspace packages.
 *
 * @module bench/runner/session-layout
 */

import { join } from 'node:path'

/**
 * Id prefix reserved for fixture sessions the runner plants before a trial
 * spawn. {@link findSessionLog} skips these so a seeded prior log is never
 * mistaken for the trial's own transcript.
 */
export const SEEDED_PRIOR_SESSION_PREFIX = 'bench-prior-'

/**
 * Whether a session id is a runner-planted prior-session fixture.
 * @param {unknown} id - header `id` from a session.jsonl first line.
 * @returns {boolean} true when the trial locator must ignore this log.
 */
export function isSeededPriorSession(id) {
  return typeof id === 'string' && id.startsWith(SEEDED_PRIOR_SESSION_PREFIX)
}

/**
 * Encode an arbitrary string as a single safe path segment. Matches
 * `encodeSegment` in `shres-session-persistence-jsonl`.
 * @param {string} raw - session id; must be non-empty.
 * @returns {string} escaped single path segment.
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
    }
  }
  return out
}

/**
 * Human-navigable project directory name for a cwd. Matches `projectKey` in
 * `shres-session-persistence-jsonl`.
 * @param {string} cwd - the session's project directory.
 * @returns {string} `--<slug>--` directory name.
 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * Project directory under a persistence root for one cwd.
 * @param {string} root - persistence root (`session-persistence-jsonl` `root`).
 * @param {string | undefined} cwd - session project directory.
 * @returns {string} absolute project directory.
 */
export function projectDir(root, cwd) {
  if (cwd === undefined) return join(root, '_no-cwd')
  return join(root, projectKey(cwd))
}

/**
 * Identity path of a raw (`compression: none`) session.jsonl artifact.
 * @param {string} root - persistence root.
 * @param {string | undefined} cwd - session project directory.
 * @param {string} id - session id.
 * @returns {string} absolute path of `session.jsonl`.
 */
export function sessionLogPath(root, cwd, id) {
  return join(projectDir(root, cwd), encodeSegment(id), 'session.jsonl')
}
