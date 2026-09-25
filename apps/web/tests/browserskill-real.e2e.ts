/**
 * Opt-in real native BrowserSkill Web evidence: the shipped Settings install
 * flow over pinned loopback artifacts, one real agent round through the owned
 * browser, and owned teardown across a restart. Network exposure is bounded
 * but not total: the model API and external Node fetch are disabled, the
 * fixture pages and the daemon update metadata ride loopback-only endpoints,
 * and the owned Chrome background traffic is not confined. Everyday browser
 * profiles are never launched; process inspection reads PID/PGID metadata
 * from the process table and command lines only for members of the recorded
 * groups. Native probes never signal Chrome or the daemon; keyless removal
 * checks use and stop only their own benign Node children.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createServer as createSocketServer } from 'node:net'
import { createRequire } from 'node:module'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { initProfile, PROFILE_TEMPLATES } from '@shres-code/shres-code-app-boot'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, requireDist } from './support.ts'

// The lane is real on every axis but the model: SHRES_BROWSERSKILL_REAL=1 on the
// measured platform with a directory holding the pinned release assets. Every
// other run skips, so ordinary lanes prove nothing about native browser control.
const ASSET_DIR = process.env.SHRES_BSK_ASSET_DIR
const REAL_ENABLED = process.env.SHRES_BROWSERSKILL_REAL === '1'
  && process.platform === 'darwin'
  && process.arch === 'arm64'
  && ASSET_DIR !== undefined && ASSET_DIR !== ''

const MODEL_FIXTURE = fileURLToPath(new URL('../../../examples/headless-agent/tests/fixtures/browserskill-web/model.ts', import.meta.url))
const OFFLINE = fileURLToPath(new URL('./fixtures/plugin-manage/offline.mjs', import.meta.url))
const COMPLETION = 'BROWSERSKILL_WEB_CONTROL_COMPLETE'
const RECEIPT_LABEL = 'BSK-WEB-RECEIVED'
const ASSISTANT_ROW = '[data-chat-flow-kind="assistant-step"]'
// Mirrored from the BrowserSkill manifest pins: the release asset file names the
// downloads fetch under an artifact-base override. A drift surfaces as a 404 the
// runtime refuses loud, never as a silent pass.
const BSK_ASSET_NAME = 'bsk-v0.3.1-aarch64-apple-darwin.tar.gz'
const EXTENSION_ASSET_NAME = 'browser-skill-extension-v0.3.1-chrome.zip'
const PINNED_VERSION = '0.3.1'
const ARTIFACT_PATHS = ['/' + BSK_ASSET_NAME, '/' + EXTENSION_ASSET_NAME]
// Deliberate difference from the sibling lanes: no committed ARIA goldens. Every
// milestone of this section discloses the per-run loopback ports, which the
// shared aria normalizer cannot collapse, and custom normalizers are out of
// bounds; the milestones are therefore asserted semantically.

/** Loopback-only fixture listener (binds 127.0.0.1). */
interface LoopbackServer {
  /** Base URL, without a trailing slash. */
  url: string
  /** Stop listening and await the close callback. */
  close(): Promise<void>
}

/** Pinned-artifact mirror: serves the two pinned asset names from the asset
 * directory plus a no-update version manifest, and records every request path. */
interface ArtifactServer extends LoopbackServer {
  /** Every request path in arrival order. */
  served(): readonly string[]
  /** Request paths that are pinned artifact downloads. */
  artifactDownloads(): readonly string[]
}

/** Form fixture: records submissions server-side, in memory and on disk,
 * independent of the model, the browser, and the agent transcript. */
interface FormServer extends LoopbackServer {
  /** Submitted marker values in arrival order. */
  receipts(): readonly string[]
}

function respond(response: ServerResponse, status: number, contentType: string, body: string | Buffer): void {
  response.writeHead(status, { 'content-type': contentType })
  response.end(body)
}

async function listenLoopback(server: Server): Promise<number> {
  return await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { rejectListen(new Error('loopback listen returned no port')); return }
      resolveListen(address.port)
    })
  })
}

/**
 * Start the pinned-artifact mirror. Non-GET requests and unknown paths are
 * refused; a missing asset file turns into the download failure the runtime
 * refuses loud.
 * @param assetDir - directory holding the pinned bsk archive and extension zip.
 */
async function startArtifactServer(assetDir: string): Promise<ArtifactServer> {
  const servedPaths: string[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    servedPaths.push(url.pathname)
    if (request.method !== 'GET') { respond(response, 405, 'text/plain', 'GET only'); return }
    if (url.pathname === '/version.json') {
      // bsk cli-v0.3.1 RawManifest requires assets; update_candidate returns
      // no update for an equal version before looking up a platform asset.
      respond(response, 200, 'application/json', JSON.stringify({ version: PINNED_VERSION, assets: {} }))
      return
    }
    if (!ARTIFACT_PATHS.includes(url.pathname)) { respond(response, 404, 'text/plain', 'not a pinned asset'); return }
    void (async () => {
      try {
        respond(response, 200, 'application/octet-stream', await readFile(join(assetDir, url.pathname.slice(1))))
      } catch {
        respond(response, 404, 'text/plain', 'pinned asset missing from SHRES_BSK_ASSET_DIR: ' + url.pathname)
      }
    })()
  })
  const port = await listenLoopback(server)
  return {
    url: 'http://127.0.0.1:' + String(port),
    served: () => [...servedPaths],
    artifactDownloads: () => servedPaths.filter(path => ARTIFACT_PATHS.includes(path)),
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => { if (error === undefined) resolveClose(); else rejectClose(error) })
    }),
  }
}

/**
 * Start the loopback form server. GET / serves the probe form; POST /submit
 * records the marker server-side and answers a receipt page.
 * @param receiptDir - directory receiving one receipt file per submission.
 */
async function startFormServer(receiptDir: string): Promise<FormServer> {
  await mkdir(receiptDir, { recursive: true })
  const submitted: string[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/') {
      respond(response, 200, 'text/html; charset=utf-8',
        '<!doctype html><html><head><title>Probe form</title></head><body>\n'
        + '<h1>Probe form</h1>\n'
        + '<form method="post" action="/submit">\n'
        + '<label for="marker">Probe marker</label>\n'
        + '<input id="marker" name="marker" type="text">\n'
        + '<button type="submit">Submit probe</button>\n'
        + '</form>\n</body></html>\n')
      return
    }
    if (request.method === 'POST' && url.pathname === '/submit') {
      let body = ''
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString()
        if (body.length > 65_536) request.destroy()
      })
      request.on('end', () => {
        const marker = new URLSearchParams(body).get('marker')
        if (marker === null || marker === '') { respond(response, 400, 'text/plain', 'missing marker'); return }
        submitted.push(marker)
        void writeFile(join(receiptDir, String(submitted.length) + '.txt'), marker + '\n').then(() => {
          respond(response, 200, 'text/html; charset=utf-8',
            '<!doctype html><html><head><title>Probe receipt</title></head><body>\n'
            + '<p>' + RECEIPT_LABEL + ' ' + marker + '</p>\n</body></html>\n')
        }, () => { respond(response, 500, 'text/plain', 'receipt not recorded') })
      })
      return
    }
    respond(response, 404, 'text/plain', 'not found')
  })
  const port = await listenLoopback(server)
  return {
    url: 'http://127.0.0.1:' + String(port),
    receipts: () => [...submitted],
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => { if (error === undefined) resolveClose(); else rejectClose(error) })
    }),
  }
}

interface WebExit {
  code: number | null
  signal: NodeJS.Signals | null
}

interface RunningWeb {
  url: string
  child: ChildProcess
  closed: Promise<WebExit>
  stop(expectedSignal?: 'SIGKILL'): Promise<void>
  /** The bounded tail of the process combined output, for failure diagnostics. */
  tail(): string
}

/** Spawn the source CLI web surface over the isolated roots, the way plugin-manage does. */
async function startWeb(root: string): Promise<RunningWeb> {
  const require = createRequire(join(REPO_ROOT, 'package.json'))
  const child = spawn(process.execPath, [
    '--import', pathToFileURL(require.resolve('tsx/esm')).href,
    '--import', pathToFileURL(OFFLINE).href,
    join(REPO_ROOT, 'apps/cli/src/bin.ts'), 'web', '--port', '0',
  ], {
    cwd: join(root, 'workspace'),
    env: {
      PATH: process.env.PATH, HOME: join(root, 'home-user'), TMPDIR: join(root, 'tmp'),
      npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'npm-globalrc'),
      SHRES_HOME: join(root, 'home'), SHRES_AGENTS_HOME: join(root, 'agents'),
      XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
      TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = new Promise<WebExit>((resolveClose) => {
    child.once('close', (code, signal) => { resolveClose({ code, signal }) })
  })
  // The combined output tail stays reachable after readiness: a later failure
  // must be able to show what the server printed.
  let recentOutput = ''
  const collect = (chunk: Buffer): void => {
    recentOutput = (recentOutput + chunk.toString()).slice(-16_000)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  async function stop(expectedSignal?: 'SIGKILL'): Promise<void> {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    const result = await boundedWebExit({ child, closed, tail: () => recentOutput })
    if (expectedSignal === undefined) expect(result.code).toBe(0)
    else expect(result).toEqual({ code: null, signal: expectedSignal })
  }
  try {
    const url = await new Promise<string>((resolveReady, reject) => {
      const timer = setTimeout(() => { reject(new Error('Web startup timed out:\n' + recentOutput)) }, 90_000)
      const poll = setInterval(() => {
        const match = /shres web: (http:\/\/[^\s]+)/u.exec(recentOutput)
        if (match?.[1] !== undefined) { clearInterval(poll); clearTimeout(timer); resolveReady(match[1]) }
      }, 250)
      child.once('error', (error) => { clearInterval(poll); clearTimeout(timer); reject(error) })
      void closed.then(({ code, signal }) => {
        clearInterval(poll)
        clearTimeout(timer)
        reject(new Error('Web exited ' + String(code) + ' (' + String(signal) + '):\n' + recentOutput))
      })
    })
    return { url, child, closed, stop, tail: () => recentOutput }
  } catch (error) {
    try { await stop() } catch { /* Preserve the startup diagnostic after the owned process has closed. */ }
    throw error
  }
}

/** Dismiss the first-run notice of a fresh harness home; restarts reuse the acknowledged settings. */
async function dismissWelcome(page: Page): Promise<void> {
  const notice = page.getByRole('button', { name: 'Continue', exact: true })
  await expect.poll(async () => await notice.isVisible(), { timeout: 30_000 }).toBe(true)
  await notice.click()
  await notice.waitFor({ state: 'hidden' })
}

/** Open Settings on the BrowserSkill section and return the section locator scoped to the dialog. */
async function openBrowserSkillSection(page: Page): Promise<Locator> {
  const dialog = page.getByRole('region', { name: 'Settings' })
  if (await dialog.count() > 0) {
    await page.keyboard.press('Escape')
    await expect.poll(() => dialog.count(), { timeout: 10_000 }).toBe(0)
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await dialog.waitFor({ timeout: 30_000 })
  await dialog.getByRole('button', { name: 'BrowserSkill', exact: true }).click()
  await expect.poll(
    () => dialog.getByRole('button', { name: 'BrowserSkill', exact: true }).getAttribute('aria-current'),
    { timeout: 10_000 },
  ).toBe('page')
  return dialog.locator('[data-browserskill-state]').first()
}

/** Close the Settings dialog through its header button and await the region leaving the page. */
async function closeSettingsDialog(page: Page): Promise<void> {
  const dialog = page.getByRole('region', { name: 'Settings' })
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect.poll(() => dialog.count(), { timeout: 10_000 }).toBe(0)
}

/** Read the section's current lifecycle state kind from its state attribute. */
async function sectionState(section: Locator): Promise<string> {
  return String(await section.getAttribute('data-browserskill-state'))
}

/** The runtime lock content while the owned stack is held; undefined when released. */
interface LeaseRecord {
  pid: number
  daemonPid?: number
  browserPid?: number
  browserPgid?: number
}

async function readLease(root: string): Promise<LeaseRecord | undefined> {
  let raw: string
  try {
    raw = await readFile(join(root, 'home', 'browserskill', 'runtime.lock'), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const record: LeaseRecord = { pid: Number(parsed.pid) }
  if (typeof parsed.daemonPid === 'number') record.daemonPid = parsed.daemonPid
  if (typeof parsed.browserPid === 'number') record.browserPid = parsed.browserPid
  if (typeof parsed.browserPgid === 'number') record.browserPgid = parsed.browserPgid
  return record
}

/** Latest identities support phase observations; history keeps every identity in the removal gate. */
interface KnownProcesses {
  daemonPid?: number
  browserPid?: number
  browserPgid?: number
  daemonPids: Set<number>
  browserPids: Set<number>
  browserPgids: Set<number>
}

function emptyKnownProcesses(): KnownProcesses {
  return { daemonPids: new Set(), browserPids: new Set(), browserPgids: new Set() }
}

function recordedProcesses(known: KnownProcesses) {
  return {
    daemonPid: known.daemonPid, browserPid: known.browserPid, browserPgid: known.browserPgid,
    daemonPids: [...known.daemonPids], browserPids: [...known.browserPids], browserPgids: [...known.browserPgids],
  }
}

function mergeKnown(target: KnownProcesses, source: KnownProcesses): void {
  mergeLease(target, source)
  for (const pid of source.daemonPids) target.daemonPids.add(pid)
  for (const pid of source.browserPids) target.browserPids.add(pid)
  for (const pgid of source.browserPgids) target.browserPgids.add(pgid)
}

function mergeLease(known: KnownProcesses, lease: Pick<LeaseRecord, 'daemonPid' | 'browserPid' | 'browserPgid'> | undefined): void {
  if (lease?.daemonPid !== undefined) { known.daemonPid = lease.daemonPid; known.daemonPids.add(lease.daemonPid) }
  if (lease?.browserPid !== undefined) { known.browserPid = lease.browserPid; known.browserPids.add(lease.browserPid) }
  if (lease?.browserPgid !== undefined) { known.browserPgid = lease.browserPgid; known.browserPgids.add(lease.browserPgid) }
}

/** Wait for one lifecycle state while merging every observed lease into the last-known owned-process record. */
async function awaitLifecycleState(
  section: Locator, target: string, timeoutMs: number, root: string, known: KnownProcesses,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    mergeLease(known, await readLease(root))
    if (await sectionState(section) === target) return
    if (Date.now() > deadline) throw new Error('lifecycle state ' + target + ' not reached; last state: ' + await sectionState(section))
    await delay(500)
  }
}

/** Whether one recorded owned pid is reaped. EPERM is not proof of death and answers false. */
async function pidDead(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

const PS_ENV = { PATH: '/usr/bin:/bin' }
const execFileAsync = promisify(execFile)

/**
 * Numeric pid/pgid pairs of the live members of one recorded process group, or
 * undefined when the process table cannot be read (uncertainty, never a
 * foreign-process claim). Read-only observation over the recorded group id only;
 * it grants no signal authority. Mirrors the membership scan of
 * packages/browser/browserskill/src/runtime/process-group.ts, which is not
 * imported because the tsconfig paths facade maps no browserskill src subpath
 * and the facade file is outside this harness's ownership.
 * @param pgid - group id previously recorded by the owned runtime's lease.
 */
async function liveGroupMembers(pgid: number): Promise<readonly number[] | undefined> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync('/bin/ps', ['-A', '-o', 'pid=', '-o', 'pgid='], {
      encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL', maxBuffer: 1 << 20, env: PS_ENV,
    }))
  } catch {
    return undefined
  }
  const members: number[] = []
  for (const row of stdout.split(/\r?\n/)) {
    if (row.trim() === '') continue
    const match = /^\s*([0-9]+)\s+([0-9]+)\s*$/.exec(row)
    if (match === null) return undefined
    if (Number(match[2]) === pgid) members.push(Number(match[1]))
  }
  return members
}

/**
 * Whether one pid's untruncated command line carries the exact canonical
 * owned-profile token; false when the pid disappeared between observations,
 * undefined when identity cannot be read. Read-only; never signals. Mirrors
 * isOwnedChromeProcess in packages/browser/browserskill/src/runtime/process-group.ts.
 * @param pid - process identity being checked.
 * @param profileDir - test-computed canonical owned profile path.
 */
async function commandLineMarksProfile(pid: number, profileDir: string): Promise<boolean | undefined> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL', maxBuffer: 1 << 16, env: PS_ENV,
    }))
  } catch (cause) {
    const failure = cause as { code?: string | number; stdout?: string; stderr?: string }
    // ps exits 1 with no output when the selected pid disappeared between observations.
    if (failure.code === 1 && failure.stdout === '' && failure.stderr === '') return false
    return undefined
  }
  const command = stdout.trimEnd()
  const token = ' --user-data-dir=' + profileDir
  for (let index = command.indexOf(token); index !== -1; index = command.indexOf(token, index + token.length)) {
    const after = index + token.length
    if (after === command.length || /\s/.test(command.charAt(after))) return true
  }
  return false
}

/** Why owned teardown is not confirmed; every unconfirmed verdict preserves the root. */
type TeardownVerdict =
  | { confirmed: true; disclosures: readonly string[] }
  | { confirmed: false; reason: string }

/** Bounded window for the post-Close and post-stop teardown confirmations; expiry is uncertainty, and uncertainty preserves. */
const TEARDOWN_VERIFY_BUDGET_MS = 30_000

/**
 * Confirm one teardown: the lease is released, every last-known recorded
 * daemon/browser pid is reaped (EPERM is not gone), and no profile-marked
 * member remains in the recorded browser group. Unmarked group members are
 * disclosed residual and are never claimed dead.
 * @param root - the harness-owned temporary root holding the BrowserSkill home.
 * @param known - every owned pid/group id observed across the whole scenario.
 * @param profileDir - test-computed canonical owned profile path.
 */
async function verifyOwnedTeardown(
  root: string, known: KnownProcesses, profileDir: string, budgetMs = TEARDOWN_VERIFY_BUDGET_MS,
): Promise<TeardownVerdict> {
  const disclosures: string[] = []
  const deadline = Date.now() + budgetMs
  for (;;) {
    const lease = await readLease(root)
    mergeLease(known, lease)
    const released = lease === undefined
    const pidsKnown = known.daemonPids.size > 0 && known.browserPids.size > 0
    const daemonGone = (await Promise.all([...known.daemonPids].map(pidDead))).every(Boolean)
    const browserGone = (await Promise.all([...known.browserPids].map(pidDead))).every(Boolean)
    if (released && pidsKnown && daemonGone && browserGone) break
    if (Date.now() > deadline) {
      const reason = !pidsKnown
        ? 'no complete recorded lease was captured while the owned stack ran'
        : !released
          ? 'runtime.lock is still present after Close'
          : !daemonGone
            ? 'not all recorded daemon pids are confirmed dead: ' + [...known.daemonPids].join(', ')
            : 'not all recorded browser pids are confirmed dead: ' + [...known.browserPids].join(', ')
      return { confirmed: false, reason }
    }
    await delay(500)
  }
  for (const pgid of known.browserPgids) {
    for (;;) {
      const members = await liveGroupMembers(pgid)
      let verdict: TeardownVerdict | 'retry'
      if (members === undefined) {
        verdict = Date.now() > deadline
          ? { confirmed: false, reason: 'recorded browser group ' + String(pgid) + ' could not be inspected' }
          : 'retry'
      } else {
        let uncertain = false
        const marked: number[] = []
        const unmarked: number[] = []
        for (const pid of members) {
          const markedPid = await commandLineMarksProfile(pid, profileDir)
          if (markedPid === undefined) { uncertain = true; break }
          ;(markedPid ? marked : unmarked).push(pid)
        }
        if (uncertain) {
          verdict = Date.now() > deadline
            ? { confirmed: false, reason: 'recorded browser group membership could not be verified before the deadline' }
            : 'retry'
        } else if (marked.length > 0) {
          verdict = Date.now() > deadline
            ? { confirmed: false, reason: 'profile-marked pids remain in the recorded browser group: ' + marked.join(', ') }
            : 'retry'
        } else {
          if (unmarked.length > 0) {
            disclosures.push('unmarked processes in the recorded browser group were left untouched and are not claimed dead: '
              + unmarked.join(', '))
          }
          break
        }
      }
      if (verdict !== 'retry') return verdict
      await delay(500)
    }
  }
  return { confirmed: true, disclosures }
}

/** Attach bounded console and pageerror collectors feeding shared failure diagnostics. */
function attachPageDiagnostics(page: Page, consoleDiagnostics: string[], pageErrors: string[]): void {
  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return
    consoleDiagnostics.push('[' + message.type() + '] ' + message.text())
    if (consoleDiagnostics.length > 40) consoleDiagnostics.splice(0, consoleDiagnostics.length - 40)
  })
  page.on('pageerror', (error) => {
    pageErrors.push(String(error))
    if (pageErrors.length > 20) pageErrors.splice(0, pageErrors.length - 20)
  })
}

/**
 * Two bounded outcomes: the exact completion marker as a whole text node in an
 * assistant row (never a substring of a longer claim, never the user's echoed
 * words), or a surfaced terminal turn failure ('This turn failed' status with
 * a failure code), which fails the wait immediately instead of running out the
 * completion budget. The completion oracle itself is unchanged.
 */
async function waitForAssistantOutcome(page: Page): Promise<void> {
  const deadline = Date.now() + 180_000
  for (;;) {
    if (await page.locator(ASSISTANT_ROW).getByText(COMPLETION, { exact: true }).count() > 0) return
    const failedTurn = page.getByRole('status')
      .filter({ hasText: 'This turn failed' })
      .filter({ has: page.locator('code') })
    if (await failedTurn.count() > 0) {
      throw new Error('the agent turn failed in the UI: ' + JSON.stringify(await failedTurn.first().innerText()))
    }
    if (Date.now() > deadline) throw new Error('no exact assistant completion within the wait budget and no surfaced turn failure')
    await delay(500)
  }
}

interface ScenarioCurrent {
  web: RunningWeb
  page: Page
  expectedSignal?: 'SIGKILL' | undefined
}

interface OwnedScenario {
  name: string
  root: string
  marker: string
  ownedProfileDir: string
  known: KnownProcesses
  disclosures: string[]
  consoleDiagnostics: string[]
  pageErrors: string[]
  browser: Browser
  mirror: ArtifactServer
  formServer: FormServer
  current: ScenarioCurrent
  observations: Record<string, unknown>[]
}

async function exerciseControl(scenario: OwnedScenario): Promise<void> {
  const { root, marker, ownedProfileDir, known, disclosures, consoleDiagnostics, pageErrors, browser, mirror, formServer } = scenario
  let { page, web } = scenario.current
  let section: Locator
  try {
    await closeSettingsDialog(page)
    // The real chat round: the scripted external model drives the REAL browser
    // tools; the form server records the receipt independently of any model claim.
    await connectFreshWorkspace(page, root)
    const composer = page.locator('textarea:enabled[placeholder="Describe what you want to build"]')
    await composer.waitFor({ timeout: 15_000 })
    await composer.fill('Use BrowserSkill to fill the Probe marker field on ' + formServer.url
      + '/ with ' + marker + ', submit the form, and stop the browser session.')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await waitForAssistantOutcome(page)
    expect(formServer.receipts()).toEqual([marker])
    expect(await readFile(join(root, 'receipts', '1.txt'), 'utf8')).toBe(marker + '\n')

    // Close through the UI, then confirm owned teardown the same way after both
    // Closes: lease released, every recorded pid gone, no marked group member.
    section = await openBrowserSkillSection(page)
    await section.locator('[data-close-action]').click()
    await section.getByText('Browser closed. The BrowserSkill daemon is stopped.', { exact: true })
      .waitFor({ timeout: 60_000 })
    await awaitLifecycleState(section, 'provisioned', 30_000, root, known)
    const firstClose = await verifyOwnedTeardown(root, known, ownedProfileDir)
    if (!firstClose.confirmed) throw new Error('Owned teardown was not confirmed after Close: ' + firstClose.reason)
    disclosures.push(...firstClose.disclosures)

    // Restart over the same roots: Open reaches Ready without any artifact download.
    await page.close()
    await web.stop()
    web = await startWeb(root)
    page = await newEnglishPage(browser)
    attachPageDiagnostics(page, consoleDiagnostics, pageErrors)
    await page.goto(web.url, { waitUntil: 'load' })
    const downloadsAfterProvision = mirror.artifactDownloads().length
    section = await openBrowserSkillSection(page)
    await awaitLifecycleState(section, 'provisioned', 30_000, root, known)
    await section.locator('[data-open-action]').click()
    await awaitLifecycleState(section, 'ready', 120_000, root, known)
    expect(mirror.artifactDownloads().length).toBe(downloadsAfterProvision)

    section = await openBrowserSkillSection(page)
    await section.locator('[data-close-action]').click()
    await section.getByText('Browser closed. The BrowserSkill daemon is stopped.', { exact: true })
      .waitFor({ timeout: 60_000 })
    await awaitLifecycleState(section, 'provisioned', 30_000, root, known)
    const secondClose = await verifyOwnedTeardown(root, known, ownedProfileDir)
    if (!secondClose.confirmed) throw new Error('Owned teardown was not confirmed after the restart Close: ' + secondClose.reason)
    disclosures.push(...secondClose.disclosures)
  } finally {
    scenario.current.web = web
    scenario.current.page = page
  }
}

async function pathPresent(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

async function observeProcesses(recorded: KnownProcesses, profile: string) {
  const daemonDead = recorded.daemonPid === undefined ? null : await pidDead(recorded.daemonPid)
  const browserDead = recorded.browserPid === undefined ? null : await pidDead(recorded.browserPid)
  const members = recorded.browserPgid === undefined ? undefined : await liveGroupMembers(recorded.browserPgid)
  const marked: number[] = []
  const unmarked: number[] = []
  let verified = members !== undefined
  for (const pid of members ?? []) {
    const ours = await commandLineMarksProfile(pid, profile)
    if (ours === undefined) verified = false
    else (ours ? marked : unmarked).push(pid)
  }
  return { daemonDead, browserDead, markedGroupMembers: verified ? marked : null, unmarkedGroupMembers: unmarked }
}

async function recordObservation(
  scenario: OwnedScenario, phase: string, extra: Record<string, unknown>, recorded: KnownProcesses = scenario.known,
): Promise<void> {
  const section = scenario.current.page.locator('[data-browserskill-state]').first()
  const visible = !scenario.current.page.isClosed() && await section.count() > 0
  const observation = {
    phase, ...extra, recordedPids: recordedProcesses(recorded),
    afterPids: await observeProcesses(recorded, scenario.ownedProfileDir),
    leasePresent: await pathPresent(join(scenario.root, 'home', 'browserskill', 'runtime.lock')),
    lockMutexPresent: await pathPresent(join(scenario.root, 'home', 'browserskill', 'runtime.lock.lock')),
    uiState: visible ? await sectionState(section) : null,
  }
  scenario.observations.push(observation)
  await writeFile(join(scenario.root, 'result.json'), JSON.stringify({ case: scenario.name, observations: scenario.observations }, null, 2) + '\n')
  console.info('[browserskill-real-result] ' + JSON.stringify({ case: scenario.name, ...observation }))
}

async function closeOwnedBrowser(scenario: OwnedScenario): Promise<void> {
  const section = await openBrowserSkillSection(scenario.current.page)
  await section.locator('[data-close-action]').click()
  await section.getByText('Browser closed. The BrowserSkill daemon is stopped.', { exact: true }).waitFor({ timeout: 60_000 })
  await awaitLifecycleState(section, 'provisioned', 30_000, scenario.root, scenario.known)
  const verdict = await verifyOwnedTeardown(scenario.root, scenario.known, scenario.ownedProfileDir)
  if (!verdict.confirmed) throw new Error('UI Close did not confirm teardown: ' + verdict.reason)
  scenario.disclosures.push(...verdict.disclosures)
}

async function openOwnedBrowser(scenario: OwnedScenario): Promise<void> {
  const section = await openBrowserSkillSection(scenario.current.page)
  const downloads = scenario.mirror.artifactDownloads().length
  await section.locator('[data-open-action]').click()
  await awaitLifecycleState(section, 'ready', 120_000, scenario.root, scenario.known)
  expect(scenario.mirror.artifactDownloads().length).toBe(downloads)
}

async function restartWeb(scenario: OwnedScenario): Promise<void> {
  const current = scenario.current
  await current.page.close()
  await current.web.stop(current.expectedSignal)
  current.web = await startWeb(scenario.root)
  current.expectedSignal = undefined
  current.page = await newEnglishPage(scenario.browser)
  attachPageDiagnostics(current.page, scenario.consoleDiagnostics, scenario.pageErrors)
  await current.page.goto(current.web.url, { waitUntil: 'load' })
}

async function boundedWebExit(web: Pick<RunningWeb, 'child' | 'closed' | 'tail'>): Promise<WebExit> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      web.closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (web.child.exitCode === null && web.child.signalCode === null) web.child.kill('SIGKILL')
          reject(new Error('The test-owned Web host did not exit within 60s: ' + web.tail()))
        }, 60_000)
      }),
    ])
  } finally { clearTimeout(timer) }
}

async function exerciseOccupiedPort(scenario: OwnedScenario, port: number): Promise<void> {
  let contacts = 0
  const server = createSocketServer((socket) => { contacts += 1; socket.destroy() })
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen({ host: '127.0.0.1', port, exclusive: true }, resolveListen)
    })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
      await recordObservation(scenario, 'port-conflict', { branch: 'skipped-port-busy', port })
      return
    }
    throw error
  }
  const attempt = emptyKnownProcesses()
  try {
    const section = await openBrowserSkillSection(scenario.current.page)
    await section.locator('[data-open-action]').click()
    await awaitLifecycleState(section, 'failed', 60_000, scenario.root, attempt)
    const refusal = section.locator('[data-refusal="endpoint-in-use"]')
    await refusal.waitFor({ timeout: 5_000 })
    expect(await refusal.innerText()).toContain(String(port))
    expect(attempt.browserPid).toBeUndefined()
    if (attempt.daemonPid !== undefined) expect(await pidDead(attempt.daemonPid)).toBe(true)
    expect(await readLease(scenario.root)).toBeUndefined()
    expect(server.listening).toBe(true)
    expect(contacts).toBe(0)
    await recordObservation(scenario, 'port-conflict', {
      branch: 'refused-without-contact', port, contacts, attemptPids: recordedProcesses(attempt), refusalText: await refusal.innerText(),
    }, attempt)
  } finally {
    mergeKnown(scenario.known, attempt)
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => { if (error === undefined) resolveClose(); else rejectClose(error) })
    })
  }
  await openOwnedBrowser(scenario)
  await closeOwnedBrowser(scenario)
  await recordObservation(scenario, 'port-released', { branch: 'reopened-and-closed', port })
}

async function exerciseEndpointConflicts(scenario: OwnedScenario): Promise<void> {
  await closeOwnedBrowser(scenario)
  const saved: unknown = JSON.parse(await readFile(join(scenario.root, 'home', 'browserskill', 'runtime.json'), 'utf8'))
  if (typeof saved !== 'object' || saved === null || !('daemonPort' in saved)
    || typeof saved.daemonPort !== 'number' || !Number.isSafeInteger(saved.daemonPort)
    || saved.daemonPort < 1 || saved.daemonPort > 65535) throw new Error('No valid persisted daemon port')
  expect(saved.daemonPort).not.toBe(52800)
  await exerciseOccupiedPort(scenario, 52800)
  await exerciseOccupiedPort(scenario, saved.daemonPort)
}

async function exerciseHostExit(scenario: OwnedScenario, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const previous = emptyKnownProcesses()
  mergeKnown(previous, scenario.known)
  if (previous.daemonPid === undefined || previous.browserPid === undefined || previous.browserPgid === undefined) {
    throw new Error('Ready did not expose a complete owned process record')
  }
  await recordObservation(scenario, 'before-signal', { signal, hostPid: scenario.current.web.child.pid }, previous)
  if (signal === 'SIGKILL') scenario.current.expectedSignal = signal
  expect(scenario.current.web.child.kill(signal)).toBe(true)
  const exit = await boundedWebExit(scenario.current.web)
  await recordObservation(scenario, 'host-exit', { signal, exit }, previous)
  if (signal === 'SIGTERM') {
    expect(exit.code).toBe(0)
    await expect.poll(async () => await observeProcesses(previous, scenario.ownedProfileDir), {
      timeout: TEARDOWN_VERIFY_BUDGET_MS,
    }).toMatchObject({ daemonDead: true, browserDead: true, markedGroupMembers: [] })
    await recordObservation(scenario, 'host-exit-confirmed', { signal }, previous)
  } else expect(exit).toEqual({ code: null, signal: 'SIGKILL' })

  const staleLease = await pathPresent(join(scenario.root, 'home', 'browserskill', 'runtime.lock'))
  await restartWeb(scenario)
  const section = await openBrowserSkillSection(scenario.current.page)
  await awaitLifecycleState(section, 'provisioned', 30_000, scenario.root, scenario.known)
  const downloads = scenario.mirror.artifactDownloads().length
  await section.locator('[data-open-action]').click()
  await expect.poll(async () => {
    mergeLease(scenario.known, await readLease(scenario.root))
    return await sectionState(section)
  }, { timeout: 120_000 }).toMatch(/^(ready|failed)$/)
  const state = await sectionState(section)
  expect(scenario.mirror.artifactDownloads().length).toBe(downloads)
  if (signal === 'SIGTERM') expect(state).toBe('ready')
  if (state === 'ready') {
    expect(await pidDead(previous.daemonPid)).toBe(true)
    expect(await pidDead(previous.browserPid)).toBe(true)
    await recordObservation(scenario, 'recovery', { branch: staleLease ? 'stale-lease-ready' : 'released-lease-ready', signal }, previous)
    await closeOwnedBrowser(scenario)
  } else {
    const refusal = section.locator('[data-refusal]')
    const kind = await refusal.getAttribute('data-refusal')
    const refusalText = await refusal.innerText()
    if (kind === 'extension-load-failed') expect(refusalText).toMatch(/Owned profile is locked at .*SingletonLock/s)
    else expect(['owned-by-peer', 'shutdown-incomplete']).toContain(kind)
    await recordObservation(scenario, 'recovery', { branch: kind, signal, refusalText }, previous)
    await expect.poll(async () => await observeProcesses(previous, scenario.ownedProfileDir), {
      timeout: TEARDOWN_VERIFY_BUDGET_MS,
    }).toMatchObject({ daemonDead: true, browserDead: true, markedGroupMembers: [] })
    const close = section.locator('[data-close-action]')
    if (await close.count() > 0 && await close.isEnabled()) await closeOwnedBrowser(scenario)
    const verdict = await verifyOwnedTeardown(scenario.root, scenario.known, scenario.ownedProfileDir)
    if (!verdict.confirmed) throw new Error('Recovery refused with unconfirmed owned processes: ' + verdict.reason)
    scenario.disclosures.push(...verdict.disclosures)
  }
  await recordObservation(scenario, 'final-close', { outcome: state === 'ready' ? 'recovered' : 'refused-cleanly', signal })
}

async function withOwnedScenario(name: string, exercise: (scenario: OwnedScenario) => Promise<void>): Promise<void> {
  requireDist()
  if (ASSET_DIR === undefined) throw new Error('unreachable: the skip gate pins SHRES_BSK_ASSET_DIR')
  // Fail a misconfigured opt-in loud at setup instead of mid-provision.
  for (const assetName of [BSK_ASSET_NAME, EXTENSION_ASSET_NAME]) {
    await readFile(join(ASSET_DIR, assetName)).catch((error: unknown) => {
      throw new Error('SHRES_BSK_ASSET_DIR is missing pinned asset ' + assetName, { cause: error })
    })
  }
  // A POSIX system-temp realpath root: the harness home, the owned BrowserSkill
  // root, and the daemon child home all live under it. Root safety outranks
  // artifact cleanliness: it is removed only after the whole scenario succeeded
  // AND the post-stop removal gate confirmed owned teardown; every failed
  // scenario preserves it.
  const root = await realpath(await mkdtemp('/tmp/shres-bsk-web-'))
  const profile = join(root, 'home/profiles/web')
  const marker = 'BSK-WEB-PROBE-' + randomUUID().slice(0, 8)
  const disclosures: string[] = []
  const consoleDiagnostics: string[] = []
  const pageErrors: string[] = []
  const known = emptyKnownProcesses()
  const observations: Record<string, unknown>[] = []
  let artifact: ArtifactServer | undefined
  let form: FormServer | undefined
  let web: RunningWeb | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let bodyFailure: Error | undefined
  let expectedSignal: 'SIGKILL' | undefined
  // Set on every failure and on any cleanup mishap: the finally block then
  // preserves the whole root instead of deleting under possibly-live children.
  let preservedOwnedRoot: string | undefined
  // Set only after the success path's post-stop removal gate passed.
  let rootRemovalConfirmed = false
  try {
    await mkdir(join(root, 'workspace'), { recursive: true })
    await mkdir(join(root, 'home-user'), { recursive: true })
    await mkdir(join(root, 'tmp'), { recursive: true })
    await writeFile(join(root, 'npmrc'), '')
    await writeFile(join(root, 'npm-globalrc'), '')
    // User-authored profile without the optional edition inventory: nothing is
    // downloaded at boot, and BrowserSkill mounts only through the web bundle.
    initProfile(profile, PROFILE_TEMPLATES.web!)
    const mirror = await startArtifactServer(ASSET_DIR)
    artifact = mirror
    const formServer = await startFormServer(join(root, 'receipts'))
    form = formServer
    // The generated profile patch replaces the template: the external model is
    // scripted (no credential value is inherited, llm-deepseek is disabled), the
    // native runtime points at the loopback mirror, and the model plugin is the
    // checked-in example-leaf fixture by absolute source path.
    const patchText = [
      '- id: llm-deepseek',
      '  disabled: true',
      '- id: agent-default-model',
      '  config:',
      '    provider: browserskill-web-fixture',
      '    model: fixture',
      // The shipped -auto directory picker resolves to the native OS chooser
      // on a local macOS display, which a driven page cannot operate; pin the
      // in-browser browse picker (the disable+insert pair from
      // apps/web/tests/pin-browse-picker.overlay.yml).
      '- id: directory-picker',
      '  disabled: true',
      '- id: browserskill',
      '  config:',
      '    artifactBaseUrl: ' + JSON.stringify(mirror.url),
      '    updateManifestUrl: ' + JSON.stringify(mirror.url + '/version.json'),
      '- insert:',
      '  - id: browserskill-web-model',
      '    name: ' + JSON.stringify(MODEL_FIXTURE),
      '    config:',
      '      url: ' + JSON.stringify(formServer.url + '/'),
      '      marker: ' + JSON.stringify(marker),
      '  - id: directory-picker-browse',
      '    name: \'@shres-code/shres-code-host-directory-picker-browse\'',
      '  - id: ui-directory-picker-browse',
      '    name: \'@shres-code/shres-code-client-ui-directory-picker-browse\'',
      '',
    ].join('\n')
    await writeFile(join(profile, 'cordis.patch.yml'), patchText)
    // The canonical owned root and Chrome profile token, computed the way the
    // product computes them (realpath of the owned root, then the profile dir).
    const ownedRoot = await realpath(join(root, 'home', 'browserskill')).catch(() => join(root, 'home', 'browserskill'))
    const ownedProfileDir = join(ownedRoot, 'profile')

    web = await startWeb(root)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    attachPageDiagnostics(page, consoleDiagnostics, pageErrors)
    await page.goto(web.url, { waitUntil: 'load' })
    // Before any consent: the mirror has served nothing and no browser step ran.
    expect(mirror.served()).toEqual([])

    await dismissWelcome(page)
    const section = await openBrowserSkillSection(page)
    await awaitLifecycleState(section, 'absent', 30_000, root, known)
    await section.getByRole('heading', { name: 'Install BrowserSkill', exact: true }).waitFor({ timeout: 15_000 })
    const consentText = await section.innerText()
    expect(consentText).toContain(mirror.url)
    expect(consentText).toContain(mirror.url + '/version.json')
    expect(mirror.artifactDownloads()).toEqual([])

    await section.locator('[data-install-action]').click()
    // Lease sampling runs alongside the state wait, so daemon, browser, and
    // group ids are captured as soon as the runtime records them — not only
    // once Ready is observable.
    await awaitLifecycleState(section, 'ready', 300_000, root, known)
    await section.getByText('BrowserSkill is ready. The owned browser is open.', { exact: true })
      .waitFor({ timeout: 15_000 })
    // Exactly the two pinned assets, once each, from the mirror only.
    expect([...mirror.artifactDownloads()].sort()).toEqual([...ARTIFACT_PATHS].sort())
    // The daemon metadata fetch went to the owned endpoint, after consent
    // (the pre-consent log is asserted empty above).
    await expect.poll(() => mirror.served().includes('/version.json'), {
      timeout: 30_000,
      message: 'the owned daemon never fetched the loopback update manifest',
    }).toBe(true)

    const current: ScenarioCurrent = { web, page }
    const scenario: OwnedScenario = {
      name, root, marker, ownedProfileDir, known, disclosures, consoleDiagnostics, pageErrors,
      browser, mirror, formServer, current, observations,
    }
    try {
      await exercise(scenario)
    } finally {
      web = current.web
      page = current.page
      expectedSignal = current.expectedSignal
    }

    // Post-stop removal gate: the web host is gone, so nothing can resurrect or
    // hold the recorded processes; the root may only be deleted once the lease
    // is released, every last-known recorded pid is confirmed reaped, and the
    // recorded group holds no profile-marked member.
    await page.close()
    await web.stop(expectedSignal)
    const removalGate = await verifyOwnedTeardown(root, known, ownedProfileDir)
    if (!removalGate.confirmed) throw new Error('Post-stop owned teardown was not confirmed: ' + removalGate.reason)
    disclosures.push(...removalGate.disclosures)
    rootRemovalConfirmed = true
    const result = { case: name, outcome: 'passed', recordedPids: recordedProcesses(known), observations, disclosures }
    await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n')
    console.info('[browserskill-real-result] ' + JSON.stringify(result))
    if (disclosures.length > 0) console.info('[browserskill-real] ' + disclosures.join('; '))
  } catch (error) {
    // Conservative floor: any failed scenario preserves the root, whatever the
    // lifecycle state was when it failed.
    preservedOwnedRoot = root
    // Failure forensics survive with the preserved root and on the test output:
    // the recorded owned processes, the server output, and the page diagnostics.
    const pidRecord = JSON.stringify(recordedProcesses(known))
    await writeFile(join(root, 'known-owned-processes.json'), pidRecord + '\n')
      .catch(() => { /* Best effort: the failure message already carries the record. */ })
    const result = { case: name, outcome: 'failed', failure: String(error), recordedPids: recordedProcesses(known), observations }
    await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n')
      .catch(() => { /* The primary failure and PID record remain in the diagnostic. */ })
    console.warn('[browserskill-real-result] ' + JSON.stringify(result))
    console.warn('[browserskill-real] known owned processes at failure: ' + pidRecord)
    const text = page === undefined || page.isClosed() ? '' : await page.locator('body').innerText()
    bodyFailure = new Error(String(error)
      + '\nOwned root preserved: ' + preservedOwnedRoot
      + '\nKnown owned processes: ' + pidRecord
      + (disclosures.length > 0 ? '\nDisclosures: ' + disclosures.join('; ') : '')
      + '\nWeb output tail:\n' + (web === undefined ? '(not started)' : web.tail())
      + '\nBrowser console (bounded):\n' + (consoleDiagnostics.length > 0 ? consoleDiagnostics.join('\n') : '(none captured)')
      + '\nBrowser page errors (bounded):\n' + (pageErrors.length > 0 ? pageErrors.join('\n') : '(none captured)')
      + '\nCurrent Web state:\n' + text, { cause: error })
    throw bodyFailure
  } finally {
    const cleanupErrors: unknown[] = []
    try { await browser?.close() } catch (error) { cleanupErrors.push(error) }
    try { await web?.stop(expectedSignal) } catch (error) { preservedOwnedRoot ??= root; cleanupErrors.push(error) }
    try { await artifact?.close() } catch (error) { cleanupErrors.push(error) }
    try { await form?.close() } catch (error) { cleanupErrors.push(error) }
    if (preservedOwnedRoot !== undefined || !rootRemovalConfirmed) {
      const notice = 'Owned BrowserSkill root preserved for manual inspection: ' + root
      if (bodyFailure !== undefined) {
        bodyFailure.message += '\n' + notice
        throw bodyFailure
      }
      throw cleanupErrors.length > 0
        ? new AggregateError(cleanupErrors, notice + ' Cleanup also failed.')
        : new Error(notice)
    }
    try { await rm(root, { recursive: true, force: true }) } catch (error) { cleanupErrors.push(error) }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(bodyFailure === undefined ? cleanupErrors : [bodyFailure, ...cleanupErrors], 'BrowserSkill e2e cleanup failed', { cause: bodyFailure })
    }
  }
}

it.each(['daemon', 'browser'] as const)('refuses root removal while an older recorded %s process still runs', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'shres-bsk-evidence-'))
  const alive = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const aliveClosed = new Promise<void>((resolveClose) => { alive.once('close', () => { resolveClose() }) })
  try {
    await new Promise<void>((resolveSpawn, rejectSpawn) => { alive.once('spawn', resolveSpawn); alive.once('error', rejectSpawn) })
    const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await new Promise<void>((resolveClose, rejectClose) => {
      exited.once('close', () => { resolveClose() })
      exited.once('error', rejectClose)
    })
    if (alive.pid === undefined || exited.pid === undefined) throw new Error('Evidence fixture did not spawn')
    const known = emptyKnownProcesses()
    mergeLease(known, {
      daemonPid: kind === 'daemon' ? alive.pid : exited.pid,
      browserPid: kind === 'browser' ? alive.pid : exited.pid,
    })
    const attempt = emptyKnownProcesses()
    mergeLease(attempt, { daemonPid: exited.pid, browserPid: exited.pid })
    mergeKnown(known, attempt)
    const verdict = await verifyOwnedTeardown(root, known, join(root, 'profile'), 0)
    expect(verdict.confirmed).toBe(false)
    if (!verdict.confirmed) expect(verdict.reason).toContain('recorded ' + kind + ' pids')
  } finally {
    if (alive.exitCode === null && alive.signalCode === null) alive.kill('SIGTERM')
    await aliveClosed
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')('checks later recorded groups after an earlier group is empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shres-bsk-group-evidence-'))
  const profile = join(root, 'profile')
  const alive = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--user-data-dir=' + profile], {
    stdio: 'ignore', detached: true,
  })
  const aliveClosed = new Promise<void>((resolveClose) => { alive.once('close', () => { resolveClose() }) })
  try {
    await new Promise<void>((resolveSpawn, rejectSpawn) => { alive.once('spawn', resolveSpawn); alive.once('error', rejectSpawn) })
    const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', detached: true })
    await new Promise<void>((resolveClose, rejectClose) => {
      exited.once('close', () => { resolveClose() })
      exited.once('error', rejectClose)
    })
    if (alive.pid === undefined || exited.pid === undefined) throw new Error('Group fixture did not spawn')
    const known = emptyKnownProcesses()
    mergeLease(known, { daemonPid: exited.pid, browserPid: exited.pid, browserPgid: exited.pid })
    mergeLease(known, { browserPgid: alive.pid })
    const verdict = await verifyOwnedTeardown(root, known, profile, 0)
    expect(verdict.confirmed).toBe(false)
    if (!verdict.confirmed) expect(verdict.reason).toContain('profile-marked pids')
  } finally {
    if (alive.exitCode === null && alive.signalCode === null) alive.kill('SIGTERM')
    await aliveClosed
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(!REAL_ENABLED)(
  'installs BrowserSkill from Settings, drives the owned browser through a real agent round, and tears it down across a restart',
  async () => { await withOwnedScenario('control', exerciseControl) },
  2_400_000,
)

const UNHAPPY_ENABLED = REAL_ENABLED && process.env.SHRES_BROWSERSKILL_REAL_UNHAPPY === '1'

it.skipIf(!UNHAPPY_ENABLED)('refuses occupied default and persisted endpoints without contact or eviction', async () => {
  await withOwnedScenario('endpoint-conflicts', exerciseEndpointConflicts)
}, 900_000)

it.skipIf(!UNHAPPY_ENABLED)('confirms owned teardown after host SIGTERM and reopens from retained artifacts', async () => {
  await withOwnedScenario('host-sigterm', async (scenario) => { await exerciseHostExit(scenario, 'SIGTERM') })
}, 900_000)

it.skipIf(!UNHAPPY_ENABLED)('records bounded recovery or fail-closed refusal after host SIGKILL', async () => {
  await withOwnedScenario('host-sigkill', async (scenario) => { await exerciseHostExit(scenario, 'SIGKILL') })
}, 900_000)
