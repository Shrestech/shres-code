/**
 * Which browser a BrowserSkill runtime drives, and the durable record that
 * carries it. `managed` launches a Chrome the runtime owns; `paired` drives
 * the browser the user already has, through the upstream extension and a
 * pairing this runtime holds. The record lives beside the daemon port so one
 * read owns both facts.
 * @module @shres-code/shres-code-browserskill/runtime/mode
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@shres-code/shres-code-atomic-write'

/** The file the runtime owns inside its root. */
export const RUNTIME_STATE_FILE = 'runtime.json'

/** Which browser this runtime drives. */
export type BrowserSkillMode = 'managed' | 'paired'

/** The durable facts one runtime start reads back. */
export interface RuntimeState {
  /** Record format; 1 is a pre-mode record and reads as `managed`. */
  version: 2
  /** Browser the runtime drives. */
  mode: BrowserSkillMode
  /** Loopback port the owned daemon listens on. */
  daemonPort?: number
}

/**
 * Read the runtime record.
 * @param root - the owned runtime root.
 * @returns the record, or `undefined` when absent, malformed, or portless in an older format.
 */
export async function readRuntimeState(root: string): Promise<RuntimeState | undefined> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(root, RUNTIME_STATE_FILE), 'utf8'))
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const wire = raw as Record<string, unknown>
  const port = wire.daemonPort
  const validPort = typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined
  // A pre-mode record cannot be told apart from an unpaired managed one, so it
  // keeps the behaviour it shipped with.
  if (wire.version === 1) {
    return validPort === undefined ? undefined : { version: 2, mode: 'managed', daemonPort: validPort }
  }
  if (wire.version !== 2 || (wire.mode !== 'managed' && wire.mode !== 'paired')) return undefined
  return { version: 2, mode: wire.mode, ...validPort === undefined ? {} : { daemonPort: validPort } }
}

/**
 * Persist the runtime record.
 * @param root - the owned runtime root.
 * @param state - the facts to store; a missing port keeps the mode only.
 */
export async function writeRuntimeState(root: string, state: RuntimeState): Promise<void> {
  await writeFileAtomic(join(root, RUNTIME_STATE_FILE), JSON.stringify(state, null, 2) + '\n', {
    mode: 0o600,
    dirMode: 0o700,
  })
}
