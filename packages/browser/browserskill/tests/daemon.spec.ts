import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { BskRunner } from '../src/runtime/runner.ts'
import { BskDaemon, DaemonPortInUseError, DaemonStartError } from '../src/runtime/daemon.ts'
import { reserveLoopbackPort } from '../src/runtime/endpoints.ts'
import { writeFakeBsk } from './fake-bsk.ts'
import type { ResolvedBrowserSkillConfig } from '../src/config.ts'

const cleanup: string[] = []
const daemons: BskDaemon[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const daemon of daemons.splice(0)) await daemon.stop()
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true })
})

function config(): ResolvedBrowserSkillConfig {
  return {
    artifactBaseUrl: undefined,
    updateManifestUrl: undefined,
    healthIntervalMs: 1_000,
    healthMissLimit: 2,
    commandTimeoutMs: 10_000,
    daemonReadyTimeoutMs: 15_000,
    browserConnectTimeoutMs: 10_000,
    downloadTimeoutMs: 10_000,
    maxDownloadBytes: 1 << 20,
  }
}

async function makeRunner(root: string, executablePath: string, binarySha256: string): Promise<BskRunner> {
  for (const dir of ['home', 'tmp', 'bsk-home']) await mkdir(join(root, dir), { recursive: true })
  return new BskRunner({ root, config: config(), executablePath, binarySha256, updateManifestUrl: undefined })
}

async function makeDaemon(): Promise<{ daemon: BskDaemon; runner: BskRunner; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'shres-bsk-daemon-'))
  cleanup.push(root)
  const script = await writeFakeBsk(root)
  const runner = await makeRunner(root, script.path, script.sha256)
  const daemon = new BskDaemon({ runner, config: config() })
  daemons.push(daemon)
  return { daemon, runner, root }
}

async function freePort(): Promise<number> {
  const hold = await reserveLoopbackPort(0)
  const port = hold.port
  await hold.release()
  return port
}

class FakeDaemonChild extends EventEmitter {
  pid: number | undefined = 123456
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdio = [{ destroy: vi.fn() }]
  stopOn: NodeJS.Signals | undefined = 'SIGKILL'
  kill = vi.fn((signal: NodeJS.Signals) => {
    if (signal === this.stopOn) { this.signalCode = signal; this.emit('exit', null, signal) }
    return true
  })
}

async function fakeDaemon(): Promise<{
  daemon: BskDaemon
  child: FakeDaemonChild
  runner: BskRunner
  run: MockInstance<BskRunner['run']>
  runJson: MockInstance<BskRunner['runJson']>
  spawnLongLived: MockInstance<BskRunner['spawnLongLived']>
  port: number
}> {
  const { runner } = await makeDaemon()
  const child = new FakeDaemonChild()
  const port = await freePort()
  // This process double implements the event, signal and stdio members the daemon owns.
  const spawnLongLived = vi.spyOn(runner, 'spawnLongLived').mockResolvedValue(child as unknown as ChildProcess)
  const runJson = vi.spyOn(runner, 'runJson').mockResolvedValue({ daemonVersion: '0.3.1', wsPort: port, pid: child.pid })
  const run = vi.spyOn(runner, 'run').mockRejectedValue(new Error('graceful request failed'))
  const daemon = new BskDaemon({ runner, config: config() })
  daemons.push(daemon)
  return { daemon, runner, child, port, run, runJson, spawnLongLived }
}

describe('BskDaemon', () => {
  it('does not install a host-exit hook for a spawn that already exited', async () => {
    const { daemon, child, port } = await fakeDaemon()
    child.exitCode = 1
    const before = process.listeners('exit')
    await expect(daemon.start(port, { signal: new AbortController().signal, onSpawned: async () => {} })).rejects.toThrow('exited')
    expect(process.listeners('exit')).toEqual(before)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('aborts an in-flight graceful stop and escalates the same stop exactly once', async () => {
    const { daemon, run, child, port } = await fakeDaemon()
    await daemon.start(port, { signal: new AbortController().signal, onSpawned: async () => {} })
    let commandSignal: AbortSignal | undefined
    run.mockImplementation((_argv, _options, signal) => new Promise((_resolve, reject) => {
      commandSignal = signal
      signal!.addEventListener('abort', () => { reject(signal!.reason as Error) }, { once: true })
    }))
    const stopping = daemon.stop()
    daemon.forceStop()
    daemon.forceStop()
    expect(commandSignal?.aborted).toBe(true)
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(daemon.stop()).toBe(stopping)
    await stopping
    expect(daemon.current).toBeUndefined()
  })

  it('registers a synchronous host-exit backstop and removes it after child exit', async () => {
    const { daemon, child, port } = await fakeDaemon()
    const before = process.listeners('exit')
    await daemon.start(port, { signal: new AbortController().signal, onSpawned: async () => {} })
    const added = process.listeners('exit').filter(listener => !before.includes(listener))
    expect(added).toHaveLength(1)
    added[0]!(0)
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(process.listeners('exit')).not.toContain(added[0])
    added[0]!(0)
    expect(child.kill).toHaveBeenCalledTimes(1)
    await daemon.stop()
  })

  it('skips graceful work when force precedes stop', async () => {
    const { daemon, run, child, port } = await fakeDaemon()
    daemon.forceStop()
    await daemon.start(port, { signal: new AbortController().signal, onSpawned: async () => {} })
    daemon.forceStop()
    daemon.forceStop()
    await daemon.stop()
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(run).not.toHaveBeenCalled()
  })

  it('kills a daemon whose spawn settles after a force request', async () => {
    const { daemon, spawnLongLived, child, port } = await fakeDaemon()
    let release!: (child: ChildProcess) => void
    let spawned!: () => void
    const called = new Promise<void>((resolve) => { spawned = resolve })
    spawnLongLived.mockImplementation(() => { spawned(); return new Promise((resolve) => { release = resolve }) })
    const starting = daemon.start(port, { signal: new AbortController().signal, onSpawned: async () => {} })
    await called
    daemon.forceStop()
    release(child as unknown as ChildProcess)
    await expect(starting).rejects.toThrow()
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(daemon.current).toBeUndefined()
  })

  it('interrupts the SIGTERM grace rather than waiting out its timer', async () => {
    const { daemon, child, port } = await fakeDaemon()
    await daemon.start(port, { signal: new AbortController().signal, onSpawned: async () => {} })
    vi.useFakeTimers()
    const stopping = daemon.stop()
    await vi.advanceTimersByTimeAsync(12_000)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    daemon.forceStop()
    await stopping
    expect(child.kill.mock.calls.map(call => call[0])).toEqual(['SIGTERM', 'SIGKILL'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains ownership after a failed force signal and recovers once the child exits', async () => {
    const { daemon, child, port } = await fakeDaemon()
    await daemon.start(port, { signal: new AbortController().signal, onSpawned: async () => {} })
    child.kill.mockImplementation(() => { throw new Error('signal-denied') })
    vi.useFakeTimers()
    expect(() => { daemon.forceStop() }).not.toThrow()
    const stopped = daemon.stop().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(String(await stopped)).toContain('signal-denied')
    expect(daemon.current?.child).toBe(child)
    child.signalCode = 'SIGKILL'
    child.emit('exit', null, 'SIGKILL')
    await daemon.stop()
    expect(daemon.current).toBeUndefined()
  })

  it('refuses a spawn result without a process identity before recording it', async () => {
    const { daemon, child, port } = await fakeDaemon()
    child.pid = undefined
    child.stopOn = 'SIGTERM'
    const onSpawned = vi.fn(async () => {})
    await expect(daemon.start(port, { signal: new AbortController().signal, onSpawned })).rejects.toThrow('has no pid')
    expect(onSpawned).not.toHaveBeenCalled()
    expect(daemon.current).toBeUndefined()
  })

  it('refuses duplicate starts and a pre-aborted start without a new child', async () => {
    const { daemon, child, spawnLongLived, port } = await fakeDaemon()
    child.stopOn = 'SIGTERM'
    const options = { signal: new AbortController().signal, onSpawned: async () => {} }
    await expect(daemon.start(port, { ...options, signal: AbortSignal.abort(new Error('already cancelled')) })).rejects.toThrow('already cancelled')
    expect(spawnLongLived).not.toHaveBeenCalled()
    await daemon.start(port, options)
    await expect(daemon.start(port, options)).rejects.toThrow('already exists')
    child.exitCode = 0
  })

  it('classifies an asynchronous executable spawn failure', async () => {
    const { daemon, root } = await makeDaemon()
    const script = await writeFakeBsk(root)
    await chmod(script.path, 0o600)
    await expect(daemon.start(await freePort(), {
      signal: new AbortController().signal,
      onSpawned: async () => {},
    })).rejects.toBeInstanceOf(DaemonStartError)
    expect(daemon.current).toBeUndefined()
  })

  it('contains an error emitted by a spawned child before readiness', async () => {
    const { daemon } = await makeDaemon()
    await expect(daemon.start(await freePort(), { signal: new AbortController().signal, onSpawned: async () => {
      daemon.current!.child.emit('error', new Error('child failed after spawn'))
    } })).rejects.toThrow('child failed after spawn')
    expect(daemon.current).toBeUndefined()
  })

  it('does not stop a peer that takes the port after our child exits', async () => {
    const { daemon, child, run, port } = await fakeDaemon()
    let hold: Awaited<ReturnType<typeof reserveLoopbackPort>> | undefined
    try {
      await expect(daemon.start(port, { signal: new AbortController().signal, onSpawned: async () => {
        child.exitCode = 1
        hold = await reserveLoopbackPort(port)
      } })).rejects.toBeInstanceOf(DaemonPortInUseError)
      expect(run).not.toHaveBeenCalled()
      expect(child.kill).not.toHaveBeenCalled()
    } finally { await hold?.release() }
  })

  it('bounds mismatching readiness and cleans up only the owned child', async () => {
    const { daemon, child, runJson, run, port } = await fakeDaemon()
    child.stopOn = 'SIGTERM'
    runJson.mockResolvedValue({ daemonVersion: 'different', wsPort: port, pid: child.pid })
    let recorded!: () => void
    const spawned = new Promise<void>((resolve) => { recorded = resolve })
    vi.useFakeTimers()
    const outcome = daemon.start(port, {
      signal: new AbortController().signal,
      onSpawned: async () => { recorded() },
    }).catch((error: unknown) => error)
    await spawned
    await vi.advanceTimersByTimeAsync(15_000)
    expect(String(await outcome)).toContain('not ready within')
    expect(daemon.current).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  })

  it('records the child before any readiness query and rejects callback failure after exit', async () => {
    const { daemon, runJson, child, port } = await fakeDaemon()
    child.stopOn = 'SIGTERM'
    const failure = new Error('lease write failed')
    await expect(daemon.start(port, { signal: new AbortController().signal, onSpawned: async (pid) => {
      expect(pid).toBe(child.pid)
      expect(runJson).not.toHaveBeenCalled()
      throw failure
    } })).rejects.toBe(failure)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.stdio[0]!.destroy).toHaveBeenCalled()
    expect(daemon.current).toBeUndefined()
  })

  it('aborts readiness promptly without sending an unverified daemon a stop request', async () => {
    const { daemon, runJson, run, child, port } = await fakeDaemon()
    child.stopOn = 'SIGTERM'
    const controller = new AbortController()
    runJson.mockImplementation(async () => { controller.abort(new Error('cancelled startup')); return undefined })
    await expect(daemon.start(port, { signal: controller.signal, onSpawned: async () => {} })).rejects.toThrow('cancelled startup')
    expect(run).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(daemon.current).toBeUndefined()
  })

  it('escalates a failed graceful stop and shares one stop operation', async () => {
    const { daemon, child, port } = await fakeDaemon()
    await daemon.start(port, { signal: new AbortController().signal, onSpawned: async () => {} })
    vi.useFakeTimers()
    const pending = daemon.stop()
    expect(daemon.stop()).toBe(pending)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    await pending
    expect(daemon.current).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the child when every shutdown request fails', async () => {
    const { daemon, child, port } = await fakeDaemon()
    child.stopOn = undefined
    await daemon.start(port, { signal: new AbortController().signal, onSpawned: async () => {} })
    vi.useFakeTimers()
    const outcome = daemon.stop().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(22_000)
    expect(String(await outcome)).toContain('shutdown incomplete')
    expect(daemon.current?.child.pid).toBe(child.pid)
    expect(child.stdio[0]!.destroy).not.toHaveBeenCalled()
    child.signalCode = 'SIGKILL'
    await daemon.stop()
    expect(daemon.current).toBeUndefined()
    expect(child.stdio[0]!.destroy).toHaveBeenCalled()
  })

  it('starts on a port and reports readiness with the exact process', async () => {
    const { daemon } = await makeDaemon()
    const port = await freePort()
    const started = await daemon.start(port, { signal: new AbortController().signal, onSpawned: async () => {} })
    expect(started.child.pid).toBeGreaterThan(0)
    expect(await daemon.pidMatches(started.child.pid!)).toBe(true)
    expect(await daemon.pidMatches(started.child.pid! + 1)).toBe(false)
    await daemon.stop()
    expect(daemon.current).toBeUndefined()
  })

  it('refuses with the typed port error when the port is occupied', async () => {
    const { daemon } = await makeDaemon()
    const hold = await reserveLoopbackPort(0)
    await expect(daemon.start(hold.port, {
      signal: new AbortController().signal,
      onSpawned: async () => {},
    })).rejects.toBeInstanceOf(DaemonPortInUseError)
    await hold.release()
  })

  it('classifies a daemon that exits during startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shres-bsk-daemon-exit-'))
    cleanup.push(root)
    const quitter = join(root, 'quitter.mjs')
    await writeFile(quitter, ['#!' + process.execPath, 'process.exit(9)', ''].join(String.fromCharCode(10)))
    await chmod(quitter, 0o755)
    const realSha = createHash('sha256').update(await readFile(quitter)).digest('hex')
    const runner = await makeRunner(root, quitter, realSha)
    const daemon = new BskDaemon({ runner, config: config() })
    await expect(daemon.start(await freePort(), {
      signal: new AbortController().signal,
      onSpawned: async () => {},
    })).rejects.toBeInstanceOf(DaemonStartError)
  })
})
