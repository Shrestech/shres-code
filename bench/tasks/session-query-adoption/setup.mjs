/**
 * Plant the prior-session fixture into the trial persistence root.
 *
 * The needed origin-station code lives only in that log. Setup rewrites the
 * header `cwd` to the trial scratch dir so session-query workspace authority
 * (exact cwd equality) admits the planted session, and writes the artifact at
 * the JSONL identity path the persistence backend lists.
 *
 * Usage: node setup.mjs <scratch-dir> <session-log-root>
 *
 * @module
 */

import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { sessionLogPath } from '../../runner/session-layout.js'

/** Session id of the planted prior log; locator prefix `bench-prior-`. */
export const PRIOR_SESSION_ID = 'bench-prior-session-query-adoption'

/** The origin-station code recorded in the prior log and required by the verifier. */
export const ORIGIN_STATION = 'QX7K-ALPHA'

const CWD_PLACEHOLDER = '__BENCH_SCRATCH_CWD__'

/**
 * Install the fixture session.jsonl under `sessionLogRoot` with `cwd` rewritten
 * to `scratchDir`.
 * @param {string} scratchDir - trial scratch dir (live session cwd).
 * @param {string} sessionLogRoot - per-spawn persistence root from the arm overlay.
 * @returns {Promise<string>} absolute path of the planted session.jsonl.
 */
export async function plantPriorSession(scratchDir, sessionLogRoot) {
  // Headless records `process.cwd()`, which is the realpath of the spawn cwd.
  const cwd = await realpath(scratchDir)
  const fixturePath = fileURLToPath(new URL('./prior-session.jsonl', import.meta.url))
  const raw = await readFile(fixturePath, 'utf8')
  const lines = raw.split('\n')
  const headerLine = lines[0]
  if (headerLine === undefined || headerLine.trim() === '') {
    throw new Error('prior-session.jsonl is missing a header line')
  }
  /** @type {Record<string, unknown>} */
  const header = JSON.parse(headerLine)
  if (header.id !== PRIOR_SESSION_ID) {
    throw new Error(`prior-session.jsonl id must be ${PRIOR_SESSION_ID}`)
  }
  if (header.cwd !== CWD_PLACEHOLDER) {
    throw new Error('prior-session.jsonl cwd must be the setup placeholder')
  }
  header.cwd = cwd
  const events = lines.slice(1).filter(line => line.trim() !== '')
  const dest = sessionLogPath(sessionLogRoot, cwd, PRIOR_SESSION_ID)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, `${JSON.stringify(header)}\n${events.join('\n')}\n`)
  return dest
}

const invokedAsScript = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedAsScript) {
  const scratchDir = process.argv[2]
  const sessionLogRoot = process.argv[3]
  if (!scratchDir || !sessionLogRoot) {
    console.log('fail: usage: node setup.mjs <scratch-dir> <session-log-root>')
    process.exit(1)
  }
  const dest = await plantPriorSession(scratchDir, sessionLogRoot)
  console.log(`ok: planted ${dest}`)
}
