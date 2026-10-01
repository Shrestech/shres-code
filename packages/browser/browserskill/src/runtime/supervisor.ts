/**
 * The BrowserSkill runtime supervisor: the single enforcement point for the
 * managed browser stack. It owns the ordered lifecycle (provision, open,
 * close, reset, uninstall), the single-owner lease, the owner-scoped session
 * registry, and the bounded bsk command set, and it re-validates every
 * model-supplied value (URL scheme, ref pattern, key set, value bound)
 * before anything is spawned, so no caller can bypass the bounds.
 *
 * Concurrency: lifecycle operations run one at a time through
 * {@link BrowserSkillRuntime.start}, which reserves and publishes the
 * operation synchronously; a start while any operation runs is refused with
 * `operation-in-progress` — including an identical request, so nothing ever
 * joins. Every teardown — user Close/Reset/Uninstall, an internal exit or
 * health trigger, and dispose — goes through one retirement path
 * ({@link BrowserSkillRuntime.retireCurrent}): abort, drain tracked work,
 * then one ordered close. Dispose additionally SIGKILLs the owned children
 * synchronously through the single-flight escalations before waiting.
 *
 * @module @shres-code/shres-code-browserskill/runtime/supervisor
 */

import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rm, rmdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@shres-code/shres-code-atomic-write'
import type { Logger } from '@shres-code/cordis'
import {
  BSK_OWNED_LABEL,
  BSK_REF_PATTERN,
  BSK_VERSION,
  DEFAULT_DAEMON_PORT,
  EXTENSION_HOST_PERMISSIONS,
  EXTENSION_PERMISSIONS,
  EXTENSION_VERSION,
  FILL_VALUE_MAX_LENGTH,
  PRESS_KEYS,
  consentDownloads,
  effectiveUpdateManifestUrl,
  BSK_PLATFORM_PIN,
} from './manifest.ts'
import { argv, BskCommandError, BskRunner, BskWireError, parseBrowsers, parseSessionStart } from './runner.ts'
import { BskDaemon, DaemonPortInUseError, DaemonStartError } from './daemon.ts'
import { EndpointInUseError, pickAvailableLoopbackPort, reserveLoopbackPort, type PortReservation } from './endpoints.ts'
import { ExtensionLoadError, OwnedChrome } from './chrome.ts'
import { acquireRuntimeLease, LEASE_FILE_NAME, LeaseRefusedError, type HeldRuntimeLease, type LeaseCleanupHooks } from './lease.ts'
import { isOwnedChromeProcess } from './process-group.ts'
import { SessionRegistry } from './sessions.ts'
import { artifactPaths, ensureLaunchArtifacts, preflight, ProvisionRefusedError, provisionArtifacts, readProvisionedState, type ProvisionedState } from './provision.ts'
import type { ResolvedBrowserSkillConfig } from '../config.ts'
import { isJsonValue } from '@shres-code/shres-code-session'
import type { JsonValue } from '@shres-code/shres-code-session/types'
import type {
  BrowserAction,
  BrowserInstanceId,
  BrowserSkillCommandResult,
  BrowserSkillOperation,
  BrowserSkillOperationId,
  BrowserSkillRefusal,
  BrowserSkillStartOptions,
  BrowserSkillStartResult,
  BrowserSkillState,
  BrowserSkillStatus,
  BrowserSkillVerb,
  BskOutput,
  BskSessionId,
  SessionOwner,
} from '../types.ts'

/** Profile directory name inside the root. */
const PROFILE_DIR_NAME = 'profile'

/** Chrome or daemon close could not confirm exit; the lease and recorded pids stay retained. */
class ShutdownIncompleteError extends Error {
  constructor(readonly causes: readonly string[]) {
    super('owned browser processes may still run: ' + causes.join('; '))
    this.name = 'ShutdownIncompleteError'
  }
}

/** Preserve teardown refusals while normalizing errors from resource providers. */
function asShutdownIncomplete(error: unknown, prefix: string): ShutdownIncompleteError {
  return error instanceof ShutdownIncompleteError
    ? error
    : new ShutdownIncompleteError([prefix + (error instanceof Error ? error.message : String(error))])
}

/** Persisted per-runtime choices (the daemon port), inside the root. */
const RUNTIME_STATE_FILE = 'runtime.json'

/**
 * How often the OS ephemeral picker may be consulted before refusing. A
 * fixed internal correctness guard, not a deployment tunable: it bounds one
 * pathological outcome (the picker landing on the fallback port itself).
 */
const DAEMON_PORT_PICK_ATTEMPTS = 8

/**
 * Pick a daemon port that the runtime can actually own. The OS ephemeral
 * range can return DEFAULT_DAEMON_PORT itself, and the fallback-port hold
 * taken before the Chrome launch would then conflict with our own daemon
 * forever, so every pick that lands on the fallback port is discarded.
 * @param pick - the injected ephemeral port picker.
 * @returns the first picked port that is not the fallback port.
 * @throws EndpointInUseError naming the fallback port when every pick lands
 * on it.
 */
async function pickEphemeralDaemonPort(pick: typeof pickAvailableLoopbackPort): Promise<number> {
  for (let attempt = 0; attempt < DAEMON_PORT_PICK_ATTEMPTS; attempt += 1) {
    const port = await pick()
    if (port !== DEFAULT_DAEMON_PORT) return port
  }
  throw new EndpointInUseError(DEFAULT_DAEMON_PORT)
}

/** One opened stack: identity, abort, tracked commands, and retirement state. */
interface ReadyLifetime {
  /** The paired instance this lifetime was opened for. */
  instanceId: BrowserInstanceId
  /** Pinned runner captured for this lifetime, including late-command compensation. */
  readonly runner: BskRunner
  /** Aborts every tracked command and probe when retirement begins. */
  controller: AbortController
  /** Tracked commands and probes; drained before any teardown starts. */
  pending: Set<Promise<unknown>>
  /**
   * Single-flight retirement; never rejects. Set before any teardown work so
   * late exit callbacks and duplicate triggers are refused. Cleared again on
   * failure so a later user Close/Reset/Uninstall/dispose can open a fresh
   * retirement; the aborted controller and the retained lease keep commands
   * and reopen refused in the meantime.
   */
  retiring?: Promise<RetirementResult> | undefined
  /** Successful teardown state; a manual operation can replace an internal target. */
  closeState?: BrowserSkillState | undefined
}

/** Private outcome of a retirement: the teardown either completed or failed. */
type RetirementResult = { ok: true } | { ok: false; error: ShutdownIncompleteError }

/** Constructor options for one owned BrowserSkill runtime. */
export interface BrowserSkillRuntimeOptions {
  /** Owned root directory: `join(resolveShresHome(), 'browserskill')`. */
  root: string
  /** Validated deployment config. */
  config: ResolvedBrowserSkillConfig
  /** Plugin logger. */
  logger: Logger
}

/** The owned-daemon seam the supervisor drives; tests substitute the real daemon structurally. */
export type BskDaemonSeam = Pick<BskDaemon, 'start' | 'stop' | 'forceStop' | 'pidMatches' | 'current'>

/** The owned-Chrome seam the supervisor drives; tests substitute the real Chrome structurally. */
export type OwnedChromeSeam = Pick<OwnedChrome, 'launchAndPair' | 'close' | 'forceClose' | 'current'>

/** Package-internal substitution points for unit tests. */
export interface BrowserSkillRuntimeInternals {
  runner?: BskRunner
  daemon?: BskDaemonSeam
  chrome?: OwnedChromeSeam
  provision?: typeof provisionArtifacts
  preflight?: typeof preflight
  ensureLaunchArtifacts?: typeof ensureLaunchArtifacts
  pickDaemonPort?: typeof pickAvailableLoopbackPort
  acquireLease?: typeof acquireRuntimeLease
  reservePort?: typeof reserveLoopbackPort
  now?: () => number
}

type CoreInternals = Required<Omit<BrowserSkillRuntimeInternals, 'runner' | 'daemon' | 'chrome'>>
type InstanceInternals = CoreInternals & Pick<BrowserSkillRuntimeInternals, 'runner' | 'daemon' | 'chrome'>

/** Validated persisted runtime state: only the daemon port survives restarts. */
async function readDaemonPort(root: string): Promise<number | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(root, RUNTIME_STATE_FILE), 'utf8'))
    if (typeof raw !== 'object' || raw === null) return undefined
    const wire = raw as Record<string, unknown>
    if (wire.version !== 1) return undefined
    const port = wire.daemonPort
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535) return undefined
    // A persisted fallback port is unusable by construction: the fallback-port
    // hold taken during startup would conflict with our own daemon. Treat it
    // as absent so a usable port is picked and persisted instead.
    if (port === DEFAULT_DAEMON_PORT) return undefined
    return port
  } catch {
    return undefined
  }
}

/**
 * The managed browser stack for one harness home. Construct one per plugin;
 * the gateway and the tools share it. Every mutating operation respects the
 * root lease, and every command method takes its owner explicitly — there is
 * no current-session fallback anywhere in this class.
 */
export class BrowserSkillRuntime {
  /** Validated deployment config. */
  readonly config: ResolvedBrowserSkillConfig

  private readonly root: string
  private readonly logger: Logger
  private readonly sessions = new SessionRegistry()
  private readonly listeners = new Set<(status: BrowserSkillStatus) => void>()

  private state: BrowserSkillState = { kind: 'absent' }
  private operation: BrowserSkillOperation | undefined
  private chromeVersion: string | undefined
  private provisioned: ProvisionedState | undefined
  private lease: HeldRuntimeLease | undefined
  private defaultPortHold: PortReservation | undefined
  private runner: BskRunner | undefined
  private daemon: BskDaemonSeam | undefined
  private chrome: OwnedChromeSeam | undefined
  private canonicalRoot: string | undefined
  private readyLifetime: ReadyLifetime | undefined
  private pendingRetirement: Promise<RetirementResult> | undefined
  private healthTimer: NodeJS.Timeout | undefined
  private healthMisses = 0
  private inFlight: {
    verb: BrowserSkillVerb
    settled: Promise<BrowserSkillOperation>
    controller: AbortController
  } | undefined
  private disposed = false

  constructor(options: BrowserSkillRuntimeOptions) {
    this.root = options.root
    this.config = options.config
    this.logger = options.logger
    internalsByInstance.set(this, {
      provision: provisionArtifacts,
      preflight,
      ensureLaunchArtifacts,
      pickDaemonPort: pickAvailableLoopbackPort,
      acquireLease: acquireRuntimeLease,
      reservePort: reserveLoopbackPort,
      now: () => Date.now(),
    })
  }

  /** Read the durable artifact record so a constructed runtime reports provisioned state. */
  async refreshProvisioned(): Promise<void> {
    const state = await readProvisionedState(this.root)
    if (state === undefined) return
    this.provisioned = state
    if (this.state.kind === 'absent') this.setState({ kind: 'provisioned' })
  }

  /**
   * Current status snapshot for the gateway and UI.
   * @returns the durable state, the artifact receipts while provisioned,
   * the consent disclosure paths, and the running operation when one is
   * reserved.
   */
  status(): BrowserSkillStatus {
    return {
      state: this.state,
      ...(this.chromeVersion === undefined ? {} : { chrome: { version: this.chromeVersion } }),
      ...(this.provisioned === undefined ? {} : {
        artifacts: {
          bsk: { version: BSK_VERSION, sha256: this.provisioned.bsk.binarySha256 },
          extension: { version: EXTENSION_VERSION, sha256: this.provisioned.extension.archiveSha256 },
        },
      }),
      consent: {
        downloads: consentDownloads(this.config),
        extensionPermissions: EXTENSION_PERMISSIONS,
        extensionHostPermissions: EXTENSION_HOST_PERMISSIONS,
        installDir: this.canonicalRoot ?? this.root,
        profileDir: join(this.canonicalRoot ?? this.root, PROFILE_DIR_NAME),
        updateManifestUrl: effectiveUpdateManifestUrl(this.config),
      },
      ...(this.operation === undefined ? {} : { operation: this.operation }),
    }
  }

  /**
   * Observe every status change.
   * @param listener - callback invoked on each transition; exceptions are contained.
   * @returns the unsubscribe function.
   */
  subscribe(listener: (status: BrowserSkillStatus) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Reserve and publish a lifecycle operation synchronously, then run it.
   * Provision runs the disclosed provision-and-open flow and ends ready or
   * failed. While any operation runs — including an identical one — the start
   * is refused and nothing joins; a disposed runtime refuses every start.
   * @param verb - the lifecycle operation to run.
   * @returns acceptance carrying the operation id and its settled promise, or
   * the refusal with no operation started.
   */
  start(verb: 'provision' | 'open' | 'close' | 'reset'): BrowserSkillStartResult
  /**
   * Start the uninstall; the profile and its sign-ins survive only when kept.
   * @param verb - the uninstall verb.
   * @param options - whether the profile directory survives the purge.
   * @returns acceptance carrying the operation id and its settled promise, or
   * the refusal with no operation started.
   */
  start(verb: 'uninstall', options: BrowserSkillStartOptions): BrowserSkillStartResult
  start(verb: BrowserSkillVerb, options?: BrowserSkillStartOptions): BrowserSkillStartResult {
    if (this.disposed) {
      return { accepted: false, refusal: { kind: 'disposed', detail: 'the BrowserSkill runtime has been disposed' } }
    }
    if (this.inFlight !== undefined) {
      return { accepted: false, refusal: { kind: 'operation-in-progress' } }
    }
    // A lifetime that is retiring, or retained after a failed retirement
    // with its aborted controller, still owns the lease right now: Open and
    // Provision must not reacquire it (they would self-refuse as a peer and
    // poison a recoverable state), while Close remains the retry path.
    const retained = this.readyLifetime
    if ((verb === 'open' || verb === 'provision') && retained !== undefined &&
        (retained.retiring !== undefined || retained.controller.signal.aborted)) {
      return { accepted: false, refusal: { kind: 'operation-in-progress' } }
    }
    // A retained lease with no ready lifetime is an unfinished shutdown: the
    // recorded pids may still run, so reopening would self-refuse as a peer
    // and poison a recoverable state. Close finishes the teardown first.
    if ((verb === 'open' || verb === 'provision') && retained === undefined && this.lease !== undefined) {
      const content = this.lease.content()
      const recorded = [
        ...(content.browserPid === undefined ? [] : [`browser pid ${content.browserPid}`]),
        ...(content.daemonPid === undefined ? [] : [`daemon pid ${content.daemonPid}`]),
      ].join(', ')
      return {
        accepted: false,
        refusal: {
          kind: 'shutdown-incomplete',
          detail: `a previous shutdown left recorded owned processes behind (${recorded}); run Close to finish shutting down the stack before opening`,
        },
      }
    }
    const controller = new AbortController()
    const id = randomUUID() as BrowserSkillOperationId
    let resolveSettled!: (operation: BrowserSkillOperation) => void
    const settled = new Promise<BrowserSkillOperation>((resolve) => {
      resolveSettled = resolve
    })
    this.inFlight = { verb, controller, settled }
    this.operation = { id, verb, phase: 'running' }
    this.notify()
    void (async () => {
      let terminal: BrowserSkillOperation & ({ phase: 'succeeded' } | { phase: 'failed'; refusal: BrowserSkillRefusal })
      try {
        await this.runVerb(verb, options, controller.signal)
        terminal = { id, verb, phase: 'succeeded' }
      } catch (error) {
        const refusal: BrowserSkillRefusal = this.disposed
          ? { kind: 'disposed', detail: 'the BrowserSkill runtime was disposed while the operation ran' }
          : this.refusalOf(error)
        terminal = { id, verb, phase: 'failed', refusal }
      }
      // The accepted operation also owns any internal retirement requested while it runs.
      while (this.pendingRetirement !== undefined) {
        const retirement = this.pendingRetirement
        const result = await retirement
        this.pendingRetirement = undefined
        // A retirement failure corrects a still-successful operation; an
        // existing failure is never overwritten.
        if (!result.ok && terminal.phase === 'succeeded') {
          terminal = {
            id, verb, phase: 'failed',
            refusal: { kind: 'shutdown-incomplete', detail: result.error.causes.join('; ') },
          }
        }
      }
      if (terminal.phase === 'failed') this.state = { kind: 'failed', refusal: terminal.refusal }
      this.operation = terminal
      this.inFlight = undefined
      this.notify()
      resolveSettled(terminal)
    })()
    return { accepted: true, operationId: id, settled }
  }

  /** Run one accepted verb's flow to its terminal state; every failure throws. */
  private async runVerb(verb: BrowserSkillVerb, options: BrowserSkillStartOptions | undefined, signal: AbortSignal): Promise<void> {
    switch (verb) {
      case 'provision':
        if (this.provisioned === undefined) await this.provisionUnderLease(signal)
        // Already ready: the stack is up under the held lease, so reopen is a
        // no-op success — reacquiring our own lease would refuse and poison a
        // healthy state.
        if (this.state.kind === 'ready') return
        await this.openUnderLease(signal)
        return
      case 'open':
        // Already ready: reopen is a no-op success for the same reason.
        if (this.state.kind === 'ready') return
        await this.openUnderLease(signal)
        return
      case 'close': {
        // The one teardown path: retire the ready lifetime, or close the
        // partial stack a failed open left behind — never a bare close.
        const closed = await this.retireCurrent({ kind: this.provisioned === undefined ? 'absent' : 'provisioned' })
        if (!closed.ok) throw closed.error
        return
      }
      case 'reset': {
        const retired = await this.retireCurrent()
        if (!retired.ok) throw retired.error
        const internals = this.internals()
        const root = await this.canonicalRootPath()
        const lease = await internals.acquireLease(root, this.leaseHooks(root, this.ensureRunner(root)))
        this.lease = lease
        try {
          await rm(join(root, PROFILE_DIR_NAME), { recursive: true, force: true })
          await rm(join(root, 'chrome-home'), { recursive: true, force: true })
          await rm(join(root, RUNTIME_STATE_FILE), { force: true })
          const port = await pickEphemeralDaemonPort(internals.pickDaemonPort)
          await writeFileAtomic(
            join(root, RUNTIME_STATE_FILE),
            `${JSON.stringify({ version: 1, daemonPort: port }, null, 2)}\n`,
            { mode: 0o600, dirMode: 0o700 },
          )
          signal.throwIfAborted()
        } finally {
          await this.releaseLease(lease)
        }
        this.setState({ kind: 'provisioned' })
        return
      }
      case 'uninstall': {
        const keepProfile = options?.keepProfile === true
        const retired = await this.retireCurrent()
        if (!retired.ok) throw retired.error
        const internals = this.internals()
        const root = await this.canonicalRootPath()
        const lease = await internals.acquireLease(root, this.leaseHooks(root, this.ensureRunner(root)))
        this.lease = lease
        const leaseFileNames = new Set([LEASE_FILE_NAME, LEASE_FILE_NAME + '.lock'])
        try {
          signal.throwIfAborted()
          for (const name of await readdir(root)) {
            // The lease and its writer mutex are skipped: the lock keeps
            // excluding peers for the whole purge, and the mutex stays valid
            // for this release.
            if (leaseFileNames.has(name)) continue
            if (keepProfile && name === PROFILE_DIR_NAME) continue
            const path = join(root, name)
            // Recursive deletion can partially remove the receipt before failing.
            if (path === dirname(artifactPaths(root).stateFile)) this.provisioned = undefined
            await rm(path, { recursive: true, force: true })
          }
          // The lock survived the purge and still excludes peers mid-deletion.
          if (!existsSync(join(root, LEASE_FILE_NAME))) {
            throw new Error('the runtime lock vanished during the purge')
          }
        } finally {
          await this.releaseLease(lease)
        }
        if (!keepProfile) {
          // Remove the emptied shell, never recursively: a peer that
          // re-acquired the released lock between the release and this rmdir
          // keeps its lease files (ENOTEMPTY), and an already-gone shell is
          // fine (ENOENT). Any other failure is real and fails loud.
          try {
            await rmdir(root)
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code !== 'ENOTEMPTY' && code !== 'ENOENT') throw error
          }
        }
        this.provisioned = undefined
        this.chromeVersion = undefined
        this.setState({ kind: 'absent' })
        return
      }
    }
  }

  /**
   * Dispose has no completion deadline: a pending launch, tracked-command
   * drain, or exit wait can exceed any fixed disposal budget, and the
   * daemon's process-exit backstop kills the owned children when the host
   * process exits first. Fast disposal first: the running operation and the
   * ready lifetime are aborted, and the owned Chrome and daemon are
   * SIGKILLed through the single-flight escalations — all synchronously,
   * before the first await, so a later startup step observes the abort and
   * never launches. The existing operation or retirement is then awaited,
   * and the cleanup itself joins the one retirement path: a retained
   * lifetime from a failed retirement is retried, and a clean stack makes it
   * a confirmed no-op.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.readyLifetime?.controller.abort(new Error('the BrowserSkill runtime has been disposed'))
    const inFlight = this.inFlight
    inFlight?.controller.abort(new Error('the BrowserSkill runtime has been disposed'))
    this.chrome?.forceClose()
    this.daemon?.forceStop()
    if (inFlight !== undefined) {
      await inFlight.settled
    }
    const result = await this.retireCurrent({ kind: this.provisioned === undefined ? 'absent' : 'provisioned' })
    if (!result.ok) {
      // Shutdown failures stay visible: the state carries the refusal and the
      // lease with its recorded pids stays retained for a later retry.
      this.logger.warn('browserskill: dispose shutdown incomplete: %s', result.error.message)
    }
  }

  /**
   * Start one bsk session bound to the owned instance.
   * @param owner - the calling agent session; no global fallback exists.
   * @param signal - the caller's abort; an abort here tears the runtime down.
   * @returns ok with the bound session id, or the failure reason: not-ready,
   * command-failed, aborted, or instance-mismatch. Never rejects.
   */
  async startSession(owner: SessionOwner, signal: AbortSignal): Promise<BrowserSkillCommandResult<{ session: BskSessionId }>> {
    const lt = this.captureReadyLifetime()
    if (lt === undefined) return notReady(this.state)
    const runner = lt.runner
    const tracked = (async (): Promise<BrowserSkillCommandResult<{ session: BskSessionId }>> => {
      try {
        const started = await runner.runJson(
          argv.sessionStart(lt.instanceId), parseSessionStart, undefined, AbortSignal.any([signal, lt.controller.signal]),
        )
        // Retirement began mid-start: compensate the returned session on the
        // captured runner with a fresh teardown signal, then refuse — the
        // session never registers and no new lifetime exists until this settles.
        if (!this.isCurrent(lt)) {
          await runner.runJson(
            argv.sessionStop(started.sessionId), requireJsonObject, undefined, new AbortController().signal,
          ).catch(() => undefined)
          return notReady(this.state)
        }
        if (started.browserInstanceId !== lt.instanceId) {
          await this.stopForeignSession(lt, started.sessionId)
          return { ok: false, reason: 'instance-mismatch', detail: `session start bound browser ${started.browserInstanceId}, not ours ${lt.instanceId}` }
        }
        this.sessions.register(owner, started.sessionId, started.browserInstanceId)
        return { ok: true, value: { session: started.sessionId } }
      } catch (error) {
        return  this.lostStartOutcome(error, lt)
      }
    })()
    this.track(lt, tracked)
    return tracked
  }

  /**
   * Stop one session this owner started.
   * @param owner - the calling agent session.
   * @param session - the bsk session to stop.
   * @param signal - the caller's abort.
   * @returns ok once the session stopped and was unregistered, or the failure
   * reason: not-ready, unknown-session, command-failed, or aborted. Never
   * rejects.
   */
  async stopSession(owner: SessionOwner, session: BskSessionId, signal: AbortSignal): Promise<BrowserSkillCommandResult<void>> {
    const lt = this.captureReadyLifetime()
    if (lt === undefined) return notReady(this.state)
    if (!this.sessions.isOwnedBy(owner, session)) return unknownSession()
    const tracked = (async (): Promise<BrowserSkillCommandResult<void>> => {
      try {
        await lt.runner.runJson(
          argv.sessionStop(session), requireJsonObject, undefined, AbortSignal.any([signal, lt.controller.signal]),
        )
        this.sessions.unregister(session)
        return { ok: true, value: undefined }
      } catch (error) {
        return lostCommandOutcome(error, 'session stop')
      }
    })()
    this.track(lt, tracked)
    return tracked
  }

  /**
   * The calling agent session's own sessions, in registration order.
   * @param owner - the calling agent session.
   * @returns the sessions this owner started, oldest first; other owners'
   * sessions are never visible.
   */
  listSessions(owner: SessionOwner): readonly BskSessionId[] {
    return this.sessions.listFor(owner)
  }

  /**
   * Navigate the session's agent tab.
   * @param owner - the calling agent session.
   * @param session - the bsk session.
   * @param url - destination; only http and https pass.
   * @param signal - the caller's abort.
   * @returns the parsed navigation output, or the failure reason: not-ready,
   * unknown-session, invalid-argument, command-failed, or aborted. Never
   * rejects.
   */
  async navigate(owner: SessionOwner, session: BskSessionId, url: URL, signal: AbortSignal): Promise<BrowserSkillCommandResult<BskOutput>> {
    const lt = this.captureReadyLifetime()
    if (lt === undefined) return notReady(this.state)
    if (!this.sessions.isOwnedBy(owner, session)) return unknownSession()
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, reason: 'invalid-argument', detail: `only http and https URLs navigate; got ${url.protocol}` }
    }
    return this.runSessionCommand(lt, argv.navigate(session, url), signal, 'navigate')
  }

  /**
   * Produce a semantic observation of the session's tab.
   * @param owner - the calling agent session.
   * @param session - the bsk session.
   * @param signal - the caller's abort.
   * @returns the parsed observation output, or the failure reason: not-ready,
   * unknown-session, command-failed, or aborted. Never rejects.
   */
  async observe(owner: SessionOwner, session: BskSessionId, signal: AbortSignal): Promise<BrowserSkillCommandResult<BskOutput>> {
    const lt = this.captureReadyLifetime()
    if (lt === undefined) return notReady(this.state)
    if (!this.sessions.isOwnedBy(owner, session)) return unknownSession()
    return this.runSessionCommand(lt, argv.observe(session), signal, 'observe')
  }

  /**
   * Perform one bounded interaction: click or fill by snapshot ref, or press
   * a key from the fixed set. Values are re-validated here — the runtime is
   * the enforcement point, not the caller.
   * @param owner - the calling agent session.
   * @param session - the bsk session.
   * @param action - the validated interaction: click or fill by snapshot ref,
   * or a press from the fixed key set.
   * @param signal - the caller's abort.
   * @returns the parsed interaction output, or the failure reason: not-ready,
   * unknown-session, invalid-argument, command-failed, or aborted. Never
   * rejects.
   */
  async act(
    owner: SessionOwner, session: BskSessionId, action: BrowserAction, signal: AbortSignal,
  ): Promise<BrowserSkillCommandResult<BskOutput>> {
    const lt = this.captureReadyLifetime()
    if (lt === undefined) return notReady(this.state)
    if (!this.sessions.isOwnedBy(owner, session)) return unknownSession()
    switch (action.kind) {
      case 'click': {
        if (!BSK_REF_PATTERN.test(action.ref)) return invalidArgument(`ref must match ${BSK_REF_PATTERN}`)
        return this.runSessionCommand(lt, argv.click(session, action.ref), signal, 'click')
      }
      case 'fill': {
        if (!BSK_REF_PATTERN.test(action.ref)) return invalidArgument(`ref must match ${BSK_REF_PATTERN}`)
        if (action.value.length > FILL_VALUE_MAX_LENGTH) return invalidArgument(`fill value exceeds ${FILL_VALUE_MAX_LENGTH} characters`)
        return this.runSessionCommand(lt, argv.fill(session, action.ref, action.value), signal, 'fill')
      }
      case 'press': {
        if (!PRESS_KEYS.has(action.key)) return invalidArgument(`key must be one of the fixed set, not ${JSON.stringify(action.key)}`)
        return this.runSessionCommand(lt, argv.press(session, action.key), signal, 'press')
      }
    }
  }

  // ---- internals ----

  private internals(): InstanceInternals {
    return internalsByInstance.get(this) as InstanceInternals
  }

  /**
   * Canonicalize the owned root for the mutating lease path: create the
   * directory, then use the kernel-resolved path so artifact, profile, lease,
   * and stale-cleanup paths stay stable across alias paths (symlinks,
   * /tmp vs /private/tmp). Boot-time refresh stays read-only and never calls
   * this.
   */
  private async canonicalRootPath(): Promise<string> {
    if (this.canonicalRoot === undefined) {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      this.canonicalRoot = await realpath(this.root)
    }
    return this.canonicalRoot
  }

  /**
   * Capture the current ready lifetime for one command, or refuse: absent,
   * aborted, retiring, or a lifecycle operation in flight are all not-ready.
   * Synchronous, before any await or spawn.
   */
  private captureReadyLifetime(): ReadyLifetime | undefined {
    const lt = this.readyLifetime
    if (lt === undefined || lt.controller.signal.aborted || lt.retiring !== undefined) return undefined
    if (this.inFlight !== undefined) return undefined
    return lt
  }

  /** Track one command against the lifetime it captured; the chain is rejection-contained. */
  private track(lt: ReadyLifetime, work: Promise<unknown>): void {
    const tracked = Promise.allSettled([work]).then(() => { lt.pending.delete(tracked) })
    lt.pending.add(tracked)
  }

  /** Whether a command's captured lifetime is still the current, active one. */
  private isCurrent(lt: ReadyLifetime): boolean {
    return this.readyLifetime === lt && !lt.controller.signal.aborted && lt.retiring === undefined
  }

  /**
   * Internal trigger (exit watcher, health probe, lost start) asking for the
   * captured lifetime's shutdown. Synchronous and identity-checked: a stale
   * lifetime, an already-retiring one, an already-aborted one (a failed
   * retirement — stale exit callbacks must not retry it), or a disposed
   * runtime is a no-op. An in-flight operation reservation is reused — its
   * finalizer drains the retirement — otherwise an internal close operation
   * is reserved. The retirement is never awaited here, so tracked work
   * cannot self-join its own teardown.
   */
  private internalShutdown(lt: ReadyLifetime, reason: string): void {
    if (this.disposed || this.readyLifetime !== lt || lt.retiring !== undefined || lt.controller.signal.aborted) return
    if (this.inFlight !== undefined) {
      this.pendingRetirement = this.retire(lt, { kind: 'disconnected' })
      this.logger.warn('browserskill: %s', reason)
      return
    }
    const id = randomUUID() as BrowserSkillOperationId
    let resolveSettled!: (operation: BrowserSkillOperation) => void
    const settled = new Promise<BrowserSkillOperation>((resolve) => { resolveSettled = resolve })
    this.inFlight = { verb: 'close', controller: new AbortController(), settled }
    const retirement = this.retire(lt, { kind: 'disconnected' })
    this.pendingRetirement = retirement
    this.operation = { id, verb: 'close', phase: 'running' }
    this.notify()
    this.logger.warn('browserskill: %s', reason)
    void (async () => {
      const result = await retirement
      this.pendingRetirement = undefined
      const terminal: BrowserSkillOperation = result.ok
        ? { id, verb: 'close', phase: 'succeeded' }
        : { id, verb: 'close', phase: 'failed', refusal: { kind: 'shutdown-incomplete', detail: result.error.causes.join('; ') } }
      this.operation = terminal
      this.inFlight = undefined
      this.notify()
      resolveSettled(terminal)
    })()
  }

  /**
   * The one teardown path for whatever the runtime currently owns: retire the
   * ready lifetime when one exists, otherwise close the partially started
   * owned stack — daemon, Chrome, default port hold, lease — that a failed or
   * interrupted open can leave behind. Never rejects.
   */
  private retireCurrent(successState?: BrowserSkillState): Promise<RetirementResult> {
    const lt = this.readyLifetime
    if (lt !== undefined) return this.retire(lt, successState)
    return this.closePartial(successState)
  }

  /**
   * One ordered close over whatever owned state exists, as a retirement
   * result. A close that cannot confirm an owned process exited leaves the
   * runtime failed and reports the failure; successState, when given, is
   * published only after the teardown completed.
   */
  private async closePartial(successState?: BrowserSkillState): Promise<RetirementResult> {
    try {
      await this.closeInternal()
      if (successState !== undefined) this.setState(successState)
      return { ok: true }
    } catch (error) {
      const failure = asShutdownIncomplete(error, '')
      this.setState({ kind: 'failed', refusal: { kind: 'shutdown-incomplete', detail: failure.causes.join('; ') } })
      return { ok: false, error: failure }
    }
  }

  /**
   * Retire one lifetime: abort its controller synchronously, register the
   * single-flight marker before any teardown work, drain the tracked
   * commands, then run one ordered close. The result never rejects. Only
   * manual callers can join a running retirement and replace its successful
   * end state; internal callers can only start one. A failed retirement
   * retains the lease, the recorded pids, and the aborted
   * lifetime, clears the marker for a later manual Close/Reset/Uninstall/
   * dispose retry, and leaves the runtime failed; no failure is cached and
   * no retry runs automatically.
   */
  private retire(lt: ReadyLifetime, successState?: BrowserSkillState): Promise<RetirementResult> {
    lt.closeState = successState
    if (lt.retiring !== undefined) return lt.retiring
    lt.controller.abort(new Error('the ready lifetime is retiring'))
    const retiring = (async (): Promise<RetirementResult> => {
      await Promise.allSettled([...lt.pending])
      const result = await this.closePartial()
      if (result.ok) {
        this.readyLifetime = undefined
        if (lt.closeState !== undefined) this.setState(lt.closeState)
      } else {
        // Single-flight means this body still owns the marker: clearing it is
        // what licenses the next manual retirement.
        lt.retiring = undefined
      }
      return result
    })()
    lt.retiring = retiring
    return retiring
  }

  /** Map any thrown error onto the user-displayable refusal union. */
  private refusalOf(error: unknown): BrowserSkillRefusal {
    if (error instanceof ShutdownIncompleteError) {
      return { kind: 'shutdown-incomplete', detail: error.causes.join('; ') }
    }
    if (error instanceof ProvisionRefusedError) return error.refusal
    if (error instanceof ExtensionLoadError) return { kind: 'extension-load-failed', detail: error.detail }
    if (error instanceof LeaseRefusedError) return error.refusal
    if (error instanceof EndpointInUseError) return { kind: 'endpoint-in-use', port: error.port }
    if (error instanceof DaemonPortInUseError) return { kind: 'endpoint-in-use', port: error.port }
    if (error instanceof DaemonStartError) return { kind: 'daemon-start-failed', detail: error.message }
    return { kind: 'daemon-start-failed', detail: error instanceof Error ? error.message : String(error) }
  }

  /** Provision under a temporary lease; the record lands in the durable state file. */
  private async provisionUnderLease(signal: AbortSignal): Promise<void> {
    const internals = this.internals()
    const root = await this.canonicalRootPath()
    const checks = await internals.preflight()
    this.chromeVersion = checks.chromeVersion
    this.setState({ kind: 'provisioning', step: 'download' })
    const lease = await internals.acquireLease(root, this.leaseHooks(root, this.ensureRunner(root)))
    this.lease = lease
    try {
      this.provisioned = await internals.provision({
        root,
        config: this.config,
        onStep: (step) =>{  this.setState({ kind: 'provisioning', step }) },
        signal,
      })
    } finally {
      await this.releaseLease(lease)
    }
    this.setState({ kind: 'provisioned' })
  }

  /** Acquire ownership, verify artifacts, and pair only the owned browser instance. */
  private async openUnderLease(signal: AbortSignal): Promise<void> {
    const internals = this.internals()
    const root = await this.canonicalRootPath()
    const checks = await internals.preflight()
    this.chromeVersion = checks.chromeVersion
    this.setState({ kind: 'starting' })
    const runner = this.ensureRunner(root)
    const lease = await internals.acquireLease(root, this.leaseHooks(root, runner))
    this.lease = lease
    try {
      const provisioned = await internals.ensureLaunchArtifacts(root, this.config, signal)
      this.provisioned = provisioned
      let port = await readDaemonPort(root)
      if (port === undefined) {
        port = await pickEphemeralDaemonPort(internals.pickDaemonPort)
        await writeFileAtomic(
          join(root, RUNTIME_STATE_FILE),
          JSON.stringify({ version: 1, daemonPort: port }, null, 2) + '\n',
          { mode: 0o600, dirMode: 0o700 },
        )
      }
      const daemon = this.ensureDaemon(runner)
      signal.throwIfAborted()
      const started = await daemon.start(port, {
        signal,
        onSpawned: async (pid) => { await lease.update({ daemonPid: pid }) },
      })
      const hold = await internals.reservePort(DEFAULT_DAEMON_PORT)
      this.defaultPortHold = hold
      signal.throwIfAborted()
      const paired = await this.ensureChrome().launchAndPair({
        executablePath: checks.executablePath,
        profileDir: join(root, PROFILE_DIR_NAME),
        env: this.chromeEnv(root),
        extensionDir: provisioned.extension.dir,
        daemonPort: port,
        timeoutMs: this.config.browserConnectTimeoutMs,
        protocolTimeoutMs: Math.min(this.config.browserConnectTimeoutMs, 15_000),
        signal,
        onLaunched: async (pid, pgid) => {
          await lease.update({ browserPid: pid, browserPgid: pgid ?? null })
        },
      })
      await this.waitInstanceReady(runner, paired.instanceId, signal)
      await hold.release()
      this.defaultPortHold = undefined
      signal.throwIfAborted()
      if (started.child.exitCode !== null || started.child.signalCode !== null) {
        throw new DaemonStartError('owned daemon exited during startup')
      }
      const browserChild = paired.browser.process()
      if (browserChild === null || browserChild.exitCode !== null || browserChild.signalCode !== null) {
        throw new ExtensionLoadError('owned Chrome exited during startup')
      }
      const lt: ReadyLifetime = {
        instanceId: paired.instanceId,
        runner,
        controller: new AbortController(),
        pending: new Set(),
      }
      this.readyLifetime = lt
      this.healthMisses = 0
      this.watchDaemon(lt, started.child)
      this.watchBrowser(lt, browserChild)
      this.armHealthLoop(lt)
      this.setState({ kind: 'ready', instanceId: paired.instanceId })
    } catch (error) {
      const cleanup = await this.retireCurrent()
      if (!cleanup.ok) throw cleanup.error
      throw error
    }
  }

  /**
   * Stop the owned browser and daemon in the close order, keeping the
   * fallback-port hold as containment: the hold stays bound while an owned
   * browser may still run and is released exactly once once Chrome is
   * confirmed gone. A host process exit drops the hold's socket — that
   * residual is inherent to an in-process hold.
   * @returns which owned children are confirmed gone and the causes
   * collected while stopping them (the retained hold is one of the causes).
   */
  private async stopOwnedChildren(): Promise<{ chromeConfirmed: boolean; daemonConfirmed: boolean; causes: string[] }> {
    const causes: string[] = []
    let chromeConfirmed = true
    let daemonConfirmed = true
    if (this.chrome !== undefined) {
      try { await this.chrome.close() }
      catch (error) {
        chromeConfirmed = false
        causes.push('chrome close failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    if (this.defaultPortHold !== undefined) {
      if (chromeConfirmed) {
        await this.defaultPortHold.release().catch(() => undefined)
        this.defaultPortHold = undefined
      } else {
        causes.push('default port ' + String(DEFAULT_DAEMON_PORT) + ' hold kept bound with the unconfirmed owned browser')
      }
    }
    if (this.daemon !== undefined) {
      try { await this.daemon.stop() }
      catch (error) {
        daemonConfirmed = false
        causes.push('daemon stop failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    return { chromeConfirmed, daemonConfirmed, causes }
  }

  /**
   * Ordered close: sessions, browser, fallback-port hold, daemon — lease
   * last. A close that cannot confirm an owned process exited retains the
   * lease, its recorded pids, and the fallback-port hold, and throws
   * ShutdownIncompleteError, so no caller releases the lock, clears the
   * in-process holder, or deletes files while an owned process may still
   * run. The confirmed-exited child's pid is cleared from the retained
   * lease; only after both exits are confirmed are the pids cleared and the
   * lease released.
   */
  private async closeInternal(): Promise<void> {
    this.stopHealthLoop()
    const lease = this.lease
    if (lease === undefined) return
    // Every acquisition constructs this runner before it can store the lease.
    const runner = this.runner as BskRunner
    const sessions = this.sessions.all()
    this.sessions.clear()
    for (const session of sessions) {
      await runner.run(argv.sessionStop(session)).catch(() => undefined)
    }
    const { chromeConfirmed, daemonConfirmed, causes } = await this.stopOwnedChildren()
    if (causes.length > 0) {
      // Keep only the pids that may still run in the retained lease.
      const clear: { daemonPid?: number | null; browserPid?: number | null; browserPgid?: number | null } = {}
      if (chromeConfirmed) {
        clear.browserPid = null
        clear.browserPgid = null
      }
      if (daemonConfirmed) clear.daemonPid = null
      // Failed bookkeeping must not mask the unconfirmed process exit.
      await lease.update(clear).catch(() => undefined)
      throw new ShutdownIncompleteError(causes)
    }
    await this.releaseLease(lease)
  }

  /** Retain the release capability after failure so a later Close can retry exactly once. */
  private async releaseLease(lease: HeldRuntimeLease): Promise<void> {
    try { await lease.release() }
    catch (error) {
      throw asShutdownIncomplete(error, 'lease release failed: ')
    }
    this.lease = undefined
  }

  /** Poll the daemon's browser list until OUR instance id is listed with our label. */
  private async waitInstanceReady(runner: BskRunner, instanceId: BrowserInstanceId, signal: AbortSignal): Promise<void> {
    const deadline = this.internals().now() + this.config.browserConnectTimeoutMs
    for (;;) {
      signal.throwIfAborted()
      if (this.internals().now() >= deadline) {
        throw new ProvisionRefusedError({ kind: 'instance-mismatch' })
      }
      try {
        // The poll runs under the open's signal: cancellation kills the
        // in-flight startup CLI instead of waiting out its deadline.
        const browsers = await runner.runJson(argv.browsers(), parseBrowsers, undefined, signal)
        const mine = browsers.find(entry => entry.instanceId === instanceId)
        if (mine !== undefined && mine.label === BSK_OWNED_LABEL) return
      } catch (error) {
        if (error instanceof BskWireError) throw new ProvisionRefusedError({ kind: 'instance-mismatch' })
        // A busy or lost status probe retries until the deadline; the daemon itself decides readiness.
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }

  /** Stale cleanup uses the pinned runner and only the recorded, verified process ids. */
  private leaseHooks(root: string, runner: BskRunner): LeaseCleanupHooks {
    const canonicalProfileDir = join(root, PROFILE_DIR_NAME)
    return {
      browserIsOurs: (pid, timeoutMs) => isOwnedChromeProcess(pid, canonicalProfileDir, timeoutMs),
      killBrowser: (pid) => {
        try { process.kill(pid, 'SIGKILL') }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
        return Promise.resolve()
      },
      daemonIsOurs: async (pid) => {
        try { return await runner.runJson(argv.status(), parseStatusPid) === pid }
        catch { return false } // An unanswered or malformed status does not prove ownership.
      },
      stopDaemon: async (pid) => {
        try {
          const result = await runner.run(argv.daemonStop(), { timeoutMs: Math.max(this.config.commandTimeoutMs, 15_000) })
          if (result.timedOut || result.aborted || result.exitCode !== 0 || result.signal !== null) {
            throw new Error('the bounded daemon stop failed')
          }
        } catch (error) {
          throw new LeaseRefusedError({ kind: 'owned-by-peer', pid },
            'cannot stop recorded daemon pid ' + String(pid) + ': ' + String(error) + '; resolve it manually')
        }
        await this.waitForRecordedDaemonExit(pid)
      },
    }
  }

  /** A stale process has no child handle or signal authority; only confirmed disappearance releases it. */
  private async waitForRecordedDaemonExit(pid: number): Promise<void> {
    const now = this.internals().now
    const deadline = now() + 12_000
    for (;;) {
      try { process.kill(pid, 0) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
        throw new LeaseRefusedError({ kind: 'owned-by-peer', pid },
          'cannot confirm recorded daemon pid ' + String(pid) + ' exited; resolve it manually')
      }
      if (now() >= deadline) {
        throw new LeaseRefusedError({ kind: 'owned-by-peer', pid },
          'recorded daemon pid ' + String(pid) + ' did not stop; resolve it manually')
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }

  /** Build the explicit browser environment: owned home, no ambient variables. */
  private chromeEnv(root: string): Record<string, string> {
    return {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: join(root, 'chrome-home'),
      TMPDIR: join(root, 'tmp'),
      LANG: 'en_US.UTF-8',
    }
  }

  /** Observe the captured daemon only; retirement rejects callbacks from older lifetimes. */
  private watchDaemon(lt: ReadyLifetime, child: ChildProcess): void {
    child.once('exit', () => { this.internalShutdown(lt, 'the owned daemon exited unexpectedly') })
  }

  /** Observe the captured browser without relaunching it after an exit. */
  private watchBrowser(lt: ReadyLifetime, child: ChildProcess): void {
    child.once('exit', () => { this.internalShutdown(lt, 'the owned browser exited unexpectedly') })
  }

  /**
   * Probe our instance on the health interval; healthMissLimit misses close
   * the stack. Every probe runs under the ready lifetime's signal, so a
   * retirement aborts it in flight and the abort never counts as a miss.
   */
  private armHealthLoop(lt: ReadyLifetime): void {
    this.stopHealthLoop()
    this.healthTimer = setInterval(() => {
      void this.healthProbe(lt)
    }, this.config.healthIntervalMs)
    this.healthTimer.unref()
  }

  private stopHealthLoop(): void {
    if (this.healthTimer !== undefined) {
      clearInterval(this.healthTimer)
      this.healthTimer = undefined
    }
  }

  private async healthProbe(lt: ReadyLifetime): Promise<void> {
    if (this.inFlight !== undefined || !this.isCurrent(lt)) return
    const { instanceId, runner } = lt
    const probe = (async () => {
      try {
        // The probe runs under the lifetime's signal: retirement aborts the
        // in-flight poll through the real runner, and the abort is quiet.
        const browsers = await runner.runJson(argv.browsers(), parseBrowsers, undefined, lt.controller.signal)
        // Recheck the captured lifetime after the await: a stale, aborted, or
        // retiring probe never acts, and its outcome is not a health miss.
        if (!this.isCurrent(lt)) return
        const present = browsers.some(entry => entry.instanceId === instanceId && entry.label === BSK_OWNED_LABEL)
        if (present) {
          this.healthMisses = 0
          return
        }
        this.healthMisses += 1
        if (this.healthMisses >= this.config.healthMissLimit) {
          this.logger.warn('browserskill: owned instance missing from daemon status %d times; closing', this.healthMisses)
          this.internalShutdown(lt, 'the owned instance stopped answering health probes')
        }
      } catch {
        // A single failed probe is not a miss; consecutive answered misses drive the limit.
      }
    })()
    this.track(lt, probe)
    await probe
  }

  /** All invocations use the computed owned path and the compiled binary pin, never a receipt. */
  private ensureRunner(root: string): BskRunner {
    this.runner ??= this.internals().runner ?? new BskRunner({
      root,
      config: this.config,
      executablePath: artifactPaths(root).bskExecutable,
      binarySha256: BSK_PLATFORM_PIN.binarySha256,
      updateManifestUrl: this.config.updateManifestUrl?.href,
    })
    return this.runner
  }

  private ensureDaemon(runner: BskRunner): BskDaemonSeam {
    if (this.daemon === undefined) {
      this.daemon = this.internals().daemon ?? new BskDaemon({ runner, config: this.config })
    }
    return this.daemon
  }

  private ensureChrome(): OwnedChromeSeam {
    if (this.chrome === undefined) {
      this.chrome = this.internals().chrome ?? new OwnedChrome({
        onUnverifiedProcesses: (pids) => {
          // Diagnostics only: unmarked or reused group members were left
          // untouched, and this never grants kill authority.
          this.logger.warn('Processes not verified as Shres Chrome were left untouched: %s', pids.join(', '))
        },
      })
    }
    return this.chrome
  }

  /** Run one validated session command against the captured lifetime. */
  private runSessionCommand(
    lt: ReadyLifetime,
    args: readonly string[],
    signal: AbortSignal,
    label: string,
  ): Promise<BrowserSkillCommandResult<BskOutput>> {
    const tracked = (async (): Promise<BrowserSkillCommandResult<BskOutput>> => {
      try {
        const json = await lt.runner.runJson(args, requireJsonObject, undefined, AbortSignal.any([signal, lt.controller.signal]))
        if (!this.isCurrent(lt)) return notReady(this.state)
        return { ok: true, value: { json } }
      } catch (error) {
        return lostCommandOutcome(error, label)
      }
    })()
    this.track(lt, tracked)
    return tracked
  }

  /**
   * The session-start lost-outcome path. The internal shutdown is fired
   * without awaiting it (this tracked work must not self-join its own
   * teardown) and the refusal is returned immediately.
   */
  private lostStartOutcome(error: unknown, lt: ReadyLifetime): BrowserSkillCommandResult<{ session: BskSessionId }> {
    const lostError = error instanceof BskWireError
      || (error instanceof BskCommandError && error.result !== undefined && (error.result.aborted || error.result.timedOut))
      ? error : undefined
    if (lostError !== undefined) {
      const reason = lostError instanceof BskCommandError && lostError.result?.aborted === true ? 'aborted' : 'command-failed'
      this.internalShutdown(lt, 'session start ended with an unknown outcome')
      return {
        ok: false,
        reason,
        detail: `session start outcome unknown (command-lost): ${lostError.message}; the runtime was shut down`,
      }
    }
    return { ok: false, reason: 'command-failed', detail: error instanceof Error ? error.message : String(error) }
  }

  private async stopForeignSession(lt: ReadyLifetime, session: BskSessionId): Promise<void> {
    try {
      await lt.runner.runJson(argv.sessionStop(session), requireJsonObject)
    } catch {
      // The foreign session could not be stopped; the refusal already reports the mismatch.
    }
  }

  private setState(next: BrowserSkillState): void {
    this.state = next
    this.notify()
  }

  /** Dispatch a status snapshot to every subscriber; one bad listener never breaks the rest. */
  private notify(): void {
    const snapshot = this.status()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        this.logger.warn('browserskill: status listener threw: %s', String(error))
      }
    }
  }
}

/** The weak map of package-internal substitutions, keyed by instance. */
const internalsByInstance = new WeakMap<BrowserSkillRuntime, InstanceInternals>()

/** Parse just the status pid for stale-daemon verification. */
function parseStatusPid(raw: unknown): number {
  if (typeof raw !== 'object' || raw === null) throw new BskWireError('status reply is not an object')
  const pid = (raw as Record<string, unknown>).pid
  if (typeof pid !== 'number' || !Number.isInteger(pid)) throw new BskWireError('status pid is not an integer')
  return pid
}

/** Whether the validated JSON value is an object member of the union. */
function isJsonObjectValue(raw: unknown): raw is { [key: string]: JsonValue } {
  return isJsonValue(raw) && typeof raw === 'object' && raw !== null && !Array.isArray(raw)
}

/** A session command reply must be a JSON object to pass through. */
function requireJsonObject(raw: unknown): { [key: string]: JsonValue } {
  if (!isJsonObjectValue(raw)) {
    throw new BskWireError('command reply is not a JSON object')
  }
  return raw
}

function notReady(state: BrowserSkillState): BrowserSkillCommandResult<never> {
  return {
    ok: false,
    reason: 'not-ready',
    detail: `BrowserSkill browser is not ready (state ${state.kind}); open it from Plugins → BrowserSkill`,
  }
}

function unknownSession(): BrowserSkillCommandResult<never> {
  return { ok: false, reason: 'unknown-session', detail: 'no such browser session in this conversation' }
}

function invalidArgument(detail: string): BrowserSkillCommandResult<never> {
  return { ok: false, reason: 'invalid-argument', detail }
}

/** Normalize a non-start command failure: lost outcomes keep the session registered. */
function lostCommandOutcome(error: unknown, label: string): BrowserSkillCommandResult<never> {
  if (error instanceof BskCommandError && error.result !== undefined && error.result.aborted) {
    return { ok: false, reason: 'aborted', detail: `${label} aborted with unknown outcome` }
  }
  if (error instanceof BskCommandError && error.result !== undefined && error.result.timedOut) {
    return { ok: false, reason: 'command-failed', detail: `${label} timed out with unknown outcome` }
  }
  if (error instanceof BskWireError) {
    return { ok: false, reason: 'command-failed', detail: `${label} reply was unreadable; outcome unknown` }
  }
  return { ok: false, reason: 'command-failed', detail: error instanceof Error ? error.message : String(error) }
}

/**
 * Create a runtime with package-internal test substitutions. The published
 * constructor stays the three-field public shape; this factory is the only
 * way to inject fakes and is not re-exported from the package entry.
 * @param options - the public options.
 * @param internals - optional substitutions, merged over the real implementations.
 * @returns the runtime.
 */
export function createBrowserSkillRuntime(
  options: BrowserSkillRuntimeOptions,
  internals: BrowserSkillRuntimeInternals = {},
): BrowserSkillRuntime {
  const runtime = new BrowserSkillRuntime(options)
  internalsByInstance.set(runtime, { ...internalsByInstance.get(runtime) as InstanceInternals, ...internals })
  return runtime
}
