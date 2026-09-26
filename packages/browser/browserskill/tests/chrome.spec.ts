/** Owned-browser process and CDP regressions; no browser executable is launched. */
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OwnedChrome, defaultChromeLauncher, type OwnedBrowser, type ExtensionWorker, type CdpSession } from '../src/runtime/chrome.ts'

const external = vi.hoisted(() => ({ ps: vi.fn(), launch: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: external.ps }) }
})
vi.mock('puppeteer-core', () => ({ launch: external.launch }))

const extensionId = 'a'.repeat(32)
const instanceId = 'a1234567'
class BrowserChild extends EventEmitter {
  pid: number | undefined = 123456
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdio = [null, new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough()]
  events: string[] = []
  kill = vi.fn((_signal: NodeJS.Signals) => { this.events.push('kill'); this.exit(); return true })
  exit(): void { this.exitCode = 0; this.events.push('exit'); this.emit('exit', 0, null) }
}

function fixture() {
  // Reacquires the per-test process.kill double installed in beforeEach.
  const kill = vi.spyOn(process, 'kill')
  const child = new BrowserChild()
  const controller = new AbortController()
  const storage: Record<string, unknown> = { bsk_instance_id: instanceId }
  const get = vi.fn(async () => ({ ...storage }))
  const set = vi.fn(async (items: Record<string, unknown>) => { Object.assign(storage, items) })
  vi.stubGlobal('chrome', { storage: { local: { set, get } } })
  const worker: ExtensionWorker = {
    async evaluate<T>(fn: (...args: never[]) => unknown, ...args: unknown[]): Promise<T> {
      return await fn(...args as never[]) as T
    },
  }
  const send = vi.fn<CdpSession['send']>(async () => ({ id: extensionId }))
  const createCDPSession = vi.fn(async () => ({ send }))
  const workerTarget = { worker: vi.fn(async () => worker as ExtensionWorker | null) }
  const waitForTarget = vi.fn<OwnedBrowser['waitForTarget']>(async (predicate) => {
    expect(predicate({ type: () => 'page', url: () => 'chrome-extension://' + extensionId + '/' })).toBe(false)
    expect(predicate({ type: () => 'service_worker', url: () => 'chrome-extension://other/' })).toBe(false)
    expect(predicate({ type: () => 'service_worker', url: () => 'chrome-extension://' + extensionId + '/worker.js' })).toBe(true)
    return workerTarget
  })
  const closeObservers: number[] = []
  const browser = {
    target: () => ({ createCDPSession }), waitForTarget,
    close: vi.fn(async () => { child.events.push('close'); closeObservers.push(child.listenerCount('exit')) }),
    // The double exposes the ChildProcess members used by the browser owner.
    process: vi.fn(() => child as unknown as ChildProcess | null),
  }
  const launcher = vi.fn(async () => browser)
  const onUnverifiedProcesses = vi.fn()
  const owned = new OwnedChrome({ launcher, onUnverifiedProcesses })
  const onLaunched = vi.fn(async (pid: number) => { expect(pid).toBe(child.pid); expect(send).not.toHaveBeenCalled() })
  const options = { executablePath: '/installed/chrome', profileDir: '/owned/profile', env: { HOME: '/owned/home' },
    extensionDir: '/owned/extension', daemonPort: 52801, timeoutMs: 1000, protocolTimeoutMs: 1000,
    signal: controller.signal, onLaunched }
  return {
    owned, child, browser, onUnverifiedProcesses, closeObservers, launcher, worker, workerTarget, createCDPSession, send,
    storage, get, set, controller, options, onLaunched, kill,
  }
}

// Every process here is a double; no test may signal an operating-system pid.
beforeEach(() => {
  external.ps.mockReset().mockResolvedValue({ stdout: '42\n', stderr: '' })
  external.launch.mockReset()
  vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('unexpected OS signal') })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('OwnedChrome', () => {
  it('does not launch after the owner cancels startup before forcing disposal', async () => {
    const f = fixture()
    const cancellation = new AbortController()
    cancellation.abort()
    f.owned.forceClose()
    await expect(f.owned.launchAndPair({ ...f.options, signal: cancellation.signal })).rejects.toThrow()
    expect(f.launcher).not.toHaveBeenCalled()
  })

  it('waits for pending group observation before force-signalling the group', async () => {
    const f = fixture()
    let observed!: () => void
    let release!: (result: { stdout: string; stderr: string }) => void
    const queried = new Promise<void>((resolve) => { observed = resolve })
    external.ps.mockImplementation(async (_path, args: string[]) => {
      if (args.includes('-A')) return { stdout: '1 1\n', stderr: '' }
      observed()
      return new Promise((resolve) => { release = resolve })
    })
    f.kill.mockImplementation(() => { f.child.exit(); return true })
    const opening = f.owned.launchAndPair(f.options)
    await queried
    f.owned.forceClose()
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(f.kill).not.toHaveBeenCalled()
    release({ stdout: String(f.child.pid), stderr: '' })
    await expect(opening).rejects.toThrow()
    expect(f.kill).toHaveBeenCalledExactlyOnceWith(-f.child.pid!, 'SIGKILL')
    expect(f.owned.current).toBeUndefined()
  })

  it('forces the existing graceful close immediately without starting a second close', async () => {
    const f = fixture()
    await f.owned.launchAndPair(f.options)
    let release!: () => void
    f.browser.close.mockImplementation(() => new Promise<void>((resolve) => { release = resolve }))
    const closing = f.owned.close()
    f.owned.forceClose()
    f.owned.forceClose()
    expect(f.child.kill).toHaveBeenCalledTimes(1)
    expect(f.owned.close()).toBe(closing)
    await closing
    expect(f.browser.close).toHaveBeenCalledTimes(1)
    expect(f.owned.current).toBeUndefined()
    release()
  })

  it('force-kills an unreaped observed group but never signals it after exit', async () => {
    const f = fixture()
    external.ps.mockImplementation(async (_path, args: string[]) => ({ stdout: args.includes('-A') ? '1 1\n' : String(f.child.pid), stderr: '' }))
    f.kill.mockImplementation(() => { f.child.exit(); return true })
    await f.owned.launchAndPair(f.options)
    f.owned.forceClose()
    f.owned.forceClose()
    expect(f.kill).toHaveBeenCalledExactlyOnceWith(-f.child.pid!, 'SIGKILL')
    await f.owned.close()
    expect(f.browser.close).not.toHaveBeenCalled()
    expect(f.owned.current).toBeUndefined()
  })

  it('does not signal an already-reaped Chrome during forced cleanup', async () => {
    const f = fixture()
    await f.owned.launchAndPair(f.options)
    f.child.exit()
    f.owned.forceClose()
    await f.owned.close()
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(f.kill).not.toHaveBeenCalled()
  })

  it('contains a force-signal failure and permits a later close retry', async () => {
    const f = fixture()
    await f.owned.launchAndPair(f.options)
    f.child.kill.mockImplementation(() => { throw new Error('signal-denied') })
    expect(() => { f.owned.forceClose() }).not.toThrow()
    await expect(f.owned.close()).rejects.toThrow('signal-denied')
    expect(f.owned.current).toBe(f.browser)
    f.child.exit()
    await f.owned.close()
    expect(f.owned.current).toBeUndefined()
  })

  it('terminates a launch that resolves after force was requested', async () => {
    const f = fixture()
    let release!: (browser: typeof f.browser) => void
    f.launcher.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const opening = f.owned.launchAndPair(f.options)
    await vi.waitFor(() => { expect(f.launcher).toHaveBeenCalledTimes(1) })
    f.owned.forceClose()
    release(f.browser)
    await expect(opening).rejects.toThrow()
    expect(f.child.kill).toHaveBeenCalledTimes(1)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.owned.current).toBeUndefined()
  })

  it.each(['no-child', 'no-pid', 'host-pid'])('does not force-signal an unconfirmed %s identity', async (mode) => {
    const f = fixture()
    if (mode === 'no-child') f.browser.process.mockReturnValue(null)
    if (mode === 'no-pid') f.child.pid = undefined
    if (mode === 'host-pid') f.child.pid = process.pid
    await expect(f.owned.launchAndPair(f.options)).rejects.toThrow('shutdown incomplete')
    f.owned.forceClose()
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(f.kill).not.toHaveBeenCalled()
  })

  it('releases a reused group and reports unverified members without signalling them', async () => {
    const f = fixture()
    external.ps.mockImplementation(async (_path, args: string[]) => ({
      stdout: args.includes('-A') ? '123457 123456\n' : args.includes('-ww') ? '/foreign-process --unrelated' : String(f.child.pid), stderr: '',
    }))
    await f.owned.launchAndPair(f.options)
    f.browser.close.mockImplementation(async () => { f.child.exit() })
    await f.owned.close()
    expect(f.onUnverifiedProcesses).toHaveBeenCalledWith([123457])
    expect(f.kill).not.toHaveBeenCalled()
    expect(f.owned.current).toBeUndefined()
  })

  it('uses the default launcher when no override is supplied', async () => {
    const f = fixture()
    external.launch.mockResolvedValue(f.browser)
    const owned = new OwnedChrome({})
    await owned.launchAndPair(f.options)
    expect(external.launch).toHaveBeenCalledTimes(1)
    await owned.close()
  })

  it('reports launcher failure without claiming to own a browser', async () => {
    const f = fixture()
    f.launcher.mockRejectedValue(new Error('executable unavailable'))
    await expect(f.owned.launchAndPair(f.options)).rejects.toThrow('executable unavailable')
    expect(f.owned.current).toBeUndefined()
  })

  it.each(['no-child', 'no-pid', 'host-pid'])('refuses %s without signalling an unrelated process', async (mode) => {
    const f = fixture()
    if (mode === 'no-child') f.browser.process.mockReturnValue(null)
    if (mode === 'no-pid') f.child.pid = undefined
    if (mode === 'host-pid') f.child.pid = process.pid
    await expect(f.owned.launchAndPair(f.options)).rejects.toThrow('shutdown incomplete')
    expect(f.onLaunched).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(f.kill).not.toHaveBeenCalled()
  })

  it('contains a child error and refuses a child that exits during pairing', async () => {
    const f = fixture()
    f.get.mockImplementation(async () => { f.child.emit('error', new Error('child failure')); return { ...f.storage } })
    await expect(f.owned.launchAndPair(f.options)).rejects.toThrow('child failure')
    expect(() => f.child.emit('error', new Error('late failure'))).not.toThrow()
    const exited = fixture()
    exited.child.exit()
    await expect(exited.owned.launchAndPair(exited.options)).rejects.toThrow('Chrome exited')
    expect(exited.owned.current).toBeUndefined()
  })

  it('refuses a non-object extension reply', async () => {
    const f = fixture()
    f.send.mockResolvedValue(null)
    await expect(f.owned.launchAndPair(f.options)).rejects.toThrow('no extension id')
  })

  it('preserves both setup and cleanup failures while retaining the browser', async () => {
    const f = fixture()
    f.send.mockRejectedValue(new Error('setup failed'))
    f.child.kill.mockReturnValue(true)
    vi.useFakeTimers()
    const result = f.owned.launchAndPair(f.options).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5000)
    const failure = await result
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors.map(String)).toEqual([expect.stringContaining('setup failed'), expect.stringContaining('shutdown incomplete')])
    expect(f.owned.current).toBe(f.browser)
    f.child.exit()
    await f.owned.close()
  })

  it.each(['ESRCH', 'EPERM'])('handles group signal error %s without losing ownership', async (code) => {
    const f = fixture()
    external.ps.mockImplementation(async (_path, args: string[]) => ({ stdout: args.includes('-A') ? '1 1\n' : String(f.child.pid), stderr: '' }))
    await f.owned.launchAndPair(f.options)
    f.kill.mockImplementation(() => {
      if (code === 'ESRCH') queueMicrotask(() => { f.child.exit() })
      throw Object.assign(new Error('signal refused'), { code })
    })
    if (code === 'ESRCH') {
      await f.owned.close()
      expect(f.owned.current).toBeUndefined()
    } else {
      await expect(f.owned.close()).rejects.toThrow('shutdown incomplete')
      expect(f.owned.current).toBe(f.browser)
      f.child.exit()
      await f.owned.close()
    }
  })

  it('never signals marked group members after graceful leader exit', async () => {
    const f = fixture()
    let membersRemain = true
    external.ps.mockImplementation(async (_path, args: string[]) => ({
      stdout: args.includes('-A') ? (membersRemain ? '123457 123456\n' : '1 1\n') : args.includes('-ww') ? '/chrome --user-data-dir=/owned/profile' : String(f.child.pid), stderr: '',
    }))
    await f.owned.launchAndPair(f.options)
    expect(f.onLaunched).toHaveBeenCalledWith(f.child.pid, f.child.pid)
    f.browser.close.mockImplementation(async () => { if (f.child.exitCode === null) f.child.exit() })
    vi.useFakeTimers()
    const failed = f.owned.close().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5000)
    expect(String(await failed)).toContain('123457')
    expect(f.owned.current).toBe(f.browser)
    expect(f.kill).not.toHaveBeenCalled()
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(f.child.stdio[1]?.destroyed).toBe(true)
    membersRemain = false
    await f.owned.close()
    expect(f.owned.current).toBeUndefined()
    expect(f.kill).not.toHaveBeenCalled()
  })

  it('retains ownership when group membership cannot be read after exit', async () => {
    const f = fixture()
    external.ps.mockImplementation(async (_path, args: string[]) => {
      if (args.includes('-A')) throw new Error('query denied')
      return { stdout: String(f.child.pid), stderr: '' }
    })
    await f.owned.launchAndPair(f.options)
    f.browser.close.mockImplementation(async () => { f.child.exit() })
    await expect(f.owned.close()).rejects.toThrow('cannot verify recorded Chrome group')
    expect(f.owned.current).toBe(f.browser)
    expect(f.kill).not.toHaveBeenCalled()
    external.ps.mockResolvedValue({ stdout: '1 1\n', stderr: '' })
    await f.owned.close()
  })

  it('records the pid before CDP and forces a leader when close resolves without exit', async () => {
    const f = fixture()
    const paired = await f.owned.launchAndPair(f.options)
    expect(paired).toMatchObject({ instanceId, extensionId })
    expect(f.onLaunched).toHaveBeenCalledTimes(1)
    expect(f.send).toHaveBeenCalledWith('Extensions.loadUnpacked', { path: '/owned/extension' })
    expect(f.storage).toMatchObject({ bsk_daemon_port: 52801, bh_label: 'shres-managed' })
    const closed = f.owned.close()
    expect(f.owned.close()).toBe(closed)
    await closed
    expect(f.child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(f.kill).not.toHaveBeenCalled()
    expect(f.child.events).toEqual(['close', 'kill', 'exit'])
    expect(f.closeObservers[0]).toBe(1)
    expect(f.child.stdio.slice(1).every(stream => stream?.destroyed)).toBe(true)
    expect(f.owned.current).toBeUndefined()
    await f.owned.close()
  })

  it('uses only the leader when process-group observation fails', async () => {
    const f = fixture()
    external.ps.mockRejectedValue(new Error('ps unavailable'))
    await f.owned.launchAndPair(f.options)
    await f.owned.close()
    expect(f.child.kill).toHaveBeenCalledTimes(1)
    expect(f.kill).not.toHaveBeenCalled()
  })

  it('force-stops an observed live group after a hanging close', async () => {
    const f = fixture()
    external.ps.mockImplementation(async (_path, args: string[]) => ({ stdout: args.includes('-A') ? '1 1\n' : String(f.child.pid), stderr: '' }))
    f.kill.mockImplementation((pid) => { expect(pid).toBe(-f.child.pid!); f.child.exit(); return true })
    await f.owned.launchAndPair(f.options)
    f.browser.close.mockImplementation(() => new Promise(() => {}))
    vi.useFakeTimers()
    const closed = f.owned.close()
    await vi.advanceTimersByTimeAsync(10_000)
    await closed
    expect(f.kill).toHaveBeenCalledWith(-f.child.pid!, 'SIGKILL')
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the browser and pipes when exit cannot be confirmed, then permits retry', async () => {
    const f = fixture()
    await f.owned.launchAndPair(f.options)
    f.child.kill.mockReturnValue(true)
    vi.useFakeTimers()
    const failed = f.owned.close().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5000)
    expect(String(await failed)).toContain('shutdown incomplete')
    expect(f.owned.current).toBe(f.browser)
    expect(f.child.stdio[1]?.destroyed).toBe(false)
    f.child.exit()
    await f.owned.close()
    expect(f.owned.current).toBeUndefined()
    expect(f.child.stdio[1]?.destroyed).toBe(true)
  })

  it('closes a browser returned after cancellation without sending a CDP command', async () => {
    const f = fixture()
    f.launcher.mockImplementation(async () => { f.controller.abort(); return f.browser })
    await expect(f.owned.launchAndPair(f.options)).rejects.toThrow('aborted')
    expect(f.onLaunched).toHaveBeenCalledTimes(1)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.owned.current).toBeUndefined()
  })

  it('does not launch for a pre-aborted request and refuses a duplicate lifetime', async () => {
    const f = fixture()
    await expect(f.owned.launchAndPair({ ...f.options, signal: AbortSignal.abort() })).rejects.toThrow()
    expect(f.launcher).not.toHaveBeenCalled()
    await f.owned.launchAndPair(f.options)
    await expect(f.owned.launchAndPair(f.options)).rejects.toThrow('already exists')
    await f.owned.close()
  })

  it('closes on failed PID persistence before loading the extension', async () => {
    const f = fixture()
    const failure = new Error('lease write failed')
    f.onLaunched.mockRejectedValue(failure)
    await expect(f.owned.launchAndPair(f.options)).rejects.toBe(failure)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.owned.current).toBeUndefined()
  })

  it.each(['bad-id', 'missing-worker', 'wrong-port', 'cdp-error'])('closes after %s during pairing', async (failure) => {
    const f = fixture()
    if (failure === 'bad-id') f.send.mockResolvedValue({ id: 'bad' })
    if (failure === 'missing-worker') f.workerTarget.worker.mockResolvedValue(null)
    if (failure === 'wrong-port') f.get.mockResolvedValue({ bsk_daemon_port: 7 })
    if (failure === 'cdp-error') f.send.mockRejectedValue(new Error('CDP unavailable'))
    await expect(f.owned.launchAndPair(f.options)).rejects.toThrow()
    expect(f.owned.current).toBeUndefined()
    expect(f.child.kill).toHaveBeenCalledTimes(1)
  })

  it('bounds a hung CDP operation and contains a late rejection', async () => {
    const f = fixture()
    let reject!: (error: Error) => void
    f.send.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    vi.useFakeTimers()
    const result = f.owned.launchAndPair(f.options).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1000)
    expect(String(await result)).toMatch(/timed out|aborted/)
    reject(new Error('late CDP failure'))
    expect(f.owned.current).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('polls for the instance id under the shared connect deadline', async () => {
    const f = fixture()
    delete f.storage.bsk_instance_id
    vi.useFakeTimers()
    const result = f.owned.launchAndPair(f.options)
    await vi.advanceTimersByTimeAsync(250)
    f.storage.bsk_instance_id = instanceId
    await vi.advanceTimersByTimeAsync(250)
    expect((await result).instanceId).toBe(instanceId)
    await f.owned.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports the owned profile lock without removing it', async () => {
    const f = fixture()
    f.launcher.mockRejectedValue(new Error('ProcessSingleton failed'))
    await expect(f.owned.launchAndPair(f.options)).rejects.toThrow('/owned/profile/SingletonLock')
    expect(f.owned.current).toBeUndefined()
    expect(f.kill).not.toHaveBeenCalled()
  })

  it('passes pipe isolation and host-owned signal handling to Puppeteer', async () => {
    const f = fixture()
    external.launch.mockResolvedValue(f.browser)
    await defaultChromeLauncher({ executablePath: '/installed/chrome', userDataDir: '/owned/profile', env: {}, timeoutMs: 1000, protocolTimeoutMs: 1000 })
    expect(external.launch).toHaveBeenCalledWith(expect.objectContaining({ pipe: true, headless: false, enableExtensions: true,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, userDataDir: '/owned/profile' }))
  })
})
