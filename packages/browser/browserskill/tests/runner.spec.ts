import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter, once } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
import {
  argv,
  BskCommandError,
  BskRunner,
  BskWireError,
  buildChildEnv,
  parseBrowsers,
  parseDaemonStatus,
  parseSessionStart,
  observedChildError,
} from '../src/runtime/runner.ts'
import { writeFakeBsk } from './fake-bsk.ts'

const cleanup: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const dir of cleanup.splice(0)) {
    try {
      const pid = Number(await readFile(join(dir, 'tmp', 'pipe-holder.pid'), 'utf8'))
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ESRCH') throw error
    }
    await rm(dir, { recursive: true, force: true })
  }
})

async function ownedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'shres-bsk-runner-'))
  cleanup.push(root)
  for (const dir of ['home', 'tmp', 'bsk-home']) await mkdir(join(root, dir), { recursive: true })
  return root
}

const testConfig = {
  artifactBaseUrl: undefined,
  updateManifestUrl: undefined,
  healthIntervalMs: 1_000,
  healthMissLimit: 2,
  commandTimeoutMs: 10_000,
  daemonReadyTimeoutMs: 10_000,
  browserConnectTimeoutMs: 10_000,
  downloadTimeoutMs: 10_000,
  maxDownloadBytes: 1 << 20,
} as const

function makeRunner(root: string, script: { path: string; sha256: string }): BskRunner {
  return new BskRunner({ root, config: testConfig, executablePath: script.path, binarySha256: script.sha256, updateManifestUrl: undefined })
}

/** A runner pointed at an arbitrary executable, pinned to its real hash. */
async function makeExecutableRunner(root: string, executablePath: string): Promise<BskRunner> {
  const { createHash } = await import('node:crypto')
  const sha256 = createHash('sha256').update(await readFile(executablePath)).digest('hex')
  return new BskRunner({ root, config: testConfig, executablePath, binarySha256: sha256, updateManifestUrl: undefined })
}

async function scriptRunner(root: string, source: string): Promise<BskRunner> {
  const path = join(root, 'command.mjs')
  await writeFile(path, ['#!' + process.execPath, source, ''].join(String.fromCharCode(10)))
  await chmod(path, 0o700)
  return makeExecutableRunner(root, path)
}

class FakeCommandChild extends EventEmitter {
  pid = 123456
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdio = [null, this.stdout, this.stderr]
  kill = vi.fn(() => true)
  exit(): void { this.exitCode = 0; this.emit('exit', 0, null) }
}

describe('BskRunner', () => {
  it('bounds a child that cannot exit after oversized output and repeated stop requests', async () => {
    const root = await ownedRoot()
    const runner = await scriptRunner(root, '')
    const child = new FakeCommandChild()
    const controller = new AbortController()
    let spawned!: () => void
    const started = new Promise<void>((resolve) => { spawned = resolve })
    vi.mocked(spawn).mockImplementationOnce(() => {
      spawned()
      queueMicrotask(() => { child.stdout.emit('data', Buffer.alloc((1 << 20) + 1)); controller.abort() })
      // Process boundary double: only the pid, stream and event API is used.
      return child as unknown as ReturnType<typeof spawn>
    })
    vi.useFakeTimers()
    const outcome = runner.run([], undefined, controller.signal).catch((error: unknown) => error)
    await started
    await vi.advanceTimersByTimeAsync(2000)
    expect(String(await outcome)).toContain('command output exceeds')
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.stdout.destroyed).toBe(true)
    expect(() => child.emit('error', new Error('late error'))).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('contains an error after spawn and an abort delivered during spawn', async () => {
    const root = await ownedRoot()
    const runner = await scriptRunner(root, '')
    const failed = new FakeCommandChild()
    failed.kill.mockImplementation(() => { failed.exit(); failed.emit('close'); return true })
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => failed.emit('error', new Error('signal failed')))
      return failed as unknown as ChildProcess
    })
    await expect(runner.run([])).rejects.toThrow('signal failed')
    const child = new FakeCommandChild()
    child.kill.mockImplementation(() => { child.exit(); child.emit('close'); return true })
    const controller = new AbortController()
    vi.mocked(spawn).mockImplementationOnce(() => { controller.abort(); return child as unknown as ChildProcess })
    await expect(runner.run([], undefined, controller.signal)).resolves.toMatchObject({ aborted: true })
  })

  it('refuses overflow received after process exit while awaiting pipe closure', async () => {
    const root = await ownedRoot()
    const runner = await scriptRunner(root, '')
    const child = new FakeCommandChild()
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => { child.exit(); child.stdout.emit('data', Buffer.alloc((1 << 20) + 1)); child.emit('close') })
      return child as unknown as ChildProcess
    })
    await expect(runner.run([])).rejects.toThrow('command output exceeds')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('contains asynchronous spawn failures for commands and long-lived children', async () => {
    const root = await ownedRoot()
    const runner = await scriptRunner(root, '')
    await chmod(join(root, 'command.mjs'), 0o600)
    await expect(runner.run([])).rejects.toBeInstanceOf(BskCommandError)
    await expect(runner.spawnLongLived([])).rejects.toBeInstanceOf(BskCommandError)
  })

  it('does not spawn on cancellation before or during executable verification', async () => {
    const root = await ownedRoot()
    const runner = await scriptRunner(root, 'throw new Error("must not run")')
    const preAborted = AbortSignal.abort()
    await expect(runner.run([], undefined, preAborted)).resolves.toMatchObject({ aborted: true, stdout: '' })
    const controller = new AbortController()
    const verify = runner.verifyExecutable.bind(runner)
    vi.spyOn(runner, 'verifyExecutable').mockImplementation(async () => { await verify(); controller.abort() })
    await expect(runner.run([], undefined, controller.signal)).resolves.toMatchObject({ aborted: true, stdout: '' })
  })

  it('retains an exact byte-bound reply and rejects a larger complete reply', async () => {
    const root = await ownedRoot()
    const exact = await scriptRunner(root, 'process.stdout.write("x".repeat(1 << 20))')
    expect((await exact.run([])).stdout).toHaveLength(1 << 20)
    const oversized = await scriptRunner(root, 'process.stdout.write(JSON.stringify("😀".repeat(300000)))')
    const parse = vi.fn()
    await expect(oversized.runJson([], parse)).rejects.toThrow('command output exceeds 1048576 bytes')
    expect(parse).not.toHaveBeenCalled()
    const combined = await scriptRunner(root, 'process.stdout.write("x".repeat(700000)); process.stderr.write("y".repeat(700000))')
    await expect(combined.run([])).rejects.toBeInstanceOf(BskWireError)
  })

  it('settles after exit even when a descendant retains the output pipes', async () => {
    const root = await ownedRoot()
    const runner = await scriptRunner(root, [
      'import { spawn } from "node:child_process"',
      'import { writeFileSync } from "node:fs"',
      'import { join } from "node:path"',
      'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: ["ignore", 1, 2] })',
      'writeFileSync(join(process.env.TMPDIR, "pipe-holder.pid"), String(child.pid))',
      'process.stdout.write("complete")',
      'child.unref()',
    ].join(String.fromCharCode(10)))
    const started = Date.now()
    const result = await runner.run([])
    expect(result).toMatchObject({ exitCode: 0, stdout: 'complete', timedOut: false })
    expect(Date.now() - started).toBeLessThan(5000)
  }, 8000)

  it('observes errors after a long-lived child has spawned', async () => {
    const root = await ownedRoot()
    const runner = await scriptRunner(root, 'setTimeout(() => {}, 30000)')
    const child = await runner.spawnLongLived([])
    expect(observedChildError(child)).toBeUndefined()
    const failure = new Error('simulated child error')
    child.emit('error', failure)
    expect(observedChildError(child)).toBe(failure)
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  })

  it('reports a nonzero command without fabricated stderr', async () => {
    const root = await ownedRoot()
    const runner = await scriptRunner(root, 'process.exit(2)')
    await expect(runner.runJson([], value => value)).rejects.toMatchObject({ name: 'BskCommandError', result: { exitCode: 2, stderr: '' } })
  })

  it('refuses non-finite numbers parsed from process JSON', async () => {
    const root = await ownedRoot()
    const runner = await scriptRunner(root, 'process.stdout.write("1e999")')
    await expect(runner.runJson([], value => value)).rejects.toThrow('non-JSON-compatible')
  })

  it('runs a command and parses its JSON reply', async () => {
    const root = await ownedRoot()
    const script = await writeFakeBsk(root)
    const runner = makeRunner(root, script)
    const browsers = await runner.runJson(argv.browsers(), parseBrowsers)
    expect(browsers).toEqual([])
  })

  it('fails closed on an executable hash mismatch before spawning', async () => {
    const root = await ownedRoot()
    const script = await writeFakeBsk(root)
    await writeFile(join(root, 'tampered'), 'x')
    const runner = makeRunner(root, { path: script.path, sha256: '0'.repeat(64) })
    await expect(runner.runJson(argv.browsers(), parseBrowsers)).rejects.toThrow(/hash mismatch/)
    // Nothing ran: the fake keeps no state when the hash gate refuses first.
    await expect(readFile(join(root, 'bsk-home', '.fake-bsk', 'invocations.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('builds the explicit environment with no inherited ambient variables', async () => {
    const env = buildChildEnv('/owned/root', undefined)
    expect(env).toMatchObject({
      HOME: '/owned/root/home',
      TMPDIR: '/owned/root/tmp',
      BSK_HOME: '/owned/root/bsk-home',
      BSK_AUTO_START: '0',
      BSK_AUTO_UPDATE: 'off',
    })
    expect(env.BSK_UPDATE_MANIFEST_URL).toBeUndefined()
    expect(buildChildEnv('/owned/root', 'http://127.0.0.1:9/version.json').BSK_UPDATE_MANIFEST_URL)
      .toBe('http://127.0.0.1:9/version.json')
    expect(Object.keys(env).sort()).toEqual(['PATH', 'HOME', 'TMPDIR', 'BSK_HOME', 'BSK_AUTO_START', 'BSK_AUTO_UPDATE'].sort())
  })

  it('kills the child on the deadline and reports the orthogonal outcomes', async () => {
    const root = await ownedRoot()
    const sleeper = join(root, 'sleeper.mjs')
    await writeFile(sleeper, `#!${process.execPath}\nsetTimeout(() => {}, 60_000)\n`)
    await chmod(sleeper, 0o755)
    const sleeperRunner = await makeExecutableRunner(root, sleeper)
    const error = await sleeperRunner.runJson([], parseDaemonStatus, { timeoutMs: 500 }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(BskCommandError)
    expect((error as BskCommandError).result?.timedOut).toBe(true)
    expect((error as BskCommandError).result?.exitCode).toBeNull()
  })

  it('kills the child on caller abort and reports it', async () => {
    const root = await ownedRoot()
    const sleeper = join(root, 'sleeper.mjs')
    await writeFile(sleeper, `#!${process.execPath}\nsetTimeout(() => {}, 60_000)\n`)
    await chmod(sleeper, 0o755)
    const sleeperRunner = await makeExecutableRunner(root, sleeper)
    const controller = new AbortController()
    const pending = sleeperRunner.runJson([], parseDaemonStatus, { timeoutMs: 30_000 }, controller.signal)
    setTimeout(() => { controller.abort() }, 300)
    const error = await pending.catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(BskCommandError)
    expect((error as BskCommandError).result?.aborted).toBe(true)
  })

  it('raises a wire error on invalid JSON', async () => {
    const root = await ownedRoot()
    const printer = join(root, 'printer.mjs')
    await writeFile(printer, `#!${process.execPath}\nprocess.stdout.write("not json")\n`)
    await chmod(printer, 0o755)
    const printerRunner = await makeExecutableRunner(root, printer)
    await expect(printerRunner.runJson([], parseDaemonStatus)).rejects.toBeInstanceOf(BskWireError)
  })

  it('raises a command error on nonzero exit with the stderr tail', async () => {
    const root = await ownedRoot()
    const script = await writeFakeBsk(root)
    const runner = makeRunner(root, script)
    const error = await runner.runJson(argv.status(), parseDaemonStatus).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(BskCommandError)
    expect((error as BskCommandError).result?.exitCode).toBe(1)
    expect((error as BskCommandError).message).toContain('no daemon')
  })

  it('validates the wire replies at the parse point', () => {
    expect(() => parseDaemonStatus({ daemon_version: '0.3.1', pid: '7', ws_port: 52_800 })).toThrow(BskWireError)
    expect(() => parseBrowsers({ nope: true })).toThrow(BskWireError)
    expect(parseBrowsers([{ instance_id: 'abcd1234', label: 'owned' }])).toEqual([{ instanceId: 'abcd1234', label: 'owned' }])
    expect(() => parseBrowsers([null])).toThrow(BskWireError)
    expect(() => parseDaemonStatus({ daemon_version: '0.3.1', pid: '4', ws_port: 52800 })).toThrow(BskWireError)
    expect(() => parseDaemonStatus({ daemon_version: '0.3.1', pid: 1.5, ws_port: 52800 })).toThrow(BskWireError)
    expect(parseDaemonStatus({ daemon_version: '0.3.1', pid: 4, ws_port: 52800 })).toEqual({ daemonVersion: '0.3.1', pid: 4, wsPort: 52800 })
    expect(() => parseSessionStart({ session_id: 's' })).toThrow(BskWireError)
    expect(parseSessionStart({ session_id: 's1', browser_instance_id: 'abcd1234' })).toEqual({
      sessionId: 's1',
      browserInstanceId: 'abcd1234',
    })
  })

  it('builds argv templates that never place values where flags parse', () => {
    const url = new URL('https://example.test/x')
    expect(argv.navigate('sess1' as never, url)).toEqual(['navigate', '--json', '--session', 'sess1', '--', 'https://example.test/x'])
    expect(argv.press('sess1' as never, 'Enter')).toEqual(['press', '--json', '--session', 'sess1', '--', 'Enter'])
    expect(argv.fill('sess1' as never, '@e3', 'v')).toEqual(['fill', '--json', '--session', 'sess1', '--ref', '@e3', '--value=v'])
    expect(argv.click('sess1' as never, '@e3')).toEqual(['click', '--json', '--session', 'sess1', '--ref', '@e3'])
    expect(argv.sessionStart('abcd1234' as never)).toEqual([
      'session', 'start', '--json', '--browser', 'abcd1234', '--no-focus', '--name', 'shres-managed',
    ])
    expect(argv.daemonStart(52_801)).toEqual(['daemon', 'start', '--foreground', '--port', '52801'])
    expect(argv.daemonStop()).toEqual(['daemon', 'stop'])
    expect(argv.sessionStop('sess1' as never)).toEqual(['session', 'stop', '--json', 'sess1'])
    expect(argv.observe('sess1' as never)).toEqual(['observe', '--json', '--session', 'sess1'])
  })
})
