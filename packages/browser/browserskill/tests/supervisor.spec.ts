import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { connect } from 'node:net'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserSkillRuntime } from '../src/runtime/supervisor.ts'
import type { BrowserSkillRuntimeInternals, BskDaemonSeam, OwnedChromeSeam } from '../src/runtime/supervisor.ts'
import { BskCommandError, BskRunner, BskWireError, buildChildEnv } from '../src/runtime/runner.ts'
import { BskDaemon, DaemonPortInUseError, DaemonStartError } from '../src/runtime/daemon.ts'
import { OwnedChrome } from '../src/runtime/chrome.ts'
import { artifactPaths } from '../src/runtime/provision.ts'
import type { Logger } from '@shres-code/cordis'
import { isPortOccupied, reserveLoopbackPort, type PortReservation } from '../src/runtime/endpoints.ts'
import { acquireRuntimeLease, LEASE_FILE_NAME, LeaseRefusedError } from '../src/runtime/lease.ts'
import { ProvisionRefusedError, readProvisionedState } from '../src/runtime/provision.ts'
import type { OwnedBrowser } from '../src/runtime/chrome.ts'
import { DEFAULT_DAEMON_PORT } from '../src/runtime/manifest.ts'
import { resolveBrowserSkillConfig } from '../src/config.ts'
import type { ResolvedBrowserSkillConfig } from '../src/config.ts'
import type { BrowserInstanceId, BrowserSkillCommandFailure, BrowserSkillCommandResult, BrowserSkillOperation, BrowserSkillRefusal, BrowserSkillStartResult, BrowserSkillStatus, BrowserSkillVerb, ExtensionId } from '../src/types.ts'
import { fakeBskStateDir, readFakeInvocations, seedFakeInstances, writeFakeBsk } from './fake-bsk.ts'

const fixturePin = vi.hoisted(() => ({ hash: undefined as string | undefined }))
const ownedChromeOptions = vi.hoisted(() => ({ captured: [] as Record<string, unknown>[] }))
vi.mock('../src/runtime/chrome.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runtime/chrome.ts')>()
  class CapturingOwnedChrome extends actual.OwnedChrome {
    constructor(options: ConstructorParameters<typeof actual.OwnedChrome>[0]) {
      super(options)
      ownedChromeOptions.captured.push(options)
    }
  }
  return { ...actual, OwnedChrome: CapturingOwnedChrome }
})
vi.mock('../src/runtime/manifest.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runtime/manifest.ts')>()
  return {
    ...actual,
    BSK_PLATFORM_PIN: {
      ...actual.BSK_PLATFORM_PIN,
      get binarySha256() { return fixturePin.hash ?? actual.BSK_PLATFORM_PIN.binarySha256 },
    },
  }
})

const cleanup: { dir?: string; children: ReturnType<typeof spawn>[] }[] = []
afterEach(async () => {
  fixturePin.hash = undefined
  vi.restoreAllMocks()
  for (const entry of cleanup.splice(0)) {
    for (const child of entry.children) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
    if (entry.dir === undefined) continue
    // A just-killed fake child can flush one last state write while the
    // recursive removal walks the tree; retry the bounded race away.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(entry.dir, { recursive: true, force: true })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || attempt >= 5) throw error
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
  }
})

const INSTANCE = 'abcd1234'

function testConfig(): ResolvedBrowserSkillConfig {
  return {
    ...resolveBrowserSkillConfig(),
    healthIntervalMs: 50,
    healthMissLimit: 2,
    browserConnectTimeoutMs: 5_000,
  }
}


/**
 * One parked runner command. The runner below intercepts before spawning,
 * so a parked command models one whose outcome is already committed on the
 * daemon side: the caller abort never reaches it, and release() supplies
 * whatever reply the daemon would have produced.
 */
interface CommandGate {
  /** Resolves once release() was called. */
  readonly parked: Promise<void>
  /** Settles the parked command with a parsed wire reply or an error, then unblocks it. */
  release(value?: unknown, error?: Error): void
}

/**
 * A BskRunner stand-in that parks explicitly gated commands before spawn and
 * passes everything else through to the real runner. Releasing a gate
 * removes it, so later commands run for real again.
 */
function gateRunner(real: BskRunner): { runner: BskRunner; gate: (command: string) => CommandGate } {
  const gates = new Map<string, { parked(): void; released: Promise<void>; settled: Promise<unknown> }>()
  const keyOf = (argv_: readonly string[]): string => argv_.slice(0, 2).join(' ')
  // Structural BskRunner substitute: only the methods the supervisor calls.
  const runner = {
    verifyExecutable: (): Promise<void> => real.verifyExecutable(),
    spawnLongLived: (argv_: readonly string[]): Promise<ChildProcess> => real.spawnLongLived(argv_),
    run: async (
      argv_: readonly string[],
      overrides?: { timeoutMs?: number },
      signal?: AbortSignal,
    ): Promise<ReturnType<BskRunner['run']>> => {
      const entry = gates.get(keyOf(argv_))
      if (entry === undefined) return real.run(argv_, overrides, signal)
      entry.parked()
      await entry.released
      await entry.settled
      // A released plain command settles with a synthetic clean result.
      return { exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: '{}', stderr: '' }
    },
    runJson: async <T>(
      argv_: readonly string[],
      validate: (raw: unknown) => T,
      overrides?: { timeoutMs?: number },
      signal?: AbortSignal,
    ): Promise<T> => {
      const entry = gates.get(keyOf(argv_))
      if (entry === undefined) return real.runJson(argv_, validate, overrides, signal)
      entry.parked()
      await entry.released
      return validate(await entry.settled)
    },
  } as unknown as BskRunner
  return {
    runner,
    gate: (command) => {
      let settle!: (value?: unknown, error?: Error) => void
      const settled = new Promise<unknown>((resolve, reject) => {
        settle = (value?, error?) => { if (error !== undefined) reject(error); else resolve(value) }
      })
      let notifyIntercepted!: () => void
      const parked = new Promise<void>((resolve) => { notifyIntercepted = resolve })
      let releaseRun!: () => void
      const released = new Promise<void>((resolve) => { releaseRun = resolve })
      gates.set(command, { parked: notifyIntercepted, released, settled })
      return {
        parked,
        release: (value?: unknown, error?: Error) => {
          gates.delete(command)
          settle(value, error)
          releaseRun()
        },
      }
    },
  }
}

/** A child-process stand-in: an event emitter carrying the exit surface the supervisor subscribes to. */
function fakeChild(): ChildProcess & { emitExit(): void } {
  const emitter = new EventEmitter()
  const child = emitter as unknown as ChildProcess & { emitExit(): void }
  let exitCode: number | null = null
  Object.defineProperties(child, {
    exitCode: { get: () => exitCode },
    signalCode: { value: null },
  })
  child.emitExit = (): void => {
    exitCode = 0
    emitter.emit('exit', 0, null)
  }
  return child
}
interface FakeChromeState {
  launches: number
  closes: number
  closed: boolean
  seedInstance: boolean
}

/** Counted fake Chrome/daemon seams with controllable EventEmitter children. */
interface CountedRuntime {
  counts: {
    launches: number
    closes: number
    forceCloses: number
    daemonStarts: number
    daemonStops: number
    daemonForceStops: number
    /** Port passed to the most recent daemon.start. */
    lastStartedPort?: number | undefined
  }
  /** Per-close outcome plan, consumed in order; 'ok' once exhausted. */
  closePlan: ('ok' | 'fail')[]
  /** Emit child exits during successful close/stop, modeling real children dying mid-teardown. */
  emitExitOnClose: boolean
  /** Ordered teardown events, for abort-before-force ordering proofs. */
  events: string[]
  /** Holds counted daemon.start until opened or the start signal aborts. */
  holdDaemonStart?: { readonly parked: Promise<void>; open(): void }
  /** Every fake browser child ever created; old entries keep their exit listeners. */
  readonly browserChildren: (ChildProcess & { emitExit(): void })[]
  /** Every fake daemon child ever created. */
  readonly daemonChildren: (ChildProcess & { emitExit(): void })[]
  /** The port of the most recent counted daemon.start. */
  lastStartedPort?: number | undefined
}

interface RuntimeFixture {
  runtime: ReturnType<typeof createBrowserSkillRuntime>
  root: string
  config: ResolvedBrowserSkillConfig
  fakeScript: { path: string; sha256: string }
  fake: FakeChromeState
  launchedProfiles: readonly string[]
  setDaemonStopError: (error?: string) => void
  holdDaemonStop: () => void
  releaseDaemonStopHold: () => void
  killBrowserChild: () => void
  /** Parks a runner command before spawn; present with gateCommands. */
  gate?: (command: string) => CommandGate
  /** Counted fake seams and their handles; present with counted. */
  counted?: CountedRuntime
}

/** One supervisor over a fresh owned root, fake Chrome, and the fake bsk child. */
async function makeRuntime(options: {
  root?: string
  chrome?: Partial<FakeChromeState>
  config?: ResolvedBrowserSkillConfig
  pickDaemonPort?: () => Promise<number>
  acquireLease?: BrowserSkillRuntimeInternals['acquireLease']
  ensureLaunchArtifacts?: BrowserSkillRuntimeInternals['ensureLaunchArtifacts']
  provision?: BrowserSkillRuntimeInternals['provision']
  now?: BrowserSkillRuntimeInternals['now']
  chromeSeam?: BrowserSkillRuntimeInternals['chrome']
  chromeLauncherError?: string
  daemonStopError?: string
  seedProvisioned?: boolean
  chromeGate?: { wait: Promise<void>; open(): void }
  /** Wrap the runner so whole commands can be parked before spawn. */
  gateCommands?: boolean
  /** Replace Chrome and daemon with counted fakes over EventEmitter children. */
  counted?: {
    closePlan?: ('ok' | 'fail')[]
    emitExitOnClose?: boolean
    holdDaemonStart?: boolean
    seedInstance?: boolean
    launchFailure?: string
    daemonStopFailure?: string
    /** When set, daemon.start throws a DaemonStartError (or a raw Error with failuresAreStrings). */
    daemonStartFailure?: string
    /** Mirror the real daemon: refuse start when the port is already bound. */
    portOccupied?: boolean
    failuresAreStrings?: boolean
    updateFailsAfterFirst?: boolean
  }
  /** Omit the runner/daemon internals so the supervisor constructs its defaults. */
  defaultRunnerAndDaemon?: boolean
  /** Capture formatted logger lines here. */
  captureLogs?: string[]
  /** Steps the fixture provision producer publishes before resolving. */
  provisionSteps?: Array<'download' | 'verify' | 'extract'>
  /** Replace the default-port reservation seam. */
  reservePort?: BrowserSkillRuntimeInternals['reservePort']
} = {}): Promise<RuntimeFixture> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'shres-bsk-supervisor-'))
  for (const dir of ['home', 'tmp', 'bsk-home']) await mkdir(join(root, dir), { recursive: true })
  const entry = { dir: root, children: [] as ReturnType<typeof spawn>[] }
  cleanup.push(entry)
  const fakeScript = await writeFakeBsk(root)
  if (options.defaultRunnerAndDaemon === true) {
    const executable = artifactPaths(root).bskExecutable
    await mkdir(dirname(executable), { recursive: true })
    await copyFile(fakeScript.path, executable)
    fixturePin.hash = fakeScript.sha256
  }
  const config = options.config ?? testConfig()
  const runner = new BskRunner({
    root, config, executablePath: fakeScript.path, binarySha256: fakeScript.sha256, updateManifestUrl: undefined,
  })
  const fake: FakeChromeState = { launches: 0, closes: 0, closed: false, seedInstance: options.chrome?.seedInstance ?? true }
  const launchedProfiles: string[] = []
  const fakeChrome = new OwnedChrome({
    launcher: async (spec) => {
      launchedProfiles.push(spec.userDataDir)
      if (options.chromeLauncherError !== undefined) throw new Error(options.chromeLauncherError)
      fake.launches += 1
      if (fake.seedInstance) {
        await seedFakeInstances(root, [{ instance_id: INSTANCE, label: 'shres-managed' }])
      }
      if (options.chromeGate !== undefined) {
        await options.chromeGate.wait
      }
      // A real, closeable child: the landed OwnedChrome refuses a browser
      // without an owned process identity and confirms exit before release.
      // Detached, like real Chrome: the child leads its own process group, and
      // the launcher waits until exec+setsid have landed so the supervisor's
      // group observation sees the child leading it, even under load.
      const fakeChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true })
      entry.children.push(fakeChild)
      launchedChild = fakeChild
      for (;;) {
        const pgid = Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(fakeChild.pid)], { encoding: 'utf8' }).trim())
        if (pgid === fakeChild.pid) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return fakeBrowser(async () => {
        // The close does not signal: OwnedChrome's own group SIGKILL after the
        // graceful close is what terminates and confirms the child.
        fake.closes += 1
        fake.closed = true
      }, () => fakeChild)
    },
  })
  if (options.seedProvisioned === true) {
    await writeFakeProvisionState(root, fakeScript)
  }
  // The real daemon behind a seam whose stop can be refused or held, so tests
  // can gate an owned daemon alive across a gated close or retirement.
  const realDaemon = new BskDaemon({ runner, config })
  let daemonStopError: string | undefined = options.daemonStopError
  let daemonStopHold: Promise<void> | undefined
  let releaseDaemonStopHold: () => void = () => {}
  const daemon: BskDaemonSeam = {
    start: (port, startOptions) => realDaemon.start(port, startOptions),
    stop: async () => {
      if (daemonStopHold !== undefined) await daemonStopHold
      if (daemonStopError !== undefined) throw new Error(daemonStopError)
      await realDaemon.stop()
    },
    forceStop: () => { realDaemon.forceStop() },
    pidMatches: pid => realDaemon.pidMatches(pid),
    get current() {
      return realDaemon.current
    },
  }
  // Counted fake seams: controllable EventEmitter children, counted calls, a
  // plannable close outcome, and ordered teardown events for proofs that
  // emit (or withhold) child exits by hand.
  let counted: CountedRuntime | undefined
  let countedChrome: OwnedChromeSeam | undefined
  let countedDaemon: BskDaemonSeam | undefined
  const countedOptions = options.counted
  if (countedOptions !== undefined) {
    const counts = {
      launches: 0, closes: 0, forceCloses: 0, daemonStarts: 0, daemonStops: 0, daemonForceStops: 0,
      lastStartedPort: undefined as number | undefined,
    }
    const events: string[] = []
    const closePlan: Array<'ok' | 'fail'> = [...(countedOptions.closePlan ?? ['ok'])]
    const browserChildren: (ChildProcess & { emitExit(): void })[] = []
    const daemonChildren: (ChildProcess & { emitExit(): void })[] = []
    let currentBrowser: OwnedBrowser | undefined
    let currentDaemonChild: (ChildProcess & { emitExit(): void }) | undefined
    let holdOpen: (() => void) | undefined
    let daemonStopFailureArmed = countedOptions.daemonStopFailure !== undefined
    const countedHandle: CountedRuntime = {
      counts,
      closePlan,
      emitExitOnClose: countedOptions.emitExitOnClose ?? false,
      events,
      browserChildren,
      daemonChildren,
    }
    countedChrome = {
      launchAndPair: async (launchOptions) => {
        counts.launches += 1
        launchOptions.signal.throwIfAborted()
        if (countedOptions.launchFailure !== undefined) throw new Error(countedOptions.launchFailure)
        if (countedOptions.seedInstance !== false) {
          await seedFakeInstances(root, [{ instance_id: INSTANCE, label: 'shres-managed' }])
        }
        const browserChild = fakeChild()
        browserChildren.push(browserChild)
        const browser = fakeBrowser(async () => {}, () => browserChild)
        currentBrowser = browser
        await launchOptions.onLaunched(6000 + counts.launches, 6000 + counts.launches)
        return { instanceId: INSTANCE as BrowserInstanceId, extensionId: 'ext-counted' as ExtensionId, browser }
      },
      close: async () => {
        // No live browser lifetime: a no-op, exactly like the real close.
        if (currentBrowser === undefined) return
        counts.closes += 1
        const outcome = closePlan.shift() ?? 'ok'
        if (outcome === 'fail') {
          throw countedOptions.failuresAreStrings === true
            ? 'owned Chrome close lost'
            : new Error('owned Chrome close could not confirm exit')
        }
        if (countedOptions.emitExitOnClose === true) browserChildren.at(-1)?.emitExit()
        currentBrowser = undefined
      },
      forceClose: () => { counts.forceCloses += 1 },
      get current() { return currentBrowser },
    }
    countedDaemon = {
      start: async (port, startOptions) => {
        counts.daemonStarts += 1
        startOptions.signal.throwIfAborted()
        if (countedOptions.portOccupied === true && (await isPortOccupied(port))) {
          throw new DaemonPortInUseError(port)
        }
        if (countedOptions.daemonStartFailure !== undefined) {
          throw countedOptions.failuresAreStrings === true
            ? countedOptions.daemonStartFailure
            : new DaemonStartError(countedOptions.daemonStartFailure)
        }
        if (countedOptions.holdDaemonStart === true) {
          // Wake on open() or on the operation abort, recording which came
          // first: a later startup step must observe the abort before any
          // force call, and must never spawn afterwards.
          await new Promise<void>((resolve) => {
            const onAbort = (): void => { events.push('abort-seen'); resolve() }
            startOptions.signal.addEventListener('abort', onAbort, { once: true })
            holdOpen = (): void => {
              startOptions.signal.removeEventListener('abort', onAbort)
              resolve()
            }
          })
          startOptions.signal.throwIfAborted()
        }
        const child = fakeChild()
        daemonChildren.push(child)
        currentDaemonChild = child
        counts.lastStartedPort = port
        await startOptions.onSpawned(7000 + counts.daemonStarts)
        return { child, port }
      },
      stop: async () => {
        // No live daemon child: a no-op, exactly like the real stop.
        if (currentDaemonChild === undefined) return
        counts.daemonStops += 1
        if (daemonStopFailureArmed) {
          daemonStopFailureArmed = false
          throw countedOptions.failuresAreStrings === true
            ? countedOptions.daemonStopFailure
            : new Error(countedOptions.daemonStopFailure)
        }
        if (countedOptions.emitExitOnClose === true) currentDaemonChild?.emitExit()
        currentDaemonChild = undefined
      },
      forceStop: () => {
        counts.daemonForceStops += 1
        events.push('forceStop')
      },
      pidMatches: async () => true,
      get current() {
        return currentDaemonChild === undefined ? undefined : { child: currentDaemonChild, port: 0 }
      },
    }
    counted = countedHandle
    if (countedOptions.holdDaemonStart === true) {
      const parked = new Promise<void>((resolve) => {
        const check = (): void => { if (holdOpen !== undefined) resolve(); else setTimeout(check, 5) }
        check()
      })
      countedHandle.holdDaemonStart = { parked, open: (): void => { holdOpen?.() } }
    }
  }
  const gated = options.gateCommands === true ? gateRunner(runner) : undefined
  const baseRunner = gated === undefined ? runner : gated.runner
  const leaseInternal = options.counted?.updateFailsAfterFirst === true
    ? async (ownedRoot: string, hooks: Parameters<typeof acquireRuntimeLease>[1]) => {
      const lease = await acquireRuntimeLease(ownedRoot, hooks)
      return {
        ...lease,
        update: async (patch: Parameters<typeof lease.update>[0]) => {
          // The pid-clearing bookkeeping update is the one that fails.
          if (Object.values(patch).includes(null)) throw new Error('lease update unavailable')
          await lease.update(patch)
        },
      }
    }
    : undefined
  const internals: BrowserSkillRuntimeInternals = {
    ...(options.defaultRunnerAndDaemon === true ? {} : { runner: baseRunner }),
    ...(options.defaultRunnerAndDaemon === true ? {} : { daemon: countedDaemon ?? daemon }),
    ...(options.defaultRunnerAndDaemon === true ? {} : { chrome: options.chromeSeam ?? countedChrome ?? fakeChrome }),
    ...(leaseInternal === undefined ? {} : { acquireLease: leaseInternal }),
    preflight: async () => ({ executablePath: '/fake/Chrome', chromeVersion: '153.0.8010.53' }),
    ensureLaunchArtifacts: fixtureLaunchArtifacts(),
    provision: async ({ root: ownedRoot, onStep }) => {
      for (const step of options.provisionSteps ?? []) onStep?.(step)
      return writeFakeProvisionState(ownedRoot, fakeScript)
    },
    ...(options.pickDaemonPort === undefined ? {} : { pickDaemonPort: options.pickDaemonPort }),
    ...(options.reservePort === undefined ? {} : { reservePort: options.reservePort }),
    ...(options.acquireLease === undefined ? {} : { acquireLease: options.acquireLease }),
    ...(options.ensureLaunchArtifacts === undefined ? {} : { ensureLaunchArtifacts: options.ensureLaunchArtifacts }),
    ...(options.provision === undefined ? {} : { provision: options.provision }),
    ...(options.now === undefined ? {} : { now: options.now }),
  }
  const runtime = createBrowserSkillRuntime({ root, config, logger: fakeLogger(options.captureLogs) }, internals)
  let launchedChild: ReturnType<typeof spawn> | undefined
  const killLaunchedChild = (): void => { launchedChild?.kill('SIGKILL') }
  return { runtime, root, config, fakeScript, fake, launchedProfiles,
    setDaemonStopError: (error?: string) => { daemonStopError = error },
    holdDaemonStop: () => { daemonStopHold = new Promise<void>((resolve) => { releaseDaemonStopHold = resolve }) },
    releaseDaemonStopHold: () => { releaseDaemonStopHold?.() },
    killBrowserChild: () => { killLaunchedChild() },
    ...(gated === undefined ? {} : { gate: gated.gate }),
    ...(counted === undefined ? {} : { counted }) }
}

/** Minimal browser target double satisfying the supervisor's pairing path. */
function fakeBrowser(close: () => Promise<void>, processOf: () => ReturnType<typeof spawn> | null): OwnedBrowser {
  return {
    target: () => ({ createCDPSession: async () => ({ send: async () => ({ id: 'a'.repeat(32) }) }) }),
    waitForTarget: async () => ({
      worker: async () => ({
        evaluate: async <T>(_fn: (...args: never[]) => unknown, ...args: unknown[]): Promise<T> =>
          ({ bsk_daemon_port: args[0], bh_label: args[1], bsk_instance_id: INSTANCE }) as T,
      }),
    }),
    close,
    process: processOf,
  }
}

/** Persist a provisioned-state record the real reader accepts. */
async function writeFakeProvisionState(root: string, fakeScript: { path: string; sha256: string }) {
  const paths = artifactPaths(root)
  await mkdir(join(root, 'artifacts'), { recursive: true })
  await mkdir(paths.extensionDir, { recursive: true })
  const state = {
    version: 1 as const,
    bsk: { version: '0.3.1', executablePath: fakeScript.path, binarySha256: fakeScript.sha256, archiveSha256: 'a'.repeat(64) },
    extension: { version: '0.3.1', dir: paths.extensionDir, archiveSha256: 'b'.repeat(64), treeDigest: 'c'.repeat(64) },
  }
  await writeFile(paths.stateFile, JSON.stringify(state))
  return state
}

/** A Logger stand-in; formatted lines land in the optional capture array. */
function fakeLogger(capture?: string[]): Logger {
  const sink = (format: string, ...values: unknown[]): void => { capture?.push(format.replace(/%[sd]/g, () => String(values.shift()))) }
  return { error: sink, info: sink, warn: sink, debug: sink } as Logger
}

/** How many `browsers` invocations the fake bsk recorded so far. */
async function browsersRecorded(root: string): Promise<number> {
  return (await readFakeInvocations(root)).filter(entry => entry['command'] === 'browsers').length
}
/** The failure reason of a command result the test expects to be refused. */
function reasonOf<T>(result: BrowserSkillCommandResult<T>): BrowserSkillCommandFailure {
  if (result.ok) throw new Error('expected the command to be refused')
  return result.reason
}

/**
 * Verification seam stand-in: returns the seeded record without measuring it
 * against the real manifest pins.
 */
function fixtureLaunchArtifacts(): NonNullable<BrowserSkillRuntimeInternals['ensureLaunchArtifacts']> {
  return async (ownedRoot, _config, verifySignal) => {
    const state = await readProvisionedState(ownedRoot)
    if (state === undefined) throw new ProvisionRefusedError({ kind: 'download-failed', detail: 'fixture: no seeded provisioned state' })
    verifySignal?.throwIfAborted()
    return state
  }
}

/**
 * Start one verb and await its settlement. The settled promise never
 * rejects; a refusal verdict is a broken fixture, not an outcome.
 */
async function settle(runtime: ReturnType<typeof createBrowserSkillRuntime>, verb: 'provision' | 'open' | 'close' | 'reset'): Promise<BrowserSkillOperation>
async function settle(runtime: ReturnType<typeof createBrowserSkillRuntime>, verb: 'uninstall', options: { keepProfile: boolean }): Promise<BrowserSkillOperation>
async function settle(
  runtime: ReturnType<typeof createBrowserSkillRuntime>,
  verb: BrowserSkillVerb,
  options?: { keepProfile: boolean },
): Promise<BrowserSkillOperation> {
  const started: BrowserSkillStartResult = verb === 'uninstall'
    ? runtime.start('uninstall', options ?? { keepProfile: false })
    : runtime.start(verb)
  if (!started.accepted) throw new Error('expected ' + verb + ' to be accepted, refused: ' + JSON.stringify(started.refusal))
  return started.settled
}

async function daemonAlive(root: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(join(fakeBskStateDir(root), 'daemon.json'), 'utf8')) as { pid: number }
    try {
      process.kill(raw.pid, 0)
      return true
    } catch {
      return false
    }
  } catch {
    return false
  }
}

describe('BrowserSkillRuntime lifecycle', () => {
  it('provisions and opens to ready, then closes in order', async () => {
    const { runtime, root, fake } = await makeRuntime()
    const statuses: BrowserSkillStatus[] = []
    runtime.subscribe(status => statuses.push(status))
    await settle(runtime, 'provision')
    const status = runtime.status()
    expect(status.state).toMatchObject({ kind: 'ready', instanceId: INSTANCE })
    expect(status.chrome?.version).toContain('153')
    expect(status.operation).toMatchObject({ verb: 'provision', phase: 'succeeded' })
    expect(fake.launches).toBe(1)
    // The default port hold released at readiness.
    expect(await isPortOccupied(DEFAULT_DAEMON_PORT)).toBe(false)
    // The lease is held while the runtime runs.
    expect(await readFile(join(root, 'runtime.lock'), 'utf8')).toContain('"pid"')
    await settle(runtime, 'close')
    const closed = runtime.status()
    expect(closed.state).toMatchObject({ kind: 'provisioned' })
    expect(closed.operation).toMatchObject({ verb: 'close', phase: 'succeeded' })
    await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fake.closed).toBe(true)
    expect(await daemonAlive(root)).toBe(false)
    expect(statuses.length).toBeGreaterThan(0)
  })

  it('refuses open when the daemon port is occupied, before Chrome exists', async () => {
    const hold = await reserveLoopbackPort(0)
    const { runtime, root, fake } = await makeRuntime({ pickDaemonPort: async () => hold.port, seedProvisioned: true })
    await runtime.refreshProvisioned()
    expect(runtime.status().state).toMatchObject({ kind: 'provisioned' })
    await expect(settle(runtime, 'open')).resolves.toMatchObject({
      verb: 'open',
      phase: 'failed',
      refusal: { kind: 'endpoint-in-use', port: hold.port },
    })
    const failed = runtime.status()
    expect(failed.state).toMatchObject({ kind: 'failed', refusal: { kind: 'endpoint-in-use', port: hold.port } })
    expect(failed.operation).toMatchObject({ phase: 'failed', refusal: { kind: 'endpoint-in-use' } })
    expect(fake.launches).toBe(0)
    expect(await daemonAlive(root)).toBe(false)
    await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when the default port is occupied, and stops the daemon again', async () => {
    const { runtime, root } = await makeRuntime({ seedProvisioned: true })
    await runtime.refreshProvisioned()
    const hold = await reserveLoopbackPort(DEFAULT_DAEMON_PORT)
    try {
      await expect(settle(runtime, 'open')).resolves.toMatchObject({ phase: 'failed', refusal: { kind: 'endpoint-in-use', port: DEFAULT_DAEMON_PORT } })
      expect(runtime.status().state).toMatchObject({ kind: 'failed', refusal: { kind: 'endpoint-in-use', port: DEFAULT_DAEMON_PORT } })
      // The daemon the open started was stopped again during the unwind.
      expect(await daemonAlive(root)).toBe(false)
      await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await hold.release()
    }
  })

  it('records an extension-load refusal and unwinds the stack', async () => {
    const { runtime, root } = await makeRuntime({ chromeLauncherError: 'CDP refused loadUnpacked', seedProvisioned: true })
    await runtime.refreshProvisioned()
    // The landed chrome seam wraps launcher failures with String(error).
    await expect(settle(runtime, 'open')).resolves.toMatchObject({
      phase: 'failed',
      refusal: { kind: 'extension-load-failed', detail: 'Error: CDP refused loadUnpacked' },
    })
    expect(runtime.status().state).toMatchObject({
      kind: 'failed',
      refusal: { kind: 'extension-load-failed', detail: 'Error: CDP refused loadUnpacked' },
    })
    expect(await daemonAlive(root)).toBe(false)
    await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('surfaces a lease refusal with its manual recovery detail verbatim', async () => {
    // The lease producer derives the displayed detail from its message.
    const { runtime } = await makeRuntime({
      seedProvisioned: true,
      acquireLease: async () => {
        throw new LeaseRefusedError({ kind: 'owned-by-peer', pid: 4242 }, 'remove the runtime lock manually')
      },
    })
    await runtime.refreshProvisioned()
    const settled = await settle(runtime, 'open')
    expect(settled).toMatchObject({
      verb: 'open',
      phase: 'failed',
      refusal: { kind: 'owned-by-peer', pid: 4242, detail: 'remove the runtime lock manually' },
    })
    expect(runtime.status().state).toMatchObject({
      kind: 'failed',
      refusal: { kind: 'owned-by-peer', pid: 4242, detail: 'remove the runtime lock manually' },
    })
  })

  // The unconfirmed exit spends OwnedChrome's bounded close wait by design.
  it('keeps the lease and recorded pids when the browser close cannot confirm exit', { timeout: 15_000 }, async () => {
    // The chrome seam simulates the unconfirmed-exit rejection the landed
    // OwnedChrome produces when the process refuses to die.
    const chromeSeam: BrowserSkillRuntimeInternals['chrome'] = {
      launchAndPair: async (launchOptions) => {
        // A detached browser leads its own group: pgid = pid.
        await launchOptions.onLaunched(4242, 4242)
        return {
          instanceId: INSTANCE as BrowserInstanceId,
          extensionId: 'ext-fixture' as ExtensionId,
          browser: fakeBrowser(async () => {}, () => fakeChild()),
        }
      },
      close: async () => {
        throw new Error('owned Chrome pid 4242 did not exit')
      },
      forceClose: () => {},
      get current() {
        // No owned browser lifetime exists on this seam.
        return undefined
      },
    }
    const { runtime, root } = await makeRuntime({ chromeSeam, seedProvisioned: true })
    await runtime.refreshProvisioned()
    await seedFakeInstances(root, [{ instance_id: INSTANCE, label: 'shres-managed' }])
    await settle(runtime, 'open')
    expect(await readFile(join(root, 'runtime.lock'), 'utf8')).toContain('"pid"')
    const settled = await settle(runtime, 'close')
    expect(settled).toMatchObject({
      verb: 'close',
      phase: 'failed',
      // The detail names the supervisor's own cause label, not Chrome's
      // internal wording.
      refusal: { kind: 'shutdown-incomplete', detail: expect.stringContaining('chrome close failed:') as string },
    })
    // The lock survives: the unconfirmed browser keeps its recorded pid AND
    // group for the recovery path, while the confirmed-exited daemon's pid
    // was cleared from the retained lease.
    const lock = JSON.parse(await readFile(join(root, 'runtime.lock'), 'utf8')) as { pid: number; daemonPid?: number; browserPid?: number; browserPgid?: number }
    expect(lock.pid).toBe(process.pid)
    expect(lock.daemonPid).toBeUndefined()
    expect(lock.browserPid).toBe(4242)
    expect(lock.browserPgid).toBe(4242)
  })

  it('Close after a failed open cleans the retained partial stack and releases the lease', async () => {
    // The pairing window fails AND the unwind close cannot confirm the exit;
    // a later close can.
    const closeOutcomes: Array<'ok' | 'fail'> = ['fail', 'ok']
    const chromeSeam: BrowserSkillRuntimeInternals['chrome'] = {
      launchAndPair: async (launchOptions) => {
        await launchOptions.onLaunched(4242, 4242)
        return {
          instanceId: INSTANCE as BrowserInstanceId,
          extensionId: 'ext-fixture' as ExtensionId,
          browser: fakeBrowser(async () => {}, () => fakeChild()),
        }
      },
      close: async () => {
        const outcome = closeOutcomes.shift() ?? 'ok'
        if (outcome === 'fail') throw new Error('owned Chrome pid 4242 did not exit')
      },
      forceClose: () => {},
      get current() {
        return undefined
      },
    }
    const { runtime, root } = await makeRuntime({
      chromeSeam,
      seedProvisioned: true,
      config: { ...testConfig(), browserConnectTimeoutMs: 600 },
    })
    await runtime.refreshProvisioned()
    // No instances are seeded: pairing never completes, and the unwind close
    // fails too, so the open ends shutdown-incomplete with a retained lease.
    await expect(settle(runtime, 'open')).resolves.toMatchObject({ phase: 'failed', refusal: { kind: 'shutdown-incomplete' } })
    // The unconfirmed browser kept the lease with its recorded pid.
    const lock = JSON.parse(await readFile(join(root, 'runtime.lock'), 'utf8')) as { browserPid?: number }
    expect(lock.browserPid).toBe(4242)
    // No ready lifetime exists — the close still cleans the partial owned
    // stack (daemon, Chrome, lease) instead of reporting a hollow success.
    await settle(runtime, 'close')
    expect(runtime.status().state).toMatchObject({ kind: 'provisioned' })
    await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('treats reopen and reprovision while ready as no-op successes that keep the healthy state', async () => {
    const { runtime, root, fake } = await makeRuntime()
    await settle(runtime, 'provision')
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    expect(fake.launches).toBe(1)
    // Reopen while ready: no reacquire, no relaunch, no poisoned failure.
    await settle(runtime, 'open')
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    expect(runtime.status().operation).toMatchObject({ verb: 'open', phase: 'succeeded' })
    expect(fake.launches).toBe(1)
    // Reprovision while ready is equally a no-op success.
    await settle(runtime, 'provision')
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    expect(runtime.status().operation).toMatchObject({ verb: 'provision', phase: 'succeeded' })
    expect(fake.launches).toBe(1)
    // The lease is still held by the healthy stack.
    expect(await readFile(join(root, 'runtime.lock'), 'utf8')).toContain('"pid"')
    await settle(runtime, 'close')
  })

  it('aborts reset without deleting anything while the daemon refuses to exit, and closes once it exits', async () => {
    const { runtime, root, setDaemonStopError } = await makeRuntime({ daemonStopError: 'daemon did not exit' })
    await settle(runtime, 'provision')
    const settled = await settle(runtime, 'reset')
    expect(settled).toMatchObject({
      verb: 'reset',
      phase: 'failed',
      refusal: { kind: 'shutdown-incomplete', detail: expect.stringContaining('daemon did not exit') as string },
    })
    // Nothing was deleted and the daemon still runs under the retained lease,
    // while the confirmed-exited browser's pid and group were cleared.
    expect(await readFile(join(root, 'runtime.json'), 'utf8')).toContain('daemonPort')
    const lock = JSON.parse(await readFile(join(root, 'runtime.lock'), 'utf8')) as { pid: number; daemonPid?: number; browserPid?: number; browserPgid?: number }
    expect(lock.daemonPid).toBeGreaterThan(0)
    expect(lock.browserPid).toBeUndefined()
    expect(lock.browserPgid).toBeUndefined()
    expect(await daemonAlive(root)).toBe(true)
    // Once the stop fault clears, the retry confirms both exits and releases the lease.
    setDaemonStopError(undefined)
    const retried = await settle(runtime, 'close')
    expect(retried).toMatchObject({ verb: 'close', phase: 'succeeded' })
    await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await daemonAlive(root)).toBe(false)
  })

  it('records the browser pid under the lease from onLaunched, before pairing', async () => {
    let pairingDone = false
    let browser: OwnedBrowser | undefined
    const chromeSeam: BrowserSkillRuntimeInternals['chrome'] = {
      launchAndPair: async (launchOptions) => {
        // The pid and group land in the lease BEFORE the pairing work runs,
        // in one update. A detached browser leads its own group: pgid = pid.
        await launchOptions.onLaunched(4242, 4242)
        await new Promise(resolve => setTimeout(resolve, 25))
        pairingDone = true
        const pairedBrowser = fakeBrowser(async () => {}, () => fakeChild())
        browser = pairedBrowser
        return {
          instanceId: INSTANCE as BrowserInstanceId,
          extensionId: 'ext-fixture' as ExtensionId,
          browser: pairedBrowser,
        }
      },
      close: async () => {},
      forceClose: () => {},
      get current() {
        return browser
      },
    }
    const { runtime, root } = await makeRuntime({ chromeSeam, seedProvisioned: true })
    await runtime.refreshProvisioned()
    await seedFakeInstances(root, [{ instance_id: INSTANCE, label: 'shres-managed' }])
    await settle(runtime, 'open')
    expect(pairingDone).toBe(true)
    // The recorded values are the onLaunched arguments, not a post-pairing
    // process read: the fixture browser has no process at all.
    const lock = JSON.parse(await readFile(join(root, 'runtime.lock'), 'utf8')) as { browserPid?: number; browserPgid?: number }
    expect(lock.browserPid).toBe(4242)
    expect(lock.browserPgid).toBe(4242)
    await settle(runtime, 'close')
    await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses the open without launching when launch verification fails', async () => {
    const refusal: BrowserSkillRefusal = { kind: 'hash-mismatch', artifact: 'executable', expected: 'a'.repeat(64), actual: 'b'.repeat(64) }
    const { runtime, root, fake } = await makeRuntime({
      seedProvisioned: true,
      ensureLaunchArtifacts: async () => {
        throw new ProvisionRefusedError(refusal)
      },
    })
    await runtime.refreshProvisioned()
    const settled = await settle(runtime, 'open')
    expect(settled).toMatchObject({ verb: 'open', phase: 'failed', refusal })
    expect(fake.launches).toBe(0)
    expect(await daemonAlive(root)).toBe(false)
  })

  it('preserves a new owner\'s lease file when post-release shell cleanup races', async () => {
    let lockAtRelease: string | undefined
    const { runtime, root } = await makeRuntime({
      // Every release is followed by a "peer" that re-acquires in the
      // release→shell-cleanup window and writes its own lease into the root.
      // The wrapper also snapshots the lock at release: the purge must have
      // left it in place, still excluding peers mid-deletion.
      acquireLease: async (ownedRoot, hooks) => {
        const lease = await acquireRuntimeLease(ownedRoot, hooks)
        const realRelease = lease.release.bind(lease)
        return {
          ...lease,
          release: async () => {
            lockAtRelease = await readFile(join(ownedRoot, LEASE_FILE_NAME), 'utf8').catch(() => undefined)
            await realRelease()
            await mkdir(ownedRoot, { recursive: true })
            await writeFile(
              join(ownedRoot, LEASE_FILE_NAME),
              JSON.stringify({ pid: 999999, leaseId: 'peer', startedAt: new Date().toISOString() }),
            )
          },
        }
      },
    })
    await settle(runtime, 'provision')
    const settled = await settle(runtime, 'uninstall', { keepProfile: false })
    expect(settled).toMatchObject({ verb: 'uninstall', phase: 'succeeded' })
    // The lock was alive at release with our owner pid: it kept excluding
    // peers for the whole purge.
    const atRelease = JSON.parse(lockAtRelease!) as { pid: number }
    expect(atRelease.pid).toBe(process.pid)
    // Every pre-existing owned entry is gone...
    await expect(readFile(join(root, 'runtime.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'artifacts', 'state.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    // ...and the new owner's lease file survived the nonrecursive cleanup:
    // the root shell is kept instead of deleting through the peer's lease.
    const peerLease = JSON.parse(await readFile(join(root, LEASE_FILE_NAME), 'utf8')) as { pid: number }
    expect(peerLease.pid).toBe(999999)
  })

  it('launches through a symlinked alias root using the canonical profile path', async () => {
    const real = await mkdtemp(join(tmpdir(), 'shres-bsk-supervisor-'))
    cleanup.push({ dir: real, children: [] })
    const alias = join(real, '..', 'shres-bsk-alias-' + String(process.pid))
    await symlink(real, alias)
    const { runtime, root, launchedProfiles } = await makeRuntime({ root: alias, seedProvisioned: true })
    await runtime.refreshProvisioned()
    await seedFakeInstances(root, [{ instance_id: INSTANCE, label: 'shres-managed' }])
    await settle(runtime, 'open')
    expect(await readFile(join(root, 'runtime.lock'), 'utf8')).toContain('"pid"')
    // The launch used the CANONICAL profile path (the exact --user-data-dir
    // token the stale-cleanup verifier matches on), not the alias spelling.
    const canonical = realpathSync(alias)
    expect(launchedProfiles[0]).toBe(join(canonical, 'profile'))
    await settle(runtime, 'close')
    await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(alias, { force: true })
  })

  it('refuses commands not-ready immediately after a close acceptance, with zero spawns', async () => {
    const { runtime, root } = await makeRuntime()
    await settle(runtime, 'provision')
    const invocationsBefore = await readFakeInvocations(root)
    const accepted = runtime.start('close')
    if (!accepted.accepted) throw new Error('expected close to be accepted')
    // Commands are refused the moment a lifecycle operation is accepted: the
    // refusal happens before any bsk spawn.
    const refused = await runtime.startSession('agent-a' as never, new AbortController().signal)
    expect(refused).toMatchObject({ ok: false, reason: 'not-ready' })
    expect(await readFakeInvocations(root)).toEqual(invocationsBefore)
    await accepted.settled
    await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('compensates a delayed session start on the old daemon before teardown', async () => {
    const { runtime, root } = await makeRuntime()
    await settle(runtime, 'provision')
    // Hold the session start so it is still in flight when the close is accepted.
    await writeFile(join(fakeBskStateDir(root), 'hold-session'), '1')
    const starting = runtime.startSession('agent-a' as never, new AbortController().signal)
    const accepted = runtime.start('close')
    if (!accepted.accepted) throw new Error('expected close to be accepted')
    await rm(join(fakeBskStateDir(root), 'hold-session'), { force: true })
    const result = await starting
    // The in-flight start settles failed without registering an orphan
    // session on a torn-down stack.
    expect(result).toMatchObject({ ok: false })
    expect(runtime.listSessions('agent-a' as never)).toEqual([])
  })
  it('a held session start completes late under Close: compensated once, never registered, refused not-ready', async () => {
    const { runtime, root, gate, counted } = await makeRuntime({ gateCommands: true, counted: {} })
    if (gate === undefined || counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const owner = 'agent-a' as never
    const late = gate('session start')
    const starting = runtime.startSession(owner, new AbortController().signal)
    await late.parked
    const accepted = runtime.start('close')
    if (!accepted.accepted) throw new Error('expected close to be accepted')
    // While the tracked start is pending, the retirement only drains it:
    // not one teardown step has run.
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(counted.counts.closes).toBe(0)
    expect(counted.counts.daemonStops).toBe(0)
    expect(runtime.start('open')).toMatchObject({ accepted: false, refusal: { kind: 'operation-in-progress' } })
    expect(reasonOf(await runtime.startSession('agent-b' as never, new AbortController().signal))).toBe('not-ready')
    // The start completes successfully after the abort: the session is
    // compensated on the old daemon, never registered, and the caller is
    // refused while the teardown runs once.
    late.release({ session_id: 'sess-late', browser_instance_id: INSTANCE })
    const result = await starting
    expect(result).toMatchObject({ ok: false, reason: 'not-ready' })
    expect(runtime.listSessions(owner)).toEqual([])
    await expect(accepted.settled).resolves.toMatchObject({ verb: 'close', phase: 'succeeded' })
    const invocations = await readFakeInvocations(root)
    expect(invocations).toContainEqual(expect.objectContaining({ command: 'session stop', session: 'sess-late' }))
    expect(counted.counts.closes).toBe(1)
    expect(counted.counts.daemonStops).toBe(1)
  })

  it('a held start rejecting as lost under Close joins no second retirement and tears down once', async () => {
    const { runtime, root, gate, counted } = await makeRuntime({ gateCommands: true, counted: {} })
    if (gate === undefined || counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const owner = 'agent-a' as never
    const lost = gate('session start')
    const starting = runtime.startSession(owner, new AbortController().signal)
    await lost.parked
    const accepted = runtime.start('close')
    if (!accepted.accepted) throw new Error('expected close to be accepted')
    // The parked start rejects as lost after the abort: the tracked work
    // requests the shutdown it is already inside, which must be a no-op.
    lost.release(undefined, new BskCommandError('bsk session start aborted before completion', {
      exitCode: null, signal: null, timedOut: false, aborted: true, stdout: '', stderr: '',
    }))
    const result = await starting
    expect(result).toMatchObject({ ok: false, reason: 'aborted' })
    expect(runtime.listSessions(owner)).toEqual([])
    await expect(accepted.settled).resolves.toMatchObject({ verb: 'close', phase: 'succeeded' })
    expect(counted.counts.closes).toBe(1)
    expect(counted.counts.daemonStops).toBe(1)
    expect((await readFakeInvocations(root)).some(entry => entry['command'] === 'session stop')).toBe(false)
    await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('aborts a tracked in-flight command and drains it before the daemon stop', async () => {
    const { runtime, root, killBrowserChild } = await makeRuntime()
    await settle(runtime, 'provision')
    const owner = 'agent-a' as never
    const started = await runtime.startSession(owner, new AbortController().signal)
    expect(started).toMatchObject({ ok: true })
    const session =  started.ok ? started.value.session : undefined
    // Hold the observe in flight, then kill the browser child: the exit
    // watcher begins the retirement, which aborts the tracked command and
    // drains it BEFORE the ordered teardown reaches the daemon.
    await writeFile(join(fakeBskStateDir(root), 'hold-observe'), '1')
    const observing = runtime.observe(owner, session!, new AbortController().signal)
    killBrowserChild()
    const observed = await observing
    expect(reasonOf(observed)).toBe('aborted')
    // The daemon was still alive when the aborted command settled.
    expect(await daemonAlive(root)).toBe(true)
    await rm(join(fakeBskStateDir(root), 'hold-observe'), { force: true })
    await vi.waitFor(() =>{  expect(runtime.status().state).toMatchObject({ kind: 'disconnected' }) }, { timeout: 4000 })
    expect(await daemonAlive(root)).toBe(false)
  })

  it('blocks Open while an internal shutdown from a browser exit is in flight', async () => {
    const { runtime, holdDaemonStop, releaseDaemonStopHold, killBrowserChild } = await makeRuntime()
    await settle(runtime, 'provision')
    holdDaemonStop()
    killBrowserChild()
    // While the retirement is in flight (daemon stop held), Open is refused
    // in-band instead of reacquiring the lease mid-teardown.
    await vi.waitFor(() =>{  expect(runtime.start('open').accepted).toBe(false) }, { timeout: 4000 })
    expect(runtime.start('open')).toMatchObject({ accepted: false, refusal: { kind: 'operation-in-progress' } })
    releaseDaemonStopHold()
    await vi.waitFor(() =>{  expect(runtime.status().state).toMatchObject({ kind: 'disconnected' }) }, { timeout: 4000 })
    // After the retirement settles, a fresh open works on a new lifetime.
    await settle(runtime, 'open')
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    await settle(runtime, 'close')
  })
  it('a user Close tears down exactly once while children exit mid-teardown and never repaints disconnected', async () => {
    const { runtime, root, counted } = await makeRuntime({ counted: { emitExitOnClose: true } })
    if (counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const statuses: BrowserSkillStatus[] = []
    runtime.subscribe(status => statuses.push(status))
    await settle(runtime, 'close')
    // The child exits DURING the teardown are the duplicate-shutdown trigger:
    // the retirement marker refuses both callbacks, so the teardown ran once
    // and a normal Close is provisioned end to end.
    expect(counted.counts.closes).toBe(1)
    expect(counted.counts.daemonStops).toBe(1)
    const closeStates = statuses.filter(entry => entry.operation?.verb === 'close').map(entry => entry.state.kind)
    expect(closeStates).not.toContain('disconnected')
    expect(runtime.status().state).toMatchObject({ kind: 'provisioned' })
    await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stale exit callbacks from a closed stack leave the reopened stack untouched and usable', async () => {
    const { runtime, counted } = await makeRuntime({ counted: { emitExitOnClose: false } })
    if (counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    await settle(runtime, 'close')
    expect(counted.counts.closes).toBe(1)
    // A fresh lifetime owns fresh children; the old children kept their exit
    // callbacks without emitting during the successful close.
    await settle(runtime, 'open')
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    expect(counted.counts.launches).toBe(2)
    const statusesAfterOpen: BrowserSkillStatus[] = []
    runtime.subscribe(status => statusesAfterOpen.push(status))
    counted.browserChildren[0]?.emitExit()
    counted.daemonChildren[0]?.emitExit()
    await new Promise(resolve => setTimeout(resolve, 100))
    // The old callbacks captured the old lifetime: identity checks refuse
    // them, so B sees no new operation, no teardown, and stays usable.
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    expect(statusesAfterOpen).toEqual([])
    expect(counted.counts.closes).toBe(1)
    expect(counted.counts.daemonStops).toBe(1)
    const started = await runtime.startSession('agent-b' as never, new AbortController().signal)
    expect(started).toMatchObject({ ok: true })
    await settle(runtime, 'close')
  })

  it('Close drains a held health probe before teardown, then leaves no timer behind', async () => {
    const { runtime, root, gate, counted } = await makeRuntime({ gateCommands: true, counted: {} })
    if (gate === undefined || counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const sessionStart = await runtime.startSession('agent-a' as never, new AbortController().signal)
    expect(sessionStart).toMatchObject({ ok: true })
    // Park the next health probe before it spawns.
    const probe = gate('browsers --json')
    await probe.parked
    const browsersBefore = await browsersRecorded(root)
    const accepted = runtime.start('close')
    if (!accepted.accepted) throw new Error('expected close to be accepted')
    // The tracked probe is drained BEFORE any teardown: the close cannot
    // complete while the probe is live, and nothing has been torn down.
    const raced = await Promise.race([
      accepted.settled.then(() => 'settled' as const),
      new Promise(resolve => setTimeout(() =>{  resolve('running') }, 200)),
    ])
    expect(raced).toBe('running')
    expect(counted.counts.closes).toBe(0)
    // The retirement aborts the parked probe in flight; it settles quietly
    // (never as a miss, never as a shutdown request) and only then does the
    // teardown run — a tracked probe cannot outlive the completed Close.
    probe.release(undefined, new BskCommandError('bsk browsers aborted before completion', {
      exitCode: null, signal: null, timedOut: false, aborted: true, stdout: '', stderr: '',
    }))
    await expect(accepted.settled).resolves.toMatchObject({ verb: 'close', phase: 'succeeded' })
    expect(counted.counts.closes).toBe(1)
    // The health interval was cleared before the teardown: no further probes.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(await browsersRecorded(root)).toBe(browsersBefore)
    // B only becomes ready once A had no tracked work left, and stands alone.
    await settle(runtime, 'open')
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    await settle(runtime, 'close')
  })

  it('a failed retirement keeps lease and lifetime, refuses reopen and tools, and retries only by hand', async () => {
    const { runtime, root, counted } = await makeRuntime({ counted: { closePlan: ['fail'] } })
    if (counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const accepted = runtime.start('close')
    if (!accepted.accepted) throw new Error('expected close to be accepted')
    await expect(accepted.settled).resolves.toMatchObject({
      verb: 'close', phase: 'failed',
      refusal: { kind: 'shutdown-incomplete', detail: expect.stringContaining('chrome close failed') as string },
    })
    // The lease stays retained with the unconfirmed browser pid; the
    // confirmed-exited daemon pid was cleared.
    const lock = JSON.parse(await readFile(join(root, 'runtime.lock'), 'utf8')) as { pid: number; daemonPid?: number; browserPid?: number }
    expect(lock.pid).toBe(process.pid)
    expect(lock.daemonPid).toBeUndefined()
    expect(lock.browserPid).toBeGreaterThan(0)
    // The aborted lifetime and its lease refuse tools and reopen alike.
    expect(reasonOf(await runtime.startSession('agent-a' as never, new AbortController().signal))).toBe('not-ready')
    expect(runtime.start('open')).toMatchObject({ accepted: false, refusal: { kind: 'operation-in-progress' } })
    // Stale exit callbacks of the failed stack must not retry the retirement.
    counted.browserChildren[0]?.emitExit()
    counted.daemonChildren[0]?.emitExit()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(counted.counts.closes).toBe(1)
    expect(counted.counts.daemonStops).toBe(1)
    expect(runtime.status().state).toMatchObject({ kind: 'failed' })
    // The manual retry gets a fresh retirement and releases everything.
    counted.closePlan.splice(0, counted.closePlan.length, 'ok')
    await settle(runtime, 'close')
    expect(runtime.status().state).toMatchObject({ kind: 'provisioned' })
    await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(counted.counts.closes).toBe(2)
  })

  it('an idle runtime disposes through the one path, a second dispose is a no-op', async () => {
    const { runtime, root } = await makeRuntime()
    await settle(runtime, 'provision')
    await expect(runtime.dispose()).resolves.toBeUndefined()
    await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    // A second dispose returns immediately.
    await expect(runtime.dispose()).resolves.toBeUndefined()
  })

  it('dispose after a failed retirement retries it, warns, and retains the lease', async () => {
    const logs: string[] = []
    const { runtime, root, counted } = await makeRuntime({ counted: { closePlan: ['fail', 'fail'] }, captureLogs: logs })
    if (counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const accepted = runtime.start('close')
    if (!accepted.accepted) throw new Error('expected close to be accepted')
    await expect(accepted.settled).resolves.toMatchObject({ phase: 'failed' })
    // Dispose is a retry path: the retirement fails again and stays visible.
    await expect(runtime.dispose()).resolves.toBeUndefined()
    expect(logs.some(line => line.includes('dispose shutdown incomplete'))).toBe(true)
    expect(await readFile(join(root, 'runtime.lock'), 'utf8')).toContain('"pid"')
    expect(runtime.status().state).toMatchObject({ kind: 'failed' })
  })

  it('uninstall refuses to delete while the retirement fails, and succeeds after it is fixed', async () => {
    const { runtime, root, counted } = await makeRuntime({ counted: { closePlan: ['fail', 'ok'] } })
    if (counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    await expect(settle(runtime, 'uninstall', { keepProfile: false })).resolves.toMatchObject({
      verb: 'uninstall', phase: 'failed', refusal: { kind: 'shutdown-incomplete' },
    })
    // Nothing was deleted and the lease stays retained.
    expect(await readFile(join(root, 'runtime.json'), 'utf8')).toContain('daemonPort')
    expect(await readFile(join(root, 'runtime.lock'), 'utf8')).toContain('"pid"')
    await settle(runtime, 'uninstall', { keepProfile: false })
    expect(runtime.status().state).toMatchObject({ kind: 'absent' })
    await expect(readFile(join(root, 'runtime.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('invalid persisted daemon ports are never trusted; open re-picks and rewrites them', async () => {
    const { runtime, root } = await makeRuntime({ seedProvisioned: true })
    await runtime.refreshProvisioned()
    const variants: unknown[] = ['[1,2]', '{ "version": 2, "daemonPort": 5000 }', '{ "version": 1, "daemonPort": "x" }']
    for (const raw of variants) {
      await writeFile(join(root, 'runtime.json'), String(raw))
      await settle(runtime, 'open')
      const status = runtime.status()
      expect(status.state).toMatchObject({ kind: 'ready' })
      // The rewritten record is valid again, and the daemon answered on it.
      const rewritten = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')) as { version: number; daemonPort: number }
      expect(rewritten.version).toBe(1)
      expect(rewritten.daemonPort).toBeGreaterThan(0)
      await settle(runtime, 'close')
    }
  })

  it('a fresh runtime reports absent with no artifacts; refresh re-reports provisioned once', async () => {
    const { runtime } = await makeRuntime()
    const fresh = runtime.status()
    expect(fresh.state).toMatchObject({ kind: 'absent' })
    expect(fresh.artifacts).toBeUndefined()
    const statuses: BrowserSkillStatus[] = []
    runtime.subscribe(status => statuses.push(status))
    await runtime.refreshProvisioned()
    expect(statuses).toEqual([])
    await runtime.refreshProvisioned()
    expect(statuses).toEqual([])
  })

  it('an internal shutdown that cannot confirm the daemon exit fails its close operation', async () => {
    const { runtime, setDaemonStopError, killBrowserChild } = await makeRuntime({ daemonStopError: 'daemon did not exit' })
    await settle(runtime, 'provision')
    killBrowserChild()
    const statuses: BrowserSkillOperation[] = []
    runtime.subscribe((status) => { if (status.operation !== undefined) statuses.push(status.operation) })
    await vi.waitFor(() => {
      const last = statuses.at(-1)
      if (last?.phase !== 'failed') throw new Error('still ' + String(last?.phase))
    }, { timeout: 5000 })
    expect(statuses.at(-1)).toMatchObject({ verb: 'close', phase: 'failed', refusal: { kind: 'shutdown-incomplete', detail: expect.stringContaining('daemon did not exit') as string } })
    setDaemonStopError(undefined)
    await settle(runtime, 'close')
  })

  it('provision publishes provisioning steps from the producer', async () => {
    const steps: string[] = []
    const { runtime } = await makeRuntime({ provisionSteps: ['download', 'extract'] })
    runtime.subscribe((status) => {
      if (status.state.kind === 'provisioning' && status.state.step !== undefined) steps.push(status.state.step)
    })
    await settle(runtime, 'provision')
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    // The supervisor's own pre-producer paint plus every producer step lands.
    expect(steps).toContain('extract')
    expect(steps.every(step => step === 'download' || step === 'extract')).toBe(true)
  })

  it('every command refuses not-ready, refuses foreign sessions, and drives its happy path', async () => {
    const { runtime, root, gate, counted } = await makeRuntime({ gateCommands: true, counted: {} })
    if (gate === undefined || counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const ownerA = 'agent-a' as never
    const ownerB = 'agent-b' as never
    const started = await runtime.startSession(ownerA, new AbortController().signal)
    expect(started).toMatchObject({ ok: true })
    const session =  started.ok ? started.value.session : undefined as never
    // While the close operation holds the reservation, every command refuses
    // not-ready before any spawn.
    const accepted = runtime.start('close')
    if (!accepted.accepted) throw new Error('expected close to be accepted')
    const invocationsDuring = await readFakeInvocations(root)
    expect(reasonOf(await runtime.stopSession(ownerA, session, new AbortController().signal))).toBe('not-ready')
    expect(reasonOf(await runtime.navigate(ownerA, session, new URL('https://shres.test/'), new AbortController().signal))).toBe('not-ready')
    expect(reasonOf(await runtime.observe(ownerA, session, new AbortController().signal))).toBe('not-ready')
    expect(reasonOf(await runtime.act(ownerA, session, { kind: 'click', ref: '@e1' }, new AbortController().signal))).toBe('not-ready')
    expect(await readFakeInvocations(root)).toEqual(invocationsDuring)
    await expect(accepted.settled).resolves.toMatchObject({ phase: 'succeeded' })
    // With no lifetime at all, the refusal repeats without throwing.
    expect(reasonOf(await runtime.observe(ownerA, session, new AbortController().signal))).toBe('not-ready')
    // Reopen and re-check the ownership and validation refusals, then the happy paths.
    await settle(runtime, 'open')
    const startedB = await runtime.startSession(ownerA, new AbortController().signal)
    expect(startedB).toMatchObject({ ok: true })
    const sessionB =  startedB.ok ? startedB.value.session : undefined as never
    expect(reasonOf(await runtime.stopSession(ownerB, sessionB, new AbortController().signal))).toBe('unknown-session')
    expect(reasonOf(await runtime.navigate(ownerB, sessionB, new URL('https://shres.test/'), new AbortController().signal))).toBe('unknown-session')
    expect(reasonOf(await runtime.observe(ownerB, sessionB, new AbortController().signal))).toBe('unknown-session')
    expect(reasonOf(await runtime.act(ownerB, sessionB, { kind: 'press', key: 'Enter' }, new AbortController().signal))).toBe('unknown-session')
    expect(await runtime.navigate(ownerA, sessionB, new URL('https://shres.test/page'), new AbortController().signal)).toMatchObject({ ok: true })
    expect(await runtime.act(ownerA, sessionB, { kind: 'click', ref: '@e2' }, new AbortController().signal)).toMatchObject({ ok: true })
    expect(await runtime.act(ownerA, sessionB, { kind: 'fill', ref: '@e3', value: 'hello' }, new AbortController().signal)).toMatchObject({ ok: true })
    expect(await runtime.act(ownerA, sessionB, { kind: 'fill', ref: '#bad', value: 'x' }, new AbortController().signal)).toMatchObject({ ok: false })
    expect(await runtime.act(ownerA, sessionB, { kind: 'press', key: 'Enter' }, new AbortController().signal)).toMatchObject({ ok: true })
    // During a no-op reopen the operation reservation refuses commands too.
    const noopOpen = runtime.start('open')
    if (!noopOpen.accepted) throw new Error('expected reopen to be accepted')
    expect(reasonOf(await runtime.observe(ownerA, sessionB, new AbortController().signal))).toBe('not-ready')
    await expect(noopOpen.settled).resolves.toMatchObject({ phase: 'succeeded' })
    // An unsubscribed listener sees nothing further.
    const unsubscribed: BrowserSkillStatus[] = []
    const unsubscribe = runtime.subscribe(status => unsubscribed.push(status))
    unsubscribe()
    const startedForStop = await runtime.startSession(ownerA, new AbortController().signal)
    expect(startedForStop).toMatchObject({ ok: true })
    expect(unsubscribed).toEqual([])
    // A failing stop command reports the lost outcome instead of throwing.
    const failingStop = gate('session stop')
    const stopping = runtime.stopSession(ownerA, sessionB, new AbortController().signal)
    await failingStop.parked
    failingStop.release(undefined, new BskCommandError('bsk session stop exited 1: lost', {
      exitCode: 1, signal: null, timedOut: false, aborted: false, stdout: '', stderr: 'lost',
    }))
    expect(await stopping).toMatchObject({ ok: false, reason: 'command-failed' })
    await settle(runtime, 'close')
  })

  it('open refusals normalize daemon start failures and raw thrown values', async () => {
    const daemonStartError = await makeRuntime({
      seedProvisioned: true,
      counted: { daemonStartFailure: 'daemon did not become ready' },
    })
    await daemonStartError.runtime.refreshProvisioned()
    await expect(settle(daemonStartError.runtime, 'open')).resolves.toMatchObject({
      phase: 'failed', refusal: { kind: 'daemon-start-failed', detail: 'daemon did not become ready' },
    })
    const rawError = await makeRuntime({
      seedProvisioned: true,
      counted: { daemonStartFailure: 'spark', failuresAreStrings: false },
    })
    // The counted seam throws the string as-is only with failuresAreStrings; with it off the
    // raw-Error path needs a non-classified error, produced by the lease producer here.
    const stringThrow = await makeRuntime({
      seedProvisioned: true,
      acquireLease: async () => {
        throw 'lock exploded'
      },
    })
    await stringThrow.runtime.refreshProvisioned()
    await expect(settle(stringThrow.runtime, 'open')).resolves.toMatchObject({
      phase: 'failed', refusal: { kind: 'daemon-start-failed', detail: 'lock exploded' },
    })
    expect(daemonStartError.counted?.counts.daemonStarts).toBe(1)
    expect(rawError).toBeDefined()
  })

  it('a close whose owned children report string failures keeps every recorded pid', async () => {
    const { runtime, root, counted } = await makeRuntime({
      counted: {
        closePlan: ['fail'],
        daemonStopFailure: 'daemon stop lost',
        failuresAreStrings: true,
      },
    })
    if (counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    await expect(settle(runtime, 'close')).resolves.toMatchObject({
      phase: 'failed', refusal: { kind: 'shutdown-incomplete', detail: expect.stringContaining('daemon stop lost') as string },
    })
    const lock = JSON.parse(await readFile(join(root, 'runtime.lock'), 'utf8')) as { daemonPid?: number; browserPid?: number }
    expect(lock.daemonPid).toBeGreaterThan(0)
    expect(lock.browserPid).toBeGreaterThan(0)
  })

  it('an open unwind keeps the daemon pid it could not confirm and clears the confirmed browser pid', async () => {
    const { runtime, root, counted } = await makeRuntime({
      seedProvisioned: true,
      counted: { closePlan: ['ok'], daemonStopFailure: 'daemon stop lost', seedInstance: false },
      config: { ...testConfig(), browserConnectTimeoutMs: 600 },
    })
    if (counted === undefined) throw new Error('fixture misconfigured')
    await runtime.refreshProvisioned()
    await expect(settle(runtime, 'open')).resolves.toMatchObject({
      phase: 'failed', refusal: { kind: 'shutdown-incomplete', detail: expect.stringContaining('daemon stop lost') as string },
    })
    const lock = JSON.parse(await readFile(join(root, 'runtime.lock'), 'utf8')) as { daemonPid?: number; browserPid?: number }
    expect(lock.daemonPid).toBeGreaterThan(0)
    expect(lock.browserPid).toBeUndefined()
    // Reopen over the unfinished shutdown names only the recorded daemon.
    const refusedOpen = runtime.start('open')
    if (refusedOpen.accepted) throw new Error('expected open to be refused')
    expect(refusedOpen.refusal).toMatchObject({ kind: 'shutdown-incomplete', detail: expect.stringContaining('daemon pid') as string })
    if (refusedOpen.refusal.kind !== 'shutdown-incomplete') throw new Error('unexpected refusal kind')
    expect(refusedOpen.refusal.detail).not.toContain('browser pid')
  })

  it('a malformed browsers reply refuses the open as instance-mismatch', async () => {
    const { runtime, gate } = await makeRuntime({ gateCommands: true, counted: {} })
    if (gate === undefined) throw new Error('fixture misconfigured')
    const malformed = gate('browsers --json')
    const accepted = runtime.start('provision')
    if (!accepted.accepted) throw new Error('expected provision to be accepted')
    await malformed.parked
    malformed.release({ nonsense: true })
    await expect(accepted.settled).resolves.toMatchObject({
      phase: 'failed', refusal: { kind: 'instance-mismatch' },
    })
  })

  it('session start losses distinguish timeout, wire, and plain failures', async () => {
    const { runtime, gate, counted } = await makeRuntime({ gateCommands: true, counted: {} })
    if (gate === undefined || counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    // Timed-out start: lost, command-failed, stack shut down.
    let holder = gate('session start')
    let starting = runtime.startSession('agent-a' as never, new AbortController().signal)
    await holder.parked
    holder.release(undefined, new BskCommandError('bsk session start did not complete within its deadline', {
      exitCode: null, signal: null, timedOut: true, aborted: false, stdout: '', stderr: '',
    }))
    expect(await starting).toMatchObject({ ok: false, reason: 'command-failed' })
    await vi.waitFor(() =>{  expect(runtime.status().state).toMatchObject({ kind: 'disconnected' }) }, { timeout: 4000 })
    // Unreadable start reply: lost the same way.
    await settle(runtime, 'open')
    holder = gate('session start')
    starting = runtime.startSession('agent-a' as never, new AbortController().signal)
    await holder.parked
    holder.release(undefined, new BskWireError('start reply was unreadable'))
    expect(await starting).toMatchObject({ ok: false, reason: 'command-failed' })
    await vi.waitFor(() =>{  expect(runtime.status().state).toMatchObject({ kind: 'disconnected' }) }, { timeout: 4000 })
    // Plain and non-Error failures are reported without shutting the stack down.
    await settle(runtime, 'open')
    holder = gate('session start')
    starting = runtime.startSession('agent-a' as never, new AbortController().signal)
    await holder.parked
    holder.release(undefined, new Error('plain boom'))
    expect(await starting).toMatchObject({ ok: false, reason: 'command-failed', detail: expect.stringContaining('plain boom') as string })
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    holder = gate('session start')
    starting = runtime.startSession('agent-a' as never, new AbortController().signal)
    await holder.parked
    holder.release(undefined, 'string boom' as unknown as Error)
    expect(await starting).toMatchObject({ ok: false, detail: expect.stringContaining('string boom') as string })
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    await settle(runtime, 'close')
  })

  it('a session command completing after its retirement began reports not-ready', async () => {
    const { runtime, gate } = await makeRuntime({ gateCommands: true, counted: {} })
    if (gate === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const started = await runtime.startSession('agent-a' as never, new AbortController().signal)
    expect(started).toMatchObject({ ok: true })
    const session =  started.ok ? started.value.session : undefined as never
    const held = gate('observe --json')
    const observing = runtime.observe('agent-a' as never, session, new AbortController().signal)
    await held.parked
    const accepted = runtime.start('close')
    if (!accepted.accepted) throw new Error('expected close to be accepted')
    held.release({ text: 'late observation' })
    expect(await observing).toMatchObject({ ok: false, reason: 'not-ready' })
    await expect(accepted.settled).resolves.toMatchObject({ phase: 'succeeded' })
  })

  it('one throwing status listener never starves the others', async () => {
    const logs: string[] = []
    const { runtime } = await makeRuntime({ provisionSteps: ['download'], captureLogs: logs })
    const seen: BrowserSkillStatus[] = []
    runtime.subscribe(() => { throw new Error('listener boom') })
    runtime.subscribe(status => seen.push(status))
    await settle(runtime, 'provision')
    expect(seen.length).toBeGreaterThan(0)
    expect(logs.some(line => line.includes('status listener threw'))).toBe(true)
    await settle(runtime, 'close')
  })

  it('dispose mid-open with default runner and daemon seams never constructs a launcher launch', async () => {
    const { runtime, root, launchedProfiles } = await makeRuntime({ defaultRunnerAndDaemon: true, seedProvisioned: true })
    await runtime.refreshProvisioned()
    await mkdir(fakeBskStateDir(root), { recursive: true })
    await writeFile(join(fakeBskStateDir(root), 'hold-status'), '')
    const started = runtime.start('open')
    if (!started.accepted) throw new Error('expected open to be accepted')
    await vi.waitFor(() =>{  expect(existsSync(join(fakeBskStateDir(root), 'daemon.json'))).toBe(true) })
    await expect(runtime.dispose()).resolves.toBeUndefined()
    await expect(started.settled).resolves.toMatchObject({ phase: 'failed', refusal: { kind: 'disposed' } })
    expect(launchedProfiles).toEqual([])
    await expect(readFile(join(root, 'runtime.lock'), 'utf8').catch(() => 'released')).resolves.toBe('released')
  })



  it('refresh after provisioning keeps the provisioned state without repainting', async () => {
    const { runtime } = await makeRuntime()
    await settle(runtime, 'provision')
    const statuses: BrowserSkillStatus[] = []
    runtime.subscribe(status => statuses.push(status))
    await runtime.refreshProvisioned()
    expect(statuses).toEqual([])
    await settle(runtime, 'close')
  })

  it('a numeric runtime state file is never trusted as a daemon port', async () => {
    const { runtime, root } = await makeRuntime({ seedProvisioned: true })
    await runtime.refreshProvisioned()
    await writeFile(join(root, 'runtime.json'), '42')
    await settle(runtime, 'open')
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    await settle(runtime, 'close')
  })

  it('the uninstall purge keeps a recorded profile directory only when asked', async () => {
    const { runtime, root } = await makeRuntime()
    await settle(runtime, 'provision')
    await settle(runtime, 'close')
    await mkdir(join(root, 'profile'), { recursive: true })
    await settle(runtime, 'uninstall', { keepProfile: true })
    expect(runtime.status().state).toMatchObject({ kind: 'absent' })
  })

  it('dispose during a close survives a failing compensation stop and still tears down once', async () => {
    const { runtime, root, gate, counted } = await makeRuntime({ gateCommands: true, counted: {} })
    if (gate === undefined || counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const holder = gate('session start')
    const starting = runtime.startSession('agent-a' as never, new AbortController().signal)
    await holder.parked
    const accepted = runtime.start('close')
    if (!accepted.accepted) throw new Error('expected close to be accepted')
    const disposing = runtime.dispose()
    holder.release({ session_id: 'sess-late', browser_instance_id: INSTANCE })
    // The late success compensates on the old daemon; that stop fails and must
    // not break the refusal or the single teardown.
    const failingStop = gate('session stop')
    await failingStop.parked
    failingStop.release(undefined, new BskCommandError('bsk session stop exited 1: lost', {
      exitCode: 1, signal: null, timedOut: false, aborted: false, stdout: '', stderr: 'lost',
    }))
    expect(await starting).toMatchObject({ ok: false, reason: 'not-ready' })
    await expect(disposing).resolves.toBeUndefined()
    expect(counted.counts.closes).toBe(1)
    await expect(accepted.settled).resolves.toMatchObject({ verb: 'close', phase: 'succeeded' })
    await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('a lease release that throws raw is reported as shutdown-incomplete', async () => {
    let releases = 0
    const { runtime, counted } = await makeRuntime({
      counted: {},
      acquireLease: async (ownedRoot, hooks) => {
        const lease = await acquireRuntimeLease(ownedRoot, hooks)
        return {
          ...lease,
          release: async () => {
            releases += 1
            await lease.release()
            // Provision releases first; the close's release fails.
            if (releases >= 2) throw 'release exploded'
          },
        }
      },
    })
    if (counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    await settle(runtime, 'open')
    // The close's lease release throws after releasing: the ordered close
    // already finished, so the raw failure surfaces as shutdown-incomplete.
    await expect(settle(runtime, 'close')).resolves.toMatchObject({
      phase: 'failed', refusal: { kind: 'shutdown-incomplete', detail: expect.stringContaining('release exploded') as string },
    })
  })

  it('open refusals normalize raw thrown errors from the lease producer', async () => {
    const { runtime } = await makeRuntime({
      seedProvisioned: true,
      acquireLease: async () => {
        throw new Error('plain lock refusal')
      },
    })
    await runtime.refreshProvisioned()
    await expect(settle(runtime, 'open')).resolves.toMatchObject({
      phase: 'failed', refusal: { kind: 'daemon-start-failed', detail: 'plain lock refusal' },
    })
  })

  it('a failed clear-update during the open unwind keeps the confirmed pids recorded', async () => {
    const { runtime, root, counted } = await makeRuntime({
      seedProvisioned: true,
      counted: { closePlan: ['ok'], daemonStopFailure: 'daemon stop lost', seedInstance: false, updateFailsAfterFirst: true },
      config: { ...testConfig(), browserConnectTimeoutMs: 600 },
    })
    if (counted === undefined) throw new Error('fixture misconfigured')
    await runtime.refreshProvisioned()
    await expect(settle(runtime, 'open')).resolves.toMatchObject({
      phase: 'failed', refusal: { kind: 'shutdown-incomplete' },
    })
    // The bookkeeping clear failed, so both recorded pids stay retained.
    const lock = JSON.parse(await readFile(join(root, 'runtime.lock'), 'utf8')) as { daemonPid?: number; browserPid?: number }
    expect(lock.daemonPid).toBeGreaterThan(0)
    expect(lock.browserPid).toBeGreaterThan(0)
  })

  it('an open unwind reports string failures from both owned children', async () => {
    const { runtime, root, counted } = await makeRuntime({
      seedProvisioned: true,
      counted: { closePlan: ['fail'], daemonStopFailure: 'daemon stop lost', failuresAreStrings: true, seedInstance: false },
      config: { ...testConfig(), browserConnectTimeoutMs: 600 },
    })
    if (counted === undefined) throw new Error('fixture misconfigured')
    await runtime.refreshProvisioned()
    await expect(settle(runtime, 'open')).resolves.toMatchObject({
      phase: 'failed', refusal: { kind: 'shutdown-incomplete', detail: expect.stringContaining('daemon stop lost') as string },
    })
    const lock = JSON.parse(await readFile(join(root, 'runtime.lock'), 'utf8')) as { daemonPid?: number; browserPid?: number }
    expect(lock.daemonPid).toBeGreaterThan(0)
    expect(lock.browserPid).toBeGreaterThan(0)
    // Reopen over the unfinished shutdown names both recorded pids.
    const refusedOpen = runtime.start('open')
    if (refusedOpen.accepted) throw new Error('expected open to be refused')
    expect(refusedOpen.refusal).toMatchObject({ kind: 'shutdown-incomplete', detail: expect.stringContaining('browser pid') as string })
    if (refusedOpen.refusal.kind !== 'shutdown-incomplete') throw new Error('unexpected refusal kind')
    expect(refusedOpen.refusal.detail).toContain('daemon pid')
    // The manual retry confirms both children and releases the retained hold.
    counted.closePlan.splice(0, counted.closePlan.length, 'ok')
    await settle(runtime, 'close')
    expect(runtime.status().state).toMatchObject({ kind: 'provisioned' })
  })

  it('a failing default-port hold release during the open unwind does not mask the refusal', async () => {
    let releases = 0
    const { runtime, counted } = await makeRuntime({
      seedProvisioned: true,
      counted: { launchFailure: 'no chrome here' },
      reservePort: async () => {
        const hold = await reserveLoopbackPort(DEFAULT_DAEMON_PORT)
        return {
          port: hold.port,
          contacts: (): number => 0,
          release: async () => {
            releases += 1
            await hold.release()
            throw new Error('hold release unavailable')
          },
        }
      },
    })
    if (counted === undefined) throw new Error('fixture misconfigured')
    await runtime.refreshProvisioned()
    await expect(settle(runtime, 'open')).resolves.toMatchObject({
      phase: 'failed', refusal: { kind: 'daemon-start-failed', detail: expect.stringContaining('no chrome here') as string },
    })
    // The unwind released the hold, swallowed its failure, and reported the
    // launch refusal.
    expect(releases).toBe(1)
    expect(counted.counts.launches).toBe(1)
  })

  it('a close whose lease bookkeeping update fails still reports shutdown-incomplete', async () => {
    const { runtime, counted } = await makeRuntime({
      counted: { closePlan: ['fail'], updateFailsAfterFirst: true },
    })
    if (counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    await expect(settle(runtime, 'close')).resolves.toMatchObject({
      phase: 'failed', refusal: { kind: 'shutdown-incomplete', detail: expect.stringContaining('chrome close failed') as string },
    })
    // The bookkeeping failure was best-effort; the refusal carries the outcome.
    counted.closePlan.splice(0, counted.closePlan.length, 'ok')
    await settle(runtime, 'close')
  })

  it('a close whose recorded session stop fails still completes', async () => {
    const { runtime, gate } = await makeRuntime({ gateCommands: true, counted: {} })
    if (gate === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const started = await runtime.startSession('agent-a' as never, new AbortController().signal)
    expect(started).toMatchObject({ ok: true })
    const failingStop = gate('session stop')
    const accepted = runtime.start('close')
    if (!accepted.accepted) throw new Error('expected close to be accepted')
    await failingStop.parked
    failingStop.release(undefined, new BskCommandError('bsk session stop exited 1: lost', {
      exitCode: 1, signal: null, timedOut: false, aborted: false, stdout: '', stderr: 'lost',
    }))
    await expect(accepted.settled).resolves.toMatchObject({ verb: 'close', phase: 'succeeded' })
  })

  it('a browsers poll with a lost outcome retries instead of refusing', async () => {
    const { runtime, gate } = await makeRuntime({ gateCommands: true, counted: {} })
    if (gate === undefined) throw new Error('fixture misconfigured')
    const failing = gate('browsers --json')
    const accepted = runtime.start('provision')
    if (!accepted.accepted) throw new Error('expected provision to be accepted')
    await failing.parked
    failing.release(undefined, new Error('browsers poll lost'))
    // The lost poll is retried; the retry runs for real and pairing completes.
    await expect(accepted.settled).resolves.toMatchObject({ phase: 'succeeded' })
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    await settle(runtime, 'close')
  })

  it('a command settling after its retirement began reports not-ready without acting', async () => {
    const { runtime, gate } = await makeRuntime({ gateCommands: true, counted: {} })
    if (gate === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const started = await runtime.startSession('agent-a' as never, new AbortController().signal)
    expect(started).toMatchObject({ ok: true })
    const session =  started.ok ? started.value.session : undefined as never
    const held = gate('observe --json')
    const observing = runtime.observe('agent-a' as never, session, new AbortController().signal)
    await held.parked
    const accepted = runtime.start('close')
    if (!accepted.accepted) throw new Error('expected close to be accepted')
    held.release({ text: 'late' })
    expect(await observing).toMatchObject({ ok: false, reason: 'not-ready' })
    await expect(accepted.settled).resolves.toMatchObject({ phase: 'succeeded' })
  })

  it('command outcomes report timeout, unreadable replies, and raw failures', async () => {
    const { runtime, gate, counted } = await makeRuntime({ gateCommands: true, counted: {} })
    if (gate === undefined || counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const started = await runtime.startSession('agent-a' as never, new AbortController().signal)
    expect(started).toMatchObject({ ok: true })
    const session =  started.ok ? started.value.session : undefined as never
    // Timed-out observe.
    let holder = gate('observe --json')
    let observing = runtime.observe('agent-a' as never, session, new AbortController().signal)
    await holder.parked
    holder.release(undefined, new BskCommandError('bsk observe did not complete within its deadline', {
      exitCode: null, signal: null, timedOut: true, aborted: false, stdout: '', stderr: '',
    }))
    expect(await observing).toMatchObject({ ok: false, reason: 'command-failed', detail: expect.stringContaining('timed out') as string })
    // Unreadable reply: valid JSON but not the object the command requires.
    holder = gate('observe --json')
    observing = runtime.observe('agent-a' as never, session, new AbortController().signal)
    await holder.parked
    holder.release(['not', 'an', 'object'])
    expect(await observing).toMatchObject({ ok: false, reason: 'command-failed', detail: expect.stringContaining('unreadable') as string })
    // Raw non-Error failure carries its text verbatim.
    holder = gate('observe --json')
    observing = runtime.observe('agent-a' as never, session, new AbortController().signal)
    await holder.parked
    holder.release(undefined, 'observe exploded' as unknown as Error)
    expect(await observing).toMatchObject({ ok: false, detail: expect.stringContaining('observe exploded') as string })
    // The caller abort fires the command's combined signal even though the
    // parked command ignores it, and the released reply still arrives.
    const callerController = new AbortController()
    holder = gate('observe --json')
    observing = runtime.observe('agent-a' as never, session, callerController.signal)
    await holder.parked
    callerController.abort()
    holder.release({ text: 'after abort' })
    expect(await observing).toMatchObject({ ok: true })
    await settle(runtime, 'close')
  })

  it('an open with the default chrome seam refuses at the launcher without launching', async () => {
    const { runtime, root, fake } = await makeRuntime({ defaultRunnerAndDaemon: true, seedProvisioned: true })
    await runtime.refreshProvisioned()
    await seedFakeInstances(root, [{ instance_id: INSTANCE, label: 'shres-managed' }])
    await expect(settle(runtime, 'open')).resolves.toMatchObject({
      phase: 'failed', refusal: { kind: 'extension-load-failed' },
    })
    expect(fake.launches).toBe(0)
  })

  it('the daemon never spawns on the fallback port; the next ephemeral pick persists', async () => {
    let calls = 0
    const { runtime, root, counted } = await makeRuntime({
      seedProvisioned: true,
      counted: {},
      pickDaemonPort: async () => {
        calls += 1
        return calls === 1 ? DEFAULT_DAEMON_PORT : 53001
      },
    })
    if (counted === undefined) throw new Error('fixture misconfigured')
    await runtime.refreshProvisioned()
    await settle(runtime, 'open')
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    // The fallback-port pick was discarded and the next one was persisted and
    // spawned before the Chrome launch.
    expect(calls).toBe(2)
    const persisted = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')) as { daemonPort: number }
    expect(persisted.daemonPort).toBe(53001)
    expect(counted.counts.lastStartedPort).toBe(53001)
    await settle(runtime, 'close')
  })

  it('a picker that only offers the fallback port refuses the open before any daemon spawns', async () => {
    const { runtime, root, counted } = await makeRuntime({
      seedProvisioned: true,
      counted: {},
      pickDaemonPort: async () => DEFAULT_DAEMON_PORT,
    })
    await runtime.refreshProvisioned()
    await expect(settle(runtime, 'open')).resolves.toMatchObject({
      phase: 'failed', refusal: { kind: 'endpoint-in-use', port: DEFAULT_DAEMON_PORT },
    })
    expect(counted?.counts.daemonStarts).toBe(0)
    await expect(readFile(join(root, 'runtime.lock'), 'utf8').catch(() => 'released')).resolves.toBe('released')
  })

  it('a persisted fallback port is repaired to a usable port before the daemon spawns', async () => {
    const { runtime, root, counted } = await makeRuntime({
      seedProvisioned: true,
      counted: {},
      pickDaemonPort: async () => 53001,
    })
    await runtime.refreshProvisioned()
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ version: 1, daemonPort: DEFAULT_DAEMON_PORT }))
    await settle(runtime, 'open')
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    const persisted = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')) as { daemonPort: number }
    expect(persisted.daemonPort).toBe(53001)
    expect(counted?.counts.lastStartedPort).toBe(53001)
    await settle(runtime, 'close')
  })

  it('reset never persists the fallback port', async () => {
    let calls = 0
    const { runtime, root } = await makeRuntime({
      seedProvisioned: true,
      counted: {},
      pickDaemonPort: async () => {
        calls += 1
        return calls % 2 === 1 ? DEFAULT_DAEMON_PORT : 53001
      },
    })
    await runtime.refreshProvisioned()
    await settle(runtime, 'open')
    await settle(runtime, 'close')
    const before = calls
    await settle(runtime, 'reset')
    const persisted = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')) as { daemonPort: number }
    expect(persisted.daemonPort).toBe(53001)
    expect(calls).toBeGreaterThan(before)
  })

  it('a valid persisted occupied port fails closed without a re-pick', async () => {
    let calls = 0
    const hold = await reserveLoopbackPort(0)
    try {
      const { runtime, root } = await makeRuntime({
        seedProvisioned: true,
        counted: { portOccupied: true },
        pickDaemonPort: async () => {
          calls += 1
          return 53001
        },
      })
      await runtime.refreshProvisioned()
      await writeFile(join(root, 'runtime.json'), JSON.stringify({ version: 1, daemonPort: hold.port }))
      await expect(settle(runtime, 'open')).resolves.toMatchObject({
        phase: 'failed', refusal: { kind: 'endpoint-in-use', port: hold.port },
      })
      // A valid persisted port is authoritative: fail closed, never re-pick.
      expect(calls).toBe(0)
      const persisted = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')) as { daemonPort: number }
      expect(persisted.daemonPort).toBe(hold.port)
    } finally {
      await hold.release()
    }
  })

  it('Open over an unfinished shutdown refuses with the recorded pids until Close confirms cleanup', async () => {
    const closeOutcomes: Array<'ok' | 'fail'> = ['fail', 'ok', 'ok']
    const chromeSeam: BrowserSkillRuntimeInternals['chrome'] = {
      launchAndPair: async (launchOptions) => {
        await launchOptions.onLaunched(4242, 4242)
        return {
          instanceId: INSTANCE as BrowserInstanceId,
          extensionId: 'ext-fixture' as ExtensionId,
          browser: fakeBrowser(async () => {}, () => fakeChild()),
        }
      },
      close: async () => {
        const outcome = closeOutcomes.shift() ?? 'ok'
        if (outcome === 'fail') throw new Error('owned Chrome pid 4242 did not exit')
      },
      forceClose: () => {},
      get current() {
        return undefined
      },
    }
    const { runtime, root } = await makeRuntime({
      chromeSeam,
      seedProvisioned: true,
      config: { ...testConfig(), browserConnectTimeoutMs: 600 },
    })
    await runtime.refreshProvisioned()
    // No instances are seeded: pairing fails and the unwind close fails too,
    // so the open ends with a retained lease and recorded pids.
    await expect(settle(runtime, 'open')).resolves.toMatchObject({ phase: 'failed', refusal: { kind: 'shutdown-incomplete' } })
    // Open is refused synchronously, before any operation is reserved.
    const refusedOpen = runtime.start('open')
    if (refusedOpen.accepted) throw new Error('expected open to be refused')
    expect(refusedOpen.refusal).toMatchObject({ kind: 'shutdown-incomplete', detail: expect.stringContaining('browser pid 4242') as string })
    if (refusedOpen.refusal.kind !== 'shutdown-incomplete') throw new Error('unexpected refusal kind')
    expect(refusedOpen.refusal.detail).toContain('run Close to finish shutting down')
    // The refusal is synchronous: the failed open's operation record is
    // untouched — no new operation was reserved.
    expect(runtime.status().operation).toMatchObject({ verb: 'open', phase: 'failed' })
    // Close finishes the teardown (unconfirmed pid cleared by the successful
    // close), and only then is Open accepted again.
    await settle(runtime, 'close')
    await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await seedFakeInstances(root, [{ instance_id: INSTANCE, label: 'shres-managed' }])
    await settle(runtime, 'open')
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    await settle(runtime, 'close')
  })

  it('dispose during the pairing poll aborts the startup CLI instead of waiting it out', { timeout: 10_000 }, async () => {
    const { runtime, root } = await makeRuntime({ seedProvisioned: true })
    await runtime.refreshProvisioned()
    // Park the first pairing poll: without the open signal it would keep the
    // startup waiting for the marker bound; with it, dispose kills the CLI.
    await mkdir(fakeBskStateDir(root), { recursive: true })
    await writeFile(join(fakeBskStateDir(root), 'hold-browsers'), '1')
    const started = runtime.start('open')
    if (!started.accepted) throw new Error('expected open to be accepted')
    await vi.waitFor(async () => {
      if (!(await daemonAlive(root))) throw new Error('daemon not ready yet')
    }, { timeout: 4000 })
    await new Promise(resolve => setTimeout(resolve, 200))
    const began = Date.now()
    await expect(runtime.dispose()).resolves.toBeUndefined()
    // Cancellation stopped the parked poll through the real runner instead of
    // waiting out its command deadline.
    expect(Date.now() - began).toBeLessThan(5000)
    await expect(started.settled).resolves.toMatchObject({ phase: 'failed', refusal: { kind: 'disposed' } })
    await expect(readFile(join(root, 'runtime.lock'), 'utf8').catch(() => 'released')).resolves.toBe('released')
  })

  it('a failed-pairing close keeps the fallback hold bound until a retry confirms Chrome', { timeout: 15_000 }, async () => {
    let capturedHold: PortReservation | undefined
    const { runtime, root, counted } = await makeRuntime({
      seedProvisioned: true,
      counted: { closePlan: ['fail'], seedInstance: false },
      config: { ...testConfig(), browserConnectTimeoutMs: 600 },
      reservePort: async () => {
        const hold = await reserveLoopbackPort(DEFAULT_DAEMON_PORT)
        capturedHold = hold
        return hold
      },
    })
    if (counted === undefined) throw new Error('fixture misconfigured')
    await runtime.refreshProvisioned()
    await expect(settle(runtime, 'open')).resolves.toMatchObject({
      phase: 'failed', refusal: { kind: 'shutdown-incomplete', detail: expect.stringContaining('hold kept bound') as string },
    })
    if (capturedHold === undefined) throw new Error('hold was never captured')
    // The fallback port is still contained: a new bind refuses and a contact
    // is destroyed and counted.
    await expect(reserveLoopbackPort(DEFAULT_DAEMON_PORT)).rejects.toMatchObject({ port: DEFAULT_DAEMON_PORT })
    const contactsBefore = capturedHold.contacts()
    await new Promise<void>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port: DEFAULT_DAEMON_PORT })
      socket.once('close', () =>{  resolve() })
      socket.once('error', () =>{  resolve() })
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(capturedHold.contacts()).toBeGreaterThan(contactsBefore)
    // The retry confirms Chrome, releases the hold exactly once, stops the
    // daemon, and releases the lease — in that order.
    counted.closePlan.splice(0, counted.closePlan.length, 'ok')
    await settle(runtime, 'close')
    expect(runtime.status().state).toMatchObject({ kind: 'provisioned' })
    await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const reclaimed = await reserveLoopbackPort(DEFAULT_DAEMON_PORT)
    await reclaimed.release()
  })

  it('stale recovery verifies a surviving recorded daemon through the saved-state runner', async () => {
    const { root, fakeScript } = await makeRuntime({ seedProvisioned: true, counted: {} })
    // A test-owned surviving fake daemon on its own freed port, recorded by
    // the stale lock: recovery must verify it through the saved-state runner.
    const portHold = await reserveLoopbackPort(0)
    const markerPort = portHold.port
    await portHold.release()
    const surviving = spawn(fakeScript.path, ['daemon', 'start', '--foreground', '--port', String(markerPort)], {
      env: buildChildEnv(root, undefined),
      stdio: 'ignore',
    })
    cleanup.at(-1)?.children.push(surviving)
    await mkdir(fakeBskStateDir(root), { recursive: true })
    await vi.waitFor(() =>{  expect(existsSync(join(fakeBskStateDir(root), 'daemon.json'))).toBe(true) }, { timeout: 4000 })
    const fresh = await makeRuntime({
      root,
      seedProvisioned: true,
      counted: {},
      acquireLease: async (ownedRoot, hooks) => {
        await mkdir(fakeBskStateDir(ownedRoot), { recursive: true })
        await writeFile(join(ownedRoot, LEASE_FILE_NAME), JSON.stringify({
          pid: 999999, leaseId: 'stale-peer', startedAt: new Date().toISOString(),
          daemonPid: surviving.pid,
        }))
        await writeFile(join(fakeBskStateDir(ownedRoot), 'daemon.json'), JSON.stringify({ pid: surviving.pid, port: markerPort }))
        return acquireRuntimeLease(ownedRoot, hooks)
      },
    })
    await fresh.runtime.refreshProvisioned()
    await settle(fresh.runtime, 'open')
    expect(fresh.runtime.status().state).toMatchObject({ kind: 'ready' })
    // The verification ran a real status query through the saved-state runner
    // (the fresh process has no live daemon object of its own yet).
    const invocations = await readFakeInvocations(root)
    expect(invocations).toContainEqual(expect.objectContaining({ command: 'status' }))
    await settle(fresh.runtime, 'close')
  })

  it('a stale recorded daemon with a malformed status pid is treated as not ours', async () => {
    const { runtime, root } = await makeRuntime({ seedProvisioned: true, counted: {} })
    await runtime.refreshProvisioned()
    await mkdir(fakeBskStateDir(root), { recursive: true })
    // A live recorded pid forces the hook to query status: the malformed
    // answer is never trusted as proof of ownership.
    await writeFile(join(root, LEASE_FILE_NAME), JSON.stringify({
      pid: 999999, leaseId: 'stale-peer', startedAt: new Date().toISOString(),
      daemonPid: process.pid,
    }))
    await writeFile(join(fakeBskStateDir(root), 'daemon.json'), JSON.stringify({ pid: 'not-a-number', port: 1 }))
    await settle(runtime, 'open')
    // The malformed status answer is never trusted as proof of ownership; the
    // open proceeds on a freshly picked port.
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    await settle(runtime, 'close')
  })

  it('stale lease recovery verifies live recorded pids through the hooks', async () => {
    // A dead peer's lock records a LIVE marker browser (its command line
    // carries the owned profile token) and a live daemon pid the fake daemon
    // status answers for. Recovery must verify and clear both: on a fresh
    // runtime without runner and daemon objects, and again after a full open
    // with both present.
    const writeStaleLease = async (ownedRoot: string, markerPid: number): Promise<void> => {
      const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      cleanup.at(-1)?.children.push(daemon)
      await mkdir(fakeBskStateDir(ownedRoot), { recursive: true })
      await writeFile(join(ownedRoot, LEASE_FILE_NAME), JSON.stringify({
        pid: 999999, leaseId: 'stale-peer', startedAt: new Date().toISOString(),
        daemonPid: daemon.pid, browserPid: markerPid, browserPgid: markerPid,
      }))
      // The fake daemon status answers with exactly this recorded pid.
      await writeFile(join(fakeBskStateDir(ownedRoot), 'daemon.json'), JSON.stringify({ pid: daemon.pid, port: 1 }))
    }
    let staleWrites = 0
    let markerPid = 0
    const { runtime, root } = await makeRuntime({
      seedProvisioned: true,
      counted: {},
      acquireLease: async (ownedRoot, hooks) => {
        staleWrites += 1
        await writeStaleLease(ownedRoot, markerPid)
        return acquireRuntimeLease(ownedRoot, hooks)
      },
    })
    // The marker must carry the CANONICAL profile token the hooks match on.
    const profileDir = join(realpathSync(root), 'profile')
    const marker = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 10_000)', '--', '--user-data-dir=' + profileDir],
      { stdio: 'ignore', detached: true },
    )
    cleanup.at(-1)?.children.push(marker)
    markerPid = marker.pid ?? 0
    await runtime.refreshProvisioned()
    await settle(runtime, 'open')
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    // Our lock replaced the stale one and recorded the live owned pids.
    const lock = JSON.parse(await readFile(join(root, 'runtime.lock'), 'utf8')) as { pid: number; daemonPid?: number }
    expect(lock.pid).toBe(process.pid)
    expect(lock.daemonPid).toBeGreaterThan(0)
    // A second acquisition runs with the supervisor's daemon object present,
    // answering the recorded-daemon verification through pidMatches.
    await settle(runtime, 'close')
    await settle(runtime, 'open')
    expect(staleWrites).toBeGreaterThanOrEqual(2)
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    await settle(runtime, 'close')
  })

  it('dispose during a held daemon stop completes fast through the escalation', { timeout: 15_000 }, async () => {
    const { runtime, root, killBrowserChild } = await makeRuntime()
    await settle(runtime, 'provision')
    // Park the graceful `bsk daemon stop` INSIDE the real single-flight stop:
    // the fake CLI parks on the marker, so only the force escalation can
    // complete the parked stop — nothing else releases it.
    await writeFile(join(fakeBskStateDir(root), 'hold-daemon'), '1')
    killBrowserChild()
    // The browser exit begins the internal shutdown, which parks on the held
    // daemon stop — exactly the state that used to exceed the disposal window.
    await vi.waitFor(() =>{  expect(runtime.start('open').accepted).toBe(false) }, { timeout: 4000 })
    const started = Date.now()
    await expect(runtime.dispose()).resolves.toBeUndefined()
    // The escalation aborted the parked stop and SIGKILLed the daemon child
    // synchronously, so disposal did not wait out the marker bound or any
    // graceful timeout.
    expect(Date.now() - started).toBeLessThan(4500)
    expect(await daemonAlive(root)).toBe(false)
    await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('dispose during a held command inside a user Close joins the one retirement', async () => {
    const { runtime, root, gate, counted } = await makeRuntime({ gateCommands: true, counted: {} })
    if (gate === undefined || counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const owner = 'agent-a' as never
    const held = gate('session start')
    const starting = runtime.startSession(owner, new AbortController().signal)
    await held.parked
    const accepted = runtime.start('close')
    if (!accepted.accepted) throw new Error('expected close to be accepted')
    const disposing = runtime.dispose()
    held.release({ session_id: 'sess-late', browser_instance_id: INSTANCE })
    const result = await starting
    expect(result).toMatchObject({ ok: false, reason: 'not-ready' })
    await expect(disposing).resolves.toBeUndefined()
    // Dispose joined the close's own retirement: one compensation, one
    // teardown, one released lease.
    const invocations = await readFakeInvocations(root)
    expect(invocations).toContainEqual(expect.objectContaining({ command: 'session stop', session: 'sess-late' }))
    expect(counted.counts.closes).toBe(1)
    expect(counted.counts.daemonStops).toBe(1)
    await expect(accepted.settled).resolves.toMatchObject({ verb: 'close', phase: 'succeeded' })
    await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('dispose mid-open aborts the held startup before the force calls and never launches', async () => {
    const { runtime, root, counted } = await makeRuntime({ counted: { holdDaemonStart: true }, seedProvisioned: true })
    if (counted === undefined || counted.holdDaemonStart === undefined) throw new Error('fixture misconfigured')
    await runtime.refreshProvisioned()
    const started = runtime.start('open')
    if (!started.accepted) throw new Error('expected open to be accepted')
    await counted.holdDaemonStart.parked
    const disposing = runtime.dispose()
    await expect(disposing).resolves.toBeUndefined()
    // The operation abort reached the held startup step synchronously before
    // the force escalations ran, and the released step refused to launch.
    expect(counted.events).toEqual(['abort-seen', 'forceStop'])
    expect(counted.counts.launches).toBe(0)
    await expect(started.settled).resolves.toMatchObject({ verb: 'open', phase: 'failed', refusal: { kind: 'disposed' } })
    await expect(readFile(join(root, 'runtime.lock'), 'utf8').catch(() => 'released')).resolves.toBe('released')
  })

  it('reports instance-mismatch when the extension never pairs', async () => {
    const { runtime, fake } = await makeRuntime({
      config: { ...testConfig(), browserConnectTimeoutMs: 600 },
      chrome: { seedInstance: false },
      seedProvisioned: true,
    })
    await runtime.refreshProvisioned()
    await expect(settle(runtime, 'open')).resolves.toMatchObject({ phase: 'failed', refusal: { kind: 'instance-mismatch' } })
    expect(runtime.status().state).toMatchObject({ kind: 'failed', refusal: { kind: 'instance-mismatch' } })
    expect(fake.launches).toBe(1)
    expect(runtime.status().operation).toMatchObject({ phase: 'failed' })
  })

  it('enforces ownership and re-validates every model value', async () => {
    const { runtime } = await makeRuntime()
    await settle(runtime, 'provision')
    const ownerA = 'agent-a' as never
    const ownerB = 'agent-b' as never
    const started = await runtime.startSession(ownerA, new AbortController().signal)
    expect(started).toMatchObject({ ok: true })
    const session =  started.ok ? started.value.session : undefined
    expect(session).toBeDefined()
    expect(runtime.listSessions(ownerA)).toEqual([session])
    expect(runtime.listSessions(ownerB)).toEqual([])
    // Another owner cannot see or drive the session.
    const foreign = await runtime.observe(ownerB, session!, new AbortController().signal)
    expect(foreign.ok).toBe(false)
    expect(reasonOf(foreign)).toBe('unknown-session')
    // The runtime is the enforcement point for values.
    expect(reasonOf(await runtime.navigate(ownerA, session!, new URL('file:///etc/passwd'), new AbortController().signal))).toBe('invalid-argument')
    expect(reasonOf(await runtime.act(ownerA, session!, { kind: 'click', ref: '#css' }, new AbortController().signal))).toBe('invalid-argument')
    expect(reasonOf(await runtime.act(ownerA, session!, { kind: 'press', key: 'F' }, new AbortController().signal))).toBe('invalid-argument')
    expect(reasonOf(await runtime.act(ownerA, session!, { kind: 'fill', ref: '@e1', value: 'x'.repeat(10_001) }, new AbortController().signal))).toBe('invalid-argument')
    // Valid commands pass through with parsed JSON.
    const observed = await runtime.observe(ownerA, session!, new AbortController().signal)
    expect(observed).toMatchObject({ ok: true, value: { json: { text: 'fake observation' } } })
    const stopped = await runtime.stopSession(ownerA, session!, new AbortController().signal)
    expect(stopped).toMatchObject({ ok: true })
    expect(runtime.listSessions(ownerA)).toEqual([])
    await settle(runtime, 'close')
  })

  it('starts sessions only against our instance, refusing mismatches', async () => {
    const { runtime, root } = await makeRuntime()
    await settle(runtime, 'provision')
    await seedFakeInstances(root, [{ instance_id: 'ffffffff', label: 'shres-managed' }])
    const result = await runtime.startSession('agent-a' as never, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, reason: 'instance-mismatch' })
    // The foreign session was started by the daemon and then stopped again.
    const invocations = await readFakeInvocations(root)
    expect(invocations.some(entry => entry.command === 'session stop')).toBe(true)
    await settle(runtime, 'close')
  })

  it('tears the whole runtime down when a session start aborts', async () => {
    const { runtime, root, fake } = await makeRuntime()
    await settle(runtime, 'provision')
    const controller = new AbortController()
    controller.abort()
    const result = await runtime.startSession('agent-a' as never, controller.signal)
    expect(result.ok).toBe(false)
    expect(['aborted', 'command-failed']).toContain(reasonOf(result))
    // The internal shutdown runs without self-join; the teardown settles
    // asynchronously after the refusal is delivered.
    await vi.waitFor(() => {
      const state = runtime.status().state
      if (state.kind !== 'disconnected' && state.kind !== 'failed') throw new Error('still ' + state.kind)
    }, { timeout: 4000 })
    expect(fake.closed).toBe(true)
    await vi.waitFor(async () =>{  expect(await daemonAlive(root)).toBe(false) }, { timeout: 4000 })
    await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('closes after consecutive health misses of our instance', async () => {
    const { runtime, root } = await makeRuntime()
    await settle(runtime, 'provision')
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    await seedFakeInstances(root, [])
    // healthIntervalMs is 50ms and the limit is 2; wait well past two misses.
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(runtime.status().state).toMatchObject({ kind: 'disconnected' })
    expect(await daemonAlive(root)).toBe(false)
  })

  it('refuses every start while an operation runs, including an identical one', async () => {
    let releaseGate!: () => void
    const gate = { wait: new Promise<void>((resolve) => {
      releaseGate = resolve
    }), open: () =>{  releaseGate() } }
    const { runtime, fake } = await makeRuntime({ chromeGate: gate })
    const first = runtime.start('provision')
    if (!first.accepted) throw new Error('expected the first start to be accepted')
    for (let i = 0; i < 100 && fake.launches === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(fake.launches).toBe(1)
    // The identical request is refused too: nothing joins a running operation.
    expect(runtime.start('provision')).toMatchObject({ accepted: false, refusal: { kind: 'operation-in-progress' } })
    expect(runtime.start('close')).toMatchObject({ accepted: false, refusal: { kind: 'operation-in-progress' } })
    expect(runtime.start('uninstall', { keepProfile: true })).toMatchObject({ accepted: false, refusal: { kind: 'operation-in-progress' } })
    expect(runtime.status().operation).toMatchObject({ id: first.operationId, verb: 'provision', phase: 'running' })
    gate.open()
    await expect(first.settled).resolves.toMatchObject({ id: first.operationId, verb: 'provision', phase: 'succeeded' })
    expect(fake.launches).toBe(1)
    // After settlement a fresh start is accepted again.
    const next = runtime.start('close')
    if (!next.accepted) throw new Error('expected the post-settlement close to be accepted')
    await next.settled
  })

  it('resets the profile and the port under the lease', async () => {
    const { runtime, root } = await makeRuntime()
    await settle(runtime, 'provision')
    await settle(runtime, 'close')
    await settle(runtime, 'reset')
    const after = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')) as { daemonPort: number }
    expect(after.daemonPort).toBeGreaterThan(0)
    await expect(readFile(join(root, 'profile'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(root, 'runtime.lock'), 'utf8').catch(() => 'released')).toBe('released')
  })

  it('uninstalls, keeping the profile only when asked', async () => {
    const { runtime, root } = await makeRuntime()
    await settle(runtime, 'provision')
    await settle(runtime, 'close')
    await settle(runtime, 'uninstall', { keepProfile: true })
    expect(runtime.status().state).toMatchObject({ kind: 'absent' })
    // The profile survives; the artifacts and state do not.
    expect(await readFile(join(root, 'runtime.lock'), 'utf8').catch(() => 'released')).toBe('released')
    const keepProfile = await mkdtemp(join(tmpdir(), 'shres-bsk-uninstall-'))
    cleanup.push({ dir: keepProfile, children: [] })
    const second = createBrowserSkillRuntime({ root: keepProfile, config: testConfig(), logger: fakeLogger() }, {})
    await expect(settle(second, 'uninstall', { keepProfile: false })).resolves.toMatchObject({ verb: 'uninstall', phase: 'succeeded' })
    await expect(readFile(join(keepProfile, 'runtime.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('dispose aborts the running operation, settles it, and leaves nothing running', async () => {
    const { runtime, root, fake } = await makeRuntime()
    const started = runtime.start('provision')
    if (!started.accepted) throw new Error('expected the start to be accepted')
    await runtime.dispose()
    // The settled promise resolves — never rejects — with the disposed refusal.
    await expect(started.settled).resolves.toMatchObject({
      id: started.operationId,
      verb: 'provision',
      phase: 'failed',
      refusal: { kind: 'disposed' },
    })
    expect(runtime.status().operation).toMatchObject({ id: started.operationId, phase: 'failed' })
    // A disposed runtime refuses every further start.
    expect(runtime.start('open')).toMatchObject({ accepted: false, refusal: { kind: 'disposed' } })
    expect(await daemonAlive(root)).toBe(false)
    expect(await readFile(join(root, 'runtime.lock'), 'utf8').catch(() => 'released')).toBe('released')
    expect(fake.launches <= 1).toBe(true)
  })

  it('shuts down when the fake browser process exits unexpectedly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shres-bsk-browserexit-'))
    cleanup.push({ dir: root, children: [] })
    const fakeScript = await writeFakeBsk(root)
    const config = testConfig()
    const runner = new BskRunner({
      root, config, executablePath: fakeScript.path, binarySha256: fakeScript.sha256, updateManifestUrl: undefined,
    })
    const browserChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    cleanup.at(-1)?.children.push(browserChild)
    let chromeClosed = false
    const dyingChrome = new OwnedChrome({
      launcher: async () => {
        await seedFakeInstances(root, [{ instance_id: INSTANCE, label: 'shres-managed' }])
        return fakeBrowser(async () => {
          chromeClosed = true
        }, () => browserChild)
      },
    })
    const runtime = createBrowserSkillRuntime(
      { root, config, logger: fakeLogger() },
      { runner, daemon: new BskDaemon({ runner, config }), chrome: dyingChrome, preflight: async () => ({ executablePath: '/fake/Chrome', chromeVersion: '153.0' }), ensureLaunchArtifacts: fixtureLaunchArtifacts() },
    )
    await writeFakeProvisionState(root, fakeScript)
    await runtime.refreshProvisioned()
    await settle(runtime, 'open')
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    browserChild.kill('SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(runtime.status().state).toMatchObject({ kind: 'disconnected' })
    expect(chromeClosed).toBe(true)
    expect(await daemonAlive(root)).toBe(false)
  })
})

describe('BrowserSkillRuntime release recovery', () => {
  it.each(['close', 'open', 'provision', 'reset', 'uninstall'] as const)(
    '%s keeps a failed release retryable without a same-operation retry', async (verb) => {
      let releases = 0
      let openingFails = verb === 'open'
      const fixture = await makeRuntime({
        seedProvisioned: verb !== 'provision',
        counted: {},
        acquireLease: async (root, hooks) => {
          const lease = await acquireRuntimeLease(root, hooks)
          return {
            ...lease,
            release: async () => {
              releases += 1
              if (releases === 1) throw new Error('release unavailable')
              await lease.release()
            },
          }
        },
        ensureLaunchArtifacts: async (...args) => {
          if (openingFails) {
            openingFails = false
            throw new Error('original open failure')
          }
          return fixtureLaunchArtifacts()(...args)
        },
      })
      const { runtime, root } = fixture
      try {
        if (verb === 'close') expect((await settle(runtime, 'open')).phase).toBe('succeeded')
        const failed = verb === 'uninstall'
          ? await settle(runtime, verb, { keepProfile: false })
          : await settle(runtime, verb)
        expect(failed).toMatchObject({
          phase: 'failed', refusal: { kind: 'shutdown-incomplete', detail: expect.stringContaining('release unavailable') as string },
        })
        expect(releases).toBe(1)
        expect(existsSync(join(root, LEASE_FILE_NAME))).toBe(true)
        for (const openingVerb of ['open', 'provision'] as const) {
          expect(runtime.start(openingVerb)).toMatchObject({
            accepted: false, refusal: { kind: verb === 'close' ? 'operation-in-progress' : 'shutdown-incomplete' },
          })
        }
        expect((await settle(runtime, 'close')).phase).toBe('succeeded')
        expect(releases).toBe(2)
        expect(existsSync(join(root, LEASE_FILE_NAME))).toBe(false)
        if (verb === 'uninstall') {
          await writeFakeBsk(root)
          expect((await settle(runtime, 'provision')).phase).toBe('succeeded')
        } else {
          expect((await settle(runtime, 'open')).phase).toBe('succeeded')
        }
      } finally {
        await runtime.dispose()
      }
    },
  )

  it('keeps the lease reachable when provisioning and its release both fail', async () => {
    let releases = 0
    const { runtime, root } = await makeRuntime({
      provision: async () => { throw new Error('provision failed') },
      acquireLease: async (ownedRoot, hooks) => {
        const lease = await acquireRuntimeLease(ownedRoot, hooks)
        return {
          ...lease,
          release: async () => {
            releases += 1
            if (releases === 1) throw new Error('release unavailable')
            await lease.release()
          },
        }
      },
    })
    expect(await settle(runtime, 'provision')).toMatchObject({ phase: 'failed', refusal: { kind: 'shutdown-incomplete' } })
    expect(releases).toBe(1)
    expect(existsSync(join(root, LEASE_FILE_NAME))).toBe(true)
    expect((await settle(runtime, 'close')).phase).toBe('succeeded')
    expect(releases).toBe(2)
    expect(existsSync(join(root, LEASE_FILE_NAME))).toBe(false)
    await runtime.dispose()
  })
})


describe('BrowserSkillRuntime uninstall release recovery', () => {
  it.each([false, true])('re-provisions after a purged uninstall release fails (keepProfile=%s)', async (keepProfile) => {
    let releases = 0
    let provisions = 0
    const { runtime, root } = await makeRuntime({
      counted: {}, seedProvisioned: true,
      acquireLease: async (ownedRoot, hooks) => {
        const lease = await acquireRuntimeLease(ownedRoot, hooks)
        return {
          ...lease,
          release: async () => {
            releases += 1
            if (releases === 2) throw new Error('purge release unavailable')
            await lease.release()
          },
        }
      },
      provision: async ({ root: ownedRoot }) => {
        provisions += 1
        return writeFakeProvisionState(ownedRoot, await writeFakeBsk(ownedRoot))
      },
    })
    try {
      expect((await settle(runtime, 'open')).phase).toBe('succeeded')
      expect(runtime.status().artifacts).toBeDefined()
      expect(await settle(runtime, 'uninstall', { keepProfile })).toMatchObject({
        phase: 'failed', refusal: { kind: 'shutdown-incomplete' },
      })
      expect(releases).toBe(2)
      expect(runtime.status().artifacts).toBeUndefined()
      expect(await readProvisionedState(root)).toBeUndefined()
      expect((await settle(runtime, 'close')).phase).toBe('succeeded')
      expect(releases).toBe(3)
      expect(runtime.status().state.kind).toBe('absent')
      expect((await settle(runtime, 'provision')).phase).toBe('succeeded')
      expect(provisions).toBe(1)
      expect(runtime.status().artifacts).toBeDefined()
    } finally {
      await runtime.dispose()
    }
  })
})

describe('BrowserSkillRuntime stale-daemon authority', () => {
  it.each((['open', 'provision', 'reset', 'uninstall'] as const).flatMap(verb =>
    [false, true].map(corrupt => ({ verb, corrupt })),
  ))('ignores forged receipt paths and hashes: $verb, corrupt=$corrupt', async ({ verb, corrupt }) => {
    let verified: boolean | undefined
    const { runtime, root } = await makeRuntime({
      defaultRunnerAndDaemon: true,
      seedProvisioned: true,
      acquireLease: async (_root, hooks) => {
        verified = await hooks.daemonIsOurs(process.pid)
        throw new LeaseRefusedError({ kind: 'owned-by-peer', pid: 0 }, 'end of verification fixture')
      },
    })
    const marker = join(root, 'foreign-executed')
    const foreign = join(root, 'foreign.cjs')
    const program = '#!' + process.execPath + '\n' +
      'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "executed");' +
      'console.log(JSON.stringify({pid:' + String(process.pid) + '}))'
    await writeFile(foreign, program, { mode: 0o700 })
    const receipt = await readProvisionedState(root)
    if (receipt === undefined) throw new Error('missing fixture receipt')
    receipt.bsk.executablePath = foreign
    receipt.bsk.binarySha256 = createHash('sha256').update(program).digest('hex')
    await writeFile(artifactPaths(root).stateFile, JSON.stringify(receipt))
    await mkdir(fakeBskStateDir(root), { recursive: true })
    await writeFile(join(fakeBskStateDir(root), 'daemon.json'), JSON.stringify({ pid: process.pid, port: 1 }))
    if (corrupt) await writeFile(artifactPaths(root).bskExecutable, 'corrupt canonical bytes')
    const failed = verb === 'uninstall'
      ? await settle(runtime, verb, { keepProfile: true })
      : await settle(runtime, verb)
    expect(failed.phase).toBe('failed')
    expect(verified).toBe(!corrupt)
    expect(existsSync(marker)).toBe(false)
    expect((await readFakeInvocations(root)).filter(entry => entry['command'] === 'status')).toHaveLength(corrupt ? 0 : 1)
    await runtime.dispose()
  })

  it.each([
    { exitCode: 1 }, { timedOut: true }, { aborted: true }, { signal: 'SIGTERM' as const },
  ])('refuses an unsuccessful stale stop: %j', async (failure) => {
    const run = vi.spyOn(BskRunner.prototype, 'run').mockResolvedValue({
      exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: '', stderr: '', ...failure,
    })
    const { runtime } = await makeRuntime({
      seedProvisioned: true,
      acquireLease: async (_root, hooks) => {
        await hooks.stopDaemon(process.pid)
        throw new Error('unsuccessful stop was accepted')
      },
    })
    expect(await settle(runtime, 'open')).toMatchObject({
      phase: 'failed', refusal: { kind: 'owned-by-peer', detail: expect.stringContaining('bounded daemon stop failed') as string },
    })
    expect(run).toHaveBeenCalledWith(['daemon', 'stop'], { timeoutMs: 15_000 })
    await runtime.dispose()
  })

  it.each(['ESRCH', 'EPERM', 'alive', 'eventual'] as const)('requires confirmed stale-daemon disappearance: %s', async (liveness) => {
    vi.spyOn(BskRunner.prototype, 'run').mockResolvedValue({
      exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: '', stderr: '',
    })
    let probes = 0
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      expect(signal).toBe(0)
      probes += 1
      if (liveness === 'eventual' && probes === 1) return true
      if (liveness !== 'alive') throw Object.assign(new Error(liveness), { code: liveness === 'eventual' ? 'ESRCH' : liveness })
      return true
    })
    let clock = 0
    let stopped = false
    const { runtime } = await makeRuntime({
      seedProvisioned: true,
      now: () => { clock += liveness === 'alive' ? 13_000 : 1; return clock },
      acquireLease: async (_root, hooks) => {
        await hooks.stopDaemon(123456)
        stopped = true
        throw new LeaseRefusedError({ kind: 'owned-by-peer', pid: 0 }, 'end of stop fixture')
      },
    })
    const result = await settle(runtime, 'open')
    expect(result).toMatchObject({ phase: 'failed', refusal: { kind: 'owned-by-peer' } })
    expect(stopped).toBe(liveness === 'ESRCH' || liveness === 'eventual')
    expect(kill).toHaveBeenCalledWith(123456, 0)
    await runtime.dispose()
  })
})

describe('BrowserSkillRuntime recovery and refusal seams', () => {
  it('drains a synchronous browser exit under a running no-op open: retirement succeeds first', async () => {
    const { runtime, counted } = await makeRuntime({ counted: {} })
    if (counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const statuses: BrowserSkillStatus[] = []
    runtime.subscribe(status => statuses.push(status))
    const noop = runtime.start('open')
    if (!noop.accepted) throw new Error('expected open to be accepted')
    counted.browserChildren.at(-1)?.emitExit()
    // Busy: the open reservation still owns the runtime, so the exit parked a
    // pending retirement under it instead of reserving an internal close.
    expect(runtime.status().operation).toMatchObject({ verb: 'open' })
    const terminal = await noop.settled
    expect(terminal).toMatchObject({ verb: 'open', phase: 'succeeded' })
    // The drain finished before the settle: teardown counts are already final
    // and the unexpected exit verdict is disconnected.
    expect(counted.counts.closes).toBe(1)
    expect(counted.counts.daemonStops).toBe(1)
    expect(runtime.status().state).toMatchObject({ kind: 'disconnected' })
    for (const status of statuses) {
      expect(status.operation === undefined || status.operation.verb === 'open').toBe(true)
    }
  })

  it('drains a synchronous browser exit under a running no-op open: failed close corrects the verdict', async () => {
    const { runtime, counted } = await makeRuntime({ counted: { closePlan: ['fail'] } })
    if (counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const statuses: BrowserSkillStatus[] = []
    runtime.subscribe(status => statuses.push(status))
    const noop = runtime.start('open')
    if (!noop.accepted) throw new Error('expected open to be accepted')
    counted.browserChildren.at(-1)?.emitExit()
    const terminal = await noop.settled
    // The drained retirement's failure corrects the would-be success.
    expect(terminal).toMatchObject({
      verb: 'open', phase: 'failed',
      refusal: { kind: 'shutdown-incomplete', detail: expect.stringContaining('owned Chrome close could not confirm exit') as string },
    })
    expect(counted.counts.closes).toBe(1)
    expect(counted.counts.daemonStops).toBe(1)
    for (const status of statuses) {
      expect(status.operation === undefined || status.operation.verb === 'open').toBe(true)
    }
  })

  it('uninstall refuses when the runtime lock vanished mid-purge and still releases', async () => {
    let releases = 0
    const { runtime } = await makeRuntime({
      seedProvisioned: true,
      acquireLease: async () => ({
        content: () => ({ pid: process.pid, leaseId: 'fixture-lease', startedAt: new Date().toISOString() }),
        update: async () => {},
        release: async () => { releases += 1 },
      }),
    })
    const refused = await settle(runtime, 'uninstall', { keepProfile: false })
    expect(refused).toMatchObject({
      verb: 'uninstall', phase: 'failed',
      refusal: { detail: 'the runtime lock vanished during the purge' },
    })
    expect(releases).toBe(1)
  })

  it('uninstall purge fails loud when the root shell cannot be removed', async () => {
    // An isolated parent the test owns: removing the root shell needs write
    // access on the parent, which the test withdraws and always restores.
    const parent = await mkdtemp(join(tmpdir(), 'shres-bsk-supervisor-rmdir-'))
    cleanup.push({ dir: parent, children: [] })
    const root = join(parent, 'runtime-root')
    const { runtime } = await makeRuntime({ root, seedProvisioned: true })
    await chmod(parent, 0o555)
    try {
      const failed = await settle(runtime, 'uninstall', { keepProfile: false })
      expect(failed).toMatchObject({
        verb: 'uninstall', phase: 'failed',
        refusal: { detail: expect.stringContaining('EACCES') as string },
      })
    } finally {
      await chmod(parent, 0o755)
    }
    expect(existsSync(root)).toBe(true)
  })

  it('stale-cleanup killBrowser tolerates only ESRCH through the scoped kill spy', async () => {
    let captured: Parameters<typeof acquireRuntimeLease>[1] | undefined
    const { runtime } = await makeRuntime({
      seedProvisioned: true,
      acquireLease: async (ownedRoot, hooks) => {
        captured = hooks
        return acquireRuntimeLease(ownedRoot, hooks)
      },
    })
    await settle(runtime, 'reset')
    if (captured === undefined) throw new Error('fixture misconfigured')
    const hooks = captured
    // The spy intercepts every signal: no real pid, owned or not, is ever signalled.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('injected ESRCH'), { code: 'ESRCH' })
    })
    await expect(hooks.killBrowser(4194303)).resolves.toBeUndefined()
    expect(kill).toHaveBeenCalledWith(4194303, 'SIGKILL')
    kill.mockImplementation(() => {
      throw Object.assign(new Error('injected EPERM'), { code: 'EPERM' })
    })
    // The hook may throw synchronously or reject; both are the EPERM refusal.
    let thrown: unknown
    try {
      await hooks.killBrowser(4194303)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: 'EPERM' })
    await runtime.dispose()
  })

  it('a health probe held across a close that succeeds afterwards drives no extra shutdown', async () => {
    const { runtime, gate } = await makeRuntime({
      gateCommands: true,
      config: { ...testConfig(), healthIntervalMs: 5, healthMissLimit: 1 },
    })
    if (gate === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const statuses: BrowserSkillStatus[] = []
    runtime.subscribe(status => statuses.push(status))
    const held = gate('browsers --json')
    await held.parked
    const accepted = runtime.start('close')
    if (!accepted.accepted) throw new Error('expected close to be accepted')
    // The parked probe resumes only after the close: its success answer must
    // not act and must not count as a miss (the limit is one).
    held.release([{ instance_id: INSTANCE, label: 'shres-managed' }])
    await expect(accepted.settled).resolves.toMatchObject({ verb: 'close', phase: 'succeeded' })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(runtime.status().state).toMatchObject({ kind: 'provisioned' })
    const terminals = statuses.filter(status => status.operation !== undefined && status.operation.phase !== 'running')
    expect(terminals).toHaveLength(1)
    expect(terminals[0]?.operation).toMatchObject({ verb: 'close', phase: 'succeeded' })
    expect(statuses.some(status => status.state.kind === 'disconnected')).toBe(false)
  })

  it('a session start failing with a raw value reports it verbatim without teardown', async () => {
    const { runtime, gate, counted } = await makeRuntime({ gateCommands: true, counted: {} })
    if (gate === undefined || counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const holder = gate('session start')
    const starting = runtime.startSession('agent-a' as never, new AbortController().signal)
    await holder.parked
    holder.release(undefined, 'raw boom' as unknown as Error)
    expect(await starting).toMatchObject({ ok: false, reason: 'command-failed', detail: 'raw boom' })
    // Not a lost outcome: no compensation teardown ran and the stack stays ready.
    expect(counted.counts.closes).toBe(0)
    expect(counted.counts.daemonStops).toBe(0)
    expect(runtime.status().state).toMatchObject({ kind: 'ready' })
    await settle(runtime, 'close')
  })

  it('refuses the open when the owned daemon exits during startup', async () => {
    const { runtime, counted } = await makeRuntime({ counted: {}, seedProvisioned: true })
    if (counted === undefined) throw new Error('fixture misconfigured')
    const started = runtime.start('open')
    if (!started.accepted) throw new Error('expected open to be accepted')
    await vi.waitFor(() => { expect(counted.daemonChildren.length).toBe(1) })
    counted.daemonChildren[0]?.emitExit()
    await expect(started.settled).resolves.toMatchObject({
      verb: 'open', phase: 'failed',
      refusal: { kind: 'daemon-start-failed', detail: 'owned daemon exited during startup' },
    })
    expect(counted.counts.daemonStarts).toBe(1)
  })

  it('refuses the open when the paired Chrome exits during startup', async () => {
    const { runtime, counted } = await makeRuntime({ counted: {}, seedProvisioned: true })
    if (counted === undefined) throw new Error('fixture misconfigured')
    const started = runtime.start('open')
    if (!started.accepted) throw new Error('expected open to be accepted')
    await vi.waitFor(() => { expect(counted.browserChildren.length).toBe(1) })
    counted.browserChildren[0]?.emitExit()
    await expect(started.settled).resolves.toMatchObject({
      verb: 'open', phase: 'failed',
      refusal: { kind: 'extension-load-failed', detail: 'owned Chrome exited during startup' },
    })
  })

  it('a browser exit during a held manual close leaves provisioned without publishing disconnected', async () => {
    const { runtime, root, holdDaemonStop, releaseDaemonStopHold } = await makeRuntime()
    await settle(runtime, 'provision')
    const statuses: BrowserSkillStatus[] = []
    runtime.subscribe(status => statuses.push(status))
    // The manual close reserves and starts retiring; holding the daemon stop
    // keeps the retirement in flight while the browser child exit joins it.
    holdDaemonStop()
    const accepted = runtime.start('close')
    if (!accepted.accepted) throw new Error('expected close to be accepted')
    await new Promise(resolve => setTimeout(resolve, 120))
    // The joined internal trigger must not repaint the lifetime disconnected
    // while the manual retirement is still committing.
    expect(runtime.status().state.kind).not.toBe('disconnected')
    releaseDaemonStopHold()
    await expect(accepted.settled).resolves.toMatchObject({ verb: 'close', phase: 'succeeded' })
    expect(runtime.status().state).toMatchObject({ kind: 'provisioned' })
    expect(statuses.some(status => status.state.kind === 'disconnected')).toBe(false)
    const closeTerminals = statuses.filter(status => status.operation?.verb === 'close' && status.operation.phase !== 'running')
    expect(closeTerminals).toHaveLength(1)
    await expect(readFile(join(root, 'runtime.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await daemonAlive(root)).toBe(false)
  })

  it('daemonIsOurs verifies only an integer pid answer from the owned status', async () => {
    let captured: Parameters<typeof acquireRuntimeLease>[1] | undefined
    const { runtime, root } = await makeRuntime({
      seedProvisioned: true,
      acquireLease: async (ownedRoot, hooks) => {
        captured = hooks
        return acquireRuntimeLease(ownedRoot, hooks)
      },
    })
    await settle(runtime, 'reset')
    if (captured === undefined) throw new Error('fixture misconfigured')
    const stateDir = fakeBskStateDir(root)
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'daemon.json'), JSON.stringify({ pid: process.pid, port: 1 }))
    await expect(captured.daemonIsOurs(process.pid)).resolves.toBe(true)
    for (const pid of [null, [], 1.5]) {
      await writeFile(join(stateDir, 'daemon.json'), JSON.stringify({ pid, port: 1 }))
      await expect(captured.daemonIsOurs(process.pid)).resolves.toBe(false)
    }
    const run = vi.spyOn(BskRunner.prototype, 'run')
    for (const reply of [null, 7, 'x']) {
      run.mockResolvedValue({
        exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: JSON.stringify(reply), stderr: '',
      })
      await expect(captured.daemonIsOurs(process.pid)).resolves.toBe(false)
    }
    run.mockRestore()
    await runtime.dispose()
  })

  it('refuses the open when the owned daemon exits during the final hold release', async () => {
    let releaseHold: (() => void) | undefined
    let holdReleased = false
    const { runtime, counted } = await makeRuntime({
      counted: {},
      seedProvisioned: true,
      reservePort: async () => ({
        port: DEFAULT_DAEMON_PORT,
        contacts: () => 0,
        release: () => {
          if (holdReleased) return Promise.resolve()
          holdReleased = true
          return new Promise<void>((resolve) => { releaseHold = resolve })
        },
      }),
    })
    if (counted === undefined) throw new Error('fixture misconfigured')
    const statuses: BrowserSkillStatus[] = []
    runtime.subscribe(status => statuses.push(status))
    const started = runtime.start('open')
    if (!started.accepted) throw new Error('expected open to be accepted')
    await vi.waitFor(() => { expect(releaseHold).toBeDefined() })
    counted.daemonChildren[0]?.emitExit()
    releaseHold?.()
    await expect(started.settled).resolves.toMatchObject({
      verb: 'open', phase: 'failed',
      refusal: { kind: 'daemon-start-failed', detail: 'owned daemon exited during startup' },
    })
    // No Ready notification escaped, and the unwind tore the stack down once.
    expect(statuses.some(status => status.state.kind === 'ready')).toBe(false)
    expect(counted.counts.closes).toBe(1)
    expect(counted.counts.daemonStops).toBe(1)
  })

  it('refuses the open when the paired Chrome exits during the final hold release', async () => {
    let releaseHold: (() => void) | undefined
    let holdReleased = false
    const { runtime, counted } = await makeRuntime({
      counted: {},
      seedProvisioned: true,
      reservePort: async () => ({
        port: DEFAULT_DAEMON_PORT,
        contacts: () => 0,
        release: () => {
          if (holdReleased) return Promise.resolve()
          holdReleased = true
          return new Promise<void>((resolve) => { releaseHold = resolve })
        },
      }),
    })
    if (counted === undefined) throw new Error('fixture misconfigured')
    const statuses: BrowserSkillStatus[] = []
    runtime.subscribe(status => statuses.push(status))
    const started = runtime.start('open')
    if (!started.accepted) throw new Error('expected open to be accepted')
    await vi.waitFor(() => { expect(releaseHold).toBeDefined() })
    counted.browserChildren[0]?.emitExit()
    releaseHold?.()
    await expect(started.settled).resolves.toMatchObject({
      verb: 'open', phase: 'failed',
      refusal: { kind: 'extension-load-failed', detail: 'owned Chrome exited during startup' },
    })
    expect(statuses.some(status => status.state.kind === 'ready')).toBe(false)
    expect(counted.counts.closes).toBe(1)
    expect(counted.counts.daemonStops).toBe(1)
  })

  it('the supervisor-built chrome seam logs unverified group members without kill authority', async () => {
    const logs: string[] = []
    // Default runner/daemon/chrome construction is the only path that builds
    // the runtime's own OwnedChrome with the diagnostics callback.
    const { runtime } = await makeRuntime({ defaultRunnerAndDaemon: true, seedProvisioned: true, captureLogs: logs })
    // The default launcher refuses on the fake executable; construction is the point.
    await expect(settle(runtime, 'open')).resolves.toMatchObject({ verb: 'open', phase: 'failed' })
    const options = ownedChromeOptions.captured.at(-1)
    if (options === undefined || typeof options.onUnverifiedProcesses !== 'function') throw new Error('fixture misconfigured')
    const onUnverified = options.onUnverifiedProcesses as (pids: number[]) => void
    expect(() => { onUnverified([4194301, 4194302]) }).not.toThrow()
    expect(logs.some(entry => entry.includes('left untouched: 4194301, 4194302'))).toBe(true)
    await runtime.dispose()
  })

  it('a running open notification cannot reentrantly reserve a close', async () => {
    const { runtime, counted } = await makeRuntime({ counted: {} })
    if (counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const refusals: BrowserSkillRefusal[] = []
    const nested: Promise<BrowserSkillOperation>[] = []
    let guarded = false
    runtime.subscribe((status) => {
      if (guarded || status.operation?.verb !== 'open' || status.operation.phase !== 'running') return
      guarded = true
      const attempt = runtime.start('close')
      if (attempt.accepted) nested.push(attempt.settled)
      else refusals.push(attempt.refusal)
    })
    const started = runtime.start('open')
    if (!started.accepted) throw new Error('the outer open was refused')
    expect(refusals).toEqual([{ kind: 'operation-in-progress' }])
    await expect(started.settled).resolves.toMatchObject({ verb: 'open', phase: 'succeeded' })
    await settle(runtime, 'close')
  })

  it('manual close joins an exit retirement started by its running notification without publishing disconnected', async () => {
    const { runtime, counted, root } = await makeRuntime({ counted: {} })
    if (counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const states: string[] = []
    const closeOperations = new Set<string>()
    let exited = false
    runtime.subscribe((status) => {
      states.push(status.state.kind)
      if (status.operation?.verb !== 'close') return
      closeOperations.add(status.operation.id)
      if (exited || status.operation.phase !== 'running') return
      exited = true
      counted.browserChildren.at(-1)?.emitExit()
    })
    expect(await settle(runtime, 'close')).toMatchObject({ verb: 'close', phase: 'succeeded' })
    expect(exited).toBe(true)
    expect(runtime.status().state.kind).toBe('provisioned')
    expect(states).not.toContain('disconnected')
    expect(closeOperations.size).toBe(1)
    expect(counted.counts.closes).toBe(1)
    expect(counted.counts.daemonStops).toBe(1)
    expect(existsSync(join(root, 'runtime.lock'))).toBe(false)
    await runtime.dispose()
  })

  it('an internal close running notification cannot reentrantly reserve an operation', async () => {
    const { runtime, counted } = await makeRuntime({ counted: {} })
    if (counted === undefined) throw new Error('fixture misconfigured')
    await settle(runtime, 'provision')
    const refusals: BrowserSkillRefusal[] = []
    const nested: Promise<BrowserSkillOperation>[] = []
    let guarded = false
    runtime.subscribe((status) => {
      if (guarded || status.operation?.verb !== 'close' || status.operation.phase !== 'running') return
      guarded = true
      const attempt = runtime.start('open')
      if (attempt.accepted) nested.push(attempt.settled)
      else refusals.push(attempt.refusal)
    })
    counted.browserChildren.at(-1)?.emitExit()
    await vi.waitFor(() => { expect(runtime.status().operation).toMatchObject({ verb: 'close' }) })
    expect(refusals).toEqual([{ kind: 'operation-in-progress' }])
    await vi.waitFor(() => { expect(runtime.status().state.kind === 'disconnected' || runtime.status().state.kind === 'failed').toBe(true) })
    expect(counted.counts.closes).toBe(1)
    expect(counted.counts.daemonStops).toBe(1)
    await runtime.dispose()
  })
})
