/**
 * The owned Chrome session: the user's installed Chrome executable launched
 * with a Shres-created profile directory through puppeteer-core over pipes,
 * the pinned extension loaded unpacked over the DevTools Protocol, the daemon
 * port written into the extension's own storage by its service worker, and
 * readiness read back as the extension instance id the daemon then reports.
 * The user's own browser profiles are never touched.
 *
 * @module @shres-code/shres-code-browserskill/runtime/chrome
 */

import type { ChildProcess } from 'node:child_process'
import { observeOwnedGroup, waitForOwnedGroupMembers, isOwnedChromeProcess } from './process-group.ts'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  BSK_INSTANCE_ID_PATTERN,
  BSK_OWNED_LABEL,
  EXTENSION_STORAGE_KEYS,
} from './manifest.ts'
import { deadline, timeoutOf } from '@shres-code/shres-code-timeout'
import type { BrowserInstanceId, ExtensionId } from '../types.ts'

/**
 * The extension APIs exist only inside the service worker: the evaluate
 * callbacks below are serialized into that context, never executed here. The
 * declaration covers exactly the surface the storage handshake touches.
 */
declare const chrome: {
  storage: {
    local: {
      set(items: Record<string, unknown>): Promise<void>
      get(keys: readonly string[]): Promise<Record<string, unknown>>
    }
  }
}

/** Minimal CDP session surface the extension setup needs. */
export interface CdpSession {
  /** Send one DevTools Protocol command. */
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
}

/** Minimal browser surface the owned session drives. */
export interface OwnedBrowser {
  /** The browser-level target, whose CDP session loads the extension. */
  target(): { createCDPSession(): Promise<CdpSession> }
  /** Wait for a target matching the predicate. */
  waitForTarget(predicate: (target: { type(): string; url(): string }) => boolean, options: { timeout: number }): Promise<{
    worker(): Promise<ExtensionWorker | null>
  }>
  /** Close the browser; bounded by the caller. */
  close(): Promise<void>
  /** The underlying child process, when the launch used pipes. */
  process(): ChildProcess | null
}

/** Minimal extension service-worker surface for the storage handshake. */
export interface ExtensionWorker {
  /**
   * Evaluate a function inside the worker. The function is serialized: it
   * must carry every value it needs in its parameters or body, never over a
   * module-scope closure.
   */
  evaluate<T>(fn: (...args: never[]) => unknown, ...args: unknown[]): Promise<T>
}

/** Options the launcher receives; the default maps them onto puppeteer-core. */
export interface ChromeLaunchSpec {
  /** Absolute path of the installed Chrome executable. */
  executablePath: string
  /** Absolute owned profile directory. */
  userDataDir: string
  /** Explicit environment for the browser process. */
  env: Record<string, string>
  /** Launch deadline in milliseconds. */
  timeoutMs: number
  /** Per-protocol-command deadline in milliseconds. */
  protocolTimeoutMs: number
}

/** The extension setup failed; the detail is user-displayable. */
export class ExtensionLoadError extends Error {
  constructor(readonly detail: string) {
    super(`extension-load-failed: ${detail}`)
    this.name = 'ExtensionLoadError'
  }
}

/** A launcher turns a launch spec into a running browser. Injectable for tests. */
export type ChromeLauncher = (spec: ChromeLaunchSpec) => Promise<OwnedBrowser>

/**
 * The fixed Chrome argument set: no first-run or default-browser prompts, a
 * basic password store and mock keychain so nothing in the user's keychain is
 * touched, and the extension-debugging flag the DevTools `Extensions`
 * domain requires. Measured against installed Chrome 153.
 * @returns the argument array passed to every owned launch.
 */
export function ownedChromeArgs(): string[] {
  return [
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',
    '--enable-unsafe-extension-debugging',
  ]
}

/**
 * The default launcher, backed by puppeteer-core with pipes (no debug port)
 * and the fixed owned argument set.
 * @param spec - the launch options built by the session.
 * @returns the running browser.
 */
export async function defaultChromeLauncher(spec: ChromeLaunchSpec): Promise<OwnedBrowser> {
  const puppeteer = await import('puppeteer-core')
  return puppeteer.launch({
    executablePath: spec.executablePath,
    userDataDir: spec.userDataDir,
    headless: false,
    pipe: true,
    enableExtensions: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    timeout: spec.timeoutMs,
    protocolTimeout: spec.protocolTimeoutMs,
    env: spec.env,
    args: ownedChromeArgs(),
  }) as unknown as OwnedBrowser
}

interface ChromeLifetime {
  browser: OwnedBrowser
  child: ChildProcess | null
  exited: Promise<void>
  pgid: number | undefined
  groupObserved: boolean
  profileDir: string
  error?: Error
  forceError?: Error
}

function hasExited(child: ChildProcess): boolean { return child.exitCode !== null || child.signalCode !== null }

/** The owned Chrome lifetime, retained until process exit is confirmed. */
export class OwnedChrome {
  private readonly launcher: ChromeLauncher
  private readonly onUnverifiedProcesses: ((pids: readonly number[]) => void) | undefined
  private lifetime: ChromeLifetime | undefined
  private closing: Promise<void> | undefined
  private force = new AbortController()

  constructor(options: { launcher?: ChromeLauncher; onUnverifiedProcesses?: (pids: readonly number[]) => void }) {
    this.launcher = options.launcher ?? defaultChromeLauncher
    this.onUnverifiedProcesses = options.onUnverifiedProcesses
  }

  /** The browser, including one whose shutdown has not been confirmed. */
  get current(): OwnedBrowser | undefined { return this.lifetime?.browser }

  /**
   * Launch an owned profile, record its pid, and configure the pinned extension.
   * @param options - owned paths, deadlines, cancellation, and awaited durable pid recording.
   * @returns the exact extension and browser instance identities.
   * @throws ExtensionLoadError on setup failure; shutdown failure retains the browser for retry.
   */
  async launchAndPair(options: {
    executablePath: string
    profileDir: string
    env: Record<string, string>
    extensionDir: string
    daemonPort: number
    timeoutMs: number
    protocolTimeoutMs: number
    signal: AbortSignal
    onLaunched: (pid: number, pgid: number | undefined) => Promise<void>
  }): Promise<{ instanceId: BrowserInstanceId; extensionId: ExtensionId; browser: OwnedBrowser }> {
    if (this.lifetime !== undefined) throw new ExtensionLoadError('an owned browser already exists')
    this.force = new AbortController()
    options.signal.throwIfAborted()
    let browser: OwnedBrowser
    try {
      browser = await this.launcher({ executablePath: options.executablePath, userDataDir: options.profileDir,
        env: options.env, timeoutMs: options.timeoutMs, protocolTimeoutMs: options.protocolTimeoutMs })
    } catch (error) {
      const detail = String(error)
      if (/SingletonLock|ProcessSingleton|profile.*in use/i.test(detail)) {
        throw new ExtensionLoadError('Owned profile is locked at ' + join(options.profileDir, 'SingletonLock') + '. Close the Chrome using this Shres profile before retrying; do not remove the lock while it runs.')
      }
      throw new ExtensionLoadError(detail)
    }
    const child = browser.process()
    const owned: ChromeLifetime = { browser, child, pgid: undefined, groupObserved: false, profileDir: options.profileDir,
      exited: child === null || hasExited(child) ? Promise.resolve() : new Promise((resolve) => { child.once('exit', () => { resolve() }) }) }
    this.lifetime = owned
    child?.on('error', (error) => { owned.error = error })
    try {
      if (child?.pid === undefined || child.pid <= 0 || child.pid === process.pid) throw new ExtensionLoadError('Chrome did not expose an owned process identity')
      owned.pgid = await observeOwnedGroup(child.pid)
      owned.groupObserved = true
      if (this.force.signal.aborted) this.signalKill(owned)
      await options.onLaunched(child.pid, owned.pgid)
      try {
        using connect = deadline(AbortSignal.any([options.signal, this.force.signal]), options.timeoutMs, CHROME_WAIT_DEADLINE)
        const extensionId = await this.loadExtension(browser, options.extensionDir, options.timeoutMs, connect.signal)
        const instanceId = await this.configureStorage(browser, extensionId, options.daemonPort, options.timeoutMs, connect.signal)
        if (owned.error !== undefined) throw owned.error
        if (hasExited(child)) throw new Error('Chrome exited during extension setup')
        return { instanceId, extensionId, browser }
      } catch (error) { throw new ExtensionLoadError(String(error)) }
    } catch (error) {
      try { await this.close() }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'shutdown incomplete after Chrome setup: ' + String(cleanup)) }
      throw error
    }
  }

  private async loadExtension(browser: OwnedBrowser, path: string, ms: number, signal: AbortSignal): Promise<ExtensionId> {
    const cdp = await withBoundedTimeout(() => browser.target().createCDPSession(), ms, signal, 'Create extension CDP session')
    const loaded = await withBoundedTimeout(() => cdp.send('Extensions.loadUnpacked', { path }), ms, signal, 'Extensions.loadUnpacked')
    const id = typeof loaded === 'object' && loaded !== null ? (loaded as { id?: unknown }).id : undefined
    if (typeof id !== 'string' || !/^[a-p]{32}$/.test(id)) throw new Error('loadUnpacked reply carried no extension id')
    return id as ExtensionId
  }

  private async configureStorage(
    browser: OwnedBrowser, extensionId: ExtensionId, port: number, ms: number, signal: AbortSignal,
  ): Promise<BrowserInstanceId> {
    const target = await withBoundedTimeout(() => browser.waitForTarget(
      t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://' + extensionId + '/'), { timeout: ms }), ms, signal, 'Extension worker target')
    const worker = await withBoundedTimeout(() => target.worker(), ms, signal, 'Extension worker')
    if (worker === null) throw new Error('extension service worker unavailable')
    const written = await withBoundedTimeout(() => worker.evaluate<Record<string, unknown>>(async (daemonPort, label) => {
      await chrome.storage.local.set({ bsk_daemon_port: daemonPort, bh_label: label })
      return chrome.storage.local.get(['bsk_daemon_port', 'bh_label', 'bsk_instance_id'])
    }, port, BSK_OWNED_LABEL), ms, signal, 'Extension storage write')
    if (written[EXTENSION_STORAGE_KEYS.daemonPort] !== port) throw new Error('extension storage did not retain the daemon port')
    for (;;) {
      const got = await withBoundedTimeout(() => worker.evaluate<Record<string, unknown>>(() =>
        chrome.storage.local.get(['bsk_instance_id'])), ms, signal, 'Extension instance id')
      const instanceId = got[EXTENSION_STORAGE_KEYS.instanceId]
      if (typeof instanceId === 'string' && BSK_INSTANCE_ID_PATTERN.test(instanceId)) return instanceId as BrowserInstanceId
      await delay(250, undefined, { signal })
    }
  }

  /**
   * Escalate shutdown without starting another close; cancel the startup operation before calling.
   * Pending group observation precedes the signal.
   */
  forceClose(): void {
    if (this.force.signal.aborted) return
    this.force.abort()
    if (this.lifetime !== undefined) this.signalKill(this.lifetime)
  }

  private signalKill(owned: ChromeLifetime): void {
    const child = owned.child
    if (child === null || child.pid === undefined || child.pid <= 0 || child.pid === process.pid || hasExited(child)) return
    if (!owned.groupObserved) return
    // An unreaped child pins its identity; no asynchronous work separates this check from the signal.
    try {
      if (owned.pgid !== undefined) process.kill(-owned.pgid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') owned.forceError = new Error('Chrome termination signal failed: ' + String(error))
    }
  }

  /**
   * Close once, force the observed owned group or leader, and confirm exit before releasing ownership.
   * @returns after exit and pipe disposal; repeated concurrent requests share this result.
   * @throws Error when exit or owned-group termination cannot be confirmed; the handle remains available.
   */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    const pending = this.closeOwned()
    this.closing = pending
    const clear = (): void => {
      this.closing = undefined
      if (this.lifetime !== undefined && this.force.signal.aborted) this.force = new AbortController()
    }
    void pending.then(clear, clear)
    return pending
  }

  private async closeOwned(): Promise<void> {
    const owned = this.lifetime
    if (owned === undefined) return
    const { child, browser } = owned
    let closeError: unknown
    const forced = this.force.signal
    if (!forced.aborted) {
      try { await withBoundedTimeout(() => browser.close(), 10_000, forced, 'Browser close') }
      catch (error) { closeError = error }
    }
    if (child === null || child.pid === undefined || child.pid <= 0 || child.pid === process.pid) {
      throw new Error('shutdown incomplete: Chrome process identity is unavailable', { cause: closeError })
    }
    try {
      const expires = Date.now() + 5_000
      if (!forced.aborted) this.signalKill(owned)
      if (owned.forceError !== undefined && !hasExited(child)) throw owned.forceError
      await withBoundedTimeout(() => owned.exited, 5_000, undefined, 'Chrome exit')
      if (owned.pgid !== undefined) {
        const unmarked = await waitForOwnedGroupMembers(
          owned.pgid, expires - Date.now(), (pid, ms) => isOwnedChromeProcess(pid, owned.profileDir, ms),
        )
        if (unmarked.length > 0) this.onUnverifiedProcesses?.(unmarked)
      }
    } catch (error) {
      throw new Error('shutdown incomplete: owned Chrome pid ' + String(child.pid) + ' or its recorded group: ' + String(error), { cause: owned.error ?? error })
    } finally {
      if (hasExited(child)) for (const stream of child.stdio) stream?.destroy()
    }
    this.lifetime = undefined
  }
}

const CHROME_WAIT_DEADLINE = 'BSK_CHROME_WAIT'

async function withBoundedTimeout<T>(work: () => Promise<T>, ms: number, signal: AbortSignal | undefined, label: string): Promise<T> {
  using bound = deadline(signal, ms, CHROME_WAIT_DEADLINE)
  let abort: (() => void) | undefined
  try {
    bound.signal.throwIfAborted()
    const aborted = new Promise<never>((_, reject) => {
      abort = () => { reject(new Error(label + ' interrupted', { cause: bound.signal.reason })) }
      bound.signal.addEventListener('abort', abort, { once: true })
    })
    return await Promise.race([work(), aborted])
  } catch (error) {
    if (timeoutOf(bound.signal, CHROME_WAIT_DEADLINE) !== undefined) throw new Error(label + ' timed out')
    if (signal?.aborted) throw new Error(label + ' aborted')
    throw error
  } finally {
    if (abort !== undefined) bound.signal.removeEventListener('abort', abort)
  }
}
