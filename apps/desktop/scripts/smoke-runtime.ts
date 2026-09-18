/** Boot a packaged runtime tree's desktop host child and prove it reports ready and stops cleanly. */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../../desktop-host/src/wire.ts'
import { resolveDesktopTargetBuildPaths } from './desktop-build-paths.ts'

/** Diagnostic prefix on every failure and progress line this smoke emits. */
const NAME = 'shres desktop'

/** Repository root explicit paths are resolved against. */
const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..')

/** Host entry the shell spawns inside an installed runtime tree. */
const INSTALLED_HOST_ENTRY: readonly string[] = ['node_modules', '@shres-code', 'shres-code-desktop-host', 'lib', 'index.js']

/** Installed manifest carrying the shres version the host child reports as ready. */
const INSTALLED_APP_MANIFEST: readonly string[] = ['node_modules', '@shres-code', 'shres-code', 'package.json']

/** Millisecond budget for the child to compose its host and report ready. */
const READY_TIMEOUT_MS = 120_000

/** Millisecond budget for the child to exit after the shutdown command. */
const SHUTDOWN_TIMEOUT_MS = 30_000

/** Ready facts a host child reports over the lifecycle IPC channel. */
interface DesktopHostReadyEvent {
  /** Protocol version the child speaks, shared with the Electron shell. */
  readonly protocolVersion: number
  /** Version of the installed shres application package the child booted. */
  readonly appVersion: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Whether one IPC message is a host child's ready event.
 * @param message - the message a child sent over its lifecycle IPC channel.
 * @returns true when the message carries a numeric protocol version and a string application version.
 */
function isReadyEvent(message: unknown): message is DesktopHostReadyEvent {
  return isRecord(message) && message.type === 'ready'
    && typeof message.protocolVersion === 'number' && typeof message.appVersion === 'string'
}

/**
 * Whether one IPC message is a host child's fatal event.
 * @param message - the message a child sent over its lifecycle IPC channel.
 * @returns true when the message carries a failure text.
 */
function isFatalEvent(message: unknown): message is { readonly message: string } {
  return isRecord(message) && message.type === 'fatal' && typeof message.message === 'string'
}

/**
 * Quote a child's standard error for a failure detail.
 * @param stderr - everything the child has written to standard error.
 * @returns the diagnostics on their own line, or an empty string when the child wrote none.
 */
function stderrDetail(stderr: string): string {
  const trimmed = stderr.trim()
  return trimmed === '' ? '' : `\n${trimmed}`
}

/**
 * Read the shres version a packaged runtime tree installs.
 * @param runtime - installed runtime tree root.
 * @returns the version of the installed shres application package.
 */
function installedAppVersion(runtime: string): string {
  const path = join(runtime, ...INSTALLED_APP_MANIFEST)
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${NAME}: the packaged runtime tree has no readable shres manifest at ${path}: ${String(error)}`)
  }
  if (!isRecord(manifest) || typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error(`${NAME}: ${path} declares no version`)
  }
  return manifest.version
}

/**
 * Build the child environment from this process's, without the launch overrides a packaged run must not inherit.
 * @param home - disposable harness home this smoke owns.
 * @returns the child environment, with SHRES_HOME on the disposable home.
 */
function smokeEnvironment(home: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    name !== 'NODE_OPTIONS' && name !== 'NODE_PATH' && name !== 'SHRES_HOME'
    && !name.startsWith('SHRES_DESKTOP_') && !/^(?:npm|pnpm|corepack)_/iu.test(name)
  )))
  return { ...inherited, SHRES_HOME: home }
}

/**
 * Drive one host child from spawn to a clean exit.
 * @param child - spawned host child holding the byte pipes and the lifecycle IPC channel.
 * @param expectedAppVersion - version of the shres package the packaged tree installs.
 * @param stderrOf - reader for what the child has written to standard error.
 * @returns nothing; rejects with the child's own diagnostics on any mismatch.
 */
function runHostChild(child: ChildProcess, expectedAppVersion: string, stderrOf: () => string): Promise<void> {
  return new Promise<void>((resolveSmoke, rejectSmoke) => {
    let stopping = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (error?: Error): void => {
      if (timer !== undefined) clearTimeout(timer)
      child.off('message', handleMessage)
      child.off('close', handleClose)
      child.off('error', handleError)
      if (error === undefined) resolveSmoke()
      else rejectSmoke(error)
    }
    const fail = (detail: string): void => {
      settle(new Error(`${NAME}: ${detail}${stderrDetail(stderrOf())}`))
    }
    const armTimer = (milliseconds: number, detail: string): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => { fail(detail) }, milliseconds)
    }
    const handleMessage = (message: unknown): void => {
      if (stopping) return
      if (isFatalEvent(message)) {
        fail(`the packaged host child failed to boot: ${message.message}`)
        return
      }
      if (!isReadyEvent(message)) {
        fail('the packaged host child sent an unrecognized IPC event')
        return
      }
      if (message.protocolVersion !== DESKTOP_HOST_PROTOCOL_VERSION) {
        fail(`the packaged host child speaks protocol ${String(message.protocolVersion)}, expected ${String(DESKTOP_HOST_PROTOCOL_VERSION)}`)
        return
      }
      if (message.appVersion !== expectedAppVersion) {
        fail(`the packaged host child booted shres ${message.appVersion}, expected ${expectedAppVersion}`)
        return
      }
      stopping = true
      console.log(`${NAME}: packaged host ready at protocol ${String(message.protocolVersion)} with shres ${message.appVersion}`)
      armTimer(SHUTDOWN_TIMEOUT_MS, `the packaged host child did not stop within ${String(SHUTDOWN_TIMEOUT_MS)} ms`)
      child.send({ type: 'shutdown' })
    }
    const handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (!stopping) {
        fail(`the packaged host child exited with ${String(code ?? signal)} before reporting ready`)
        return
      }
      if (code === 0) settle()
      else fail(`the packaged host child stopped with ${String(code ?? signal)}, expected a clean shutdown`)
    }
    const handleError = (error: Error): void => {
      fail(`the packaged host child could not start: ${error.message}`)
    }
    child.on('message', handleMessage)
    child.on('close', handleClose)
    child.on('error', handleError)
    armTimer(READY_TIMEOUT_MS, `the packaged host child reported no ready event within ${String(READY_TIMEOUT_MS)} ms`)
  })
}

/**
 * Prove the packaged runtime tree boots its host child and stops it cleanly.
 * The child runs without a user profile: its project and harness home live in a disposable
 * directory removed on every outcome.
 * @param runtimeDir - packaged runtime tree root the Electron application ships.
 * @param nodeBinary - bundled Node executable that runs the host child.
 * @returns nothing; rejects with the child's standard error on any mismatch.
 */
export async function smokeDesktopRuntime(runtimeDir: string, nodeBinary: string): Promise<void> {
  const runtime = resolve(runtimeDir)
  const hostEntry = join(runtime, ...INSTALLED_HOST_ENTRY)
  if (!existsSync(hostEntry)) throw new Error(`${NAME}: the packaged runtime tree has no host entry at ${hostEntry}`)
  if (!existsSync(nodeBinary)) throw new Error(`${NAME}: the bundled Node executable is missing at ${nodeBinary}`)
  const expectedAppVersion = installedAppVersion(runtime)
  const home = mkdtempSync(join(tmpdir(), 'shres-desktop-smoke-'))
  const project = join(home, 'project')
  mkdirSync(project, { recursive: true })
  let stderr = ''
  const child = spawn(nodeBinary, [hostEntry, runtime, project], {
    cwd: project,
    env: smokeEnvironment(home),
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'ipc'],
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { stderr += chunk })
  try {
    await runHostChild(child, expectedAppVersion, () => stderr)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
}

/** Smoke the selected target's packaged runtime tree under its own bundled Node executable. */
async function main(): Promise<void> {
  const paths = resolveDesktopTargetBuildPaths()
  const { values } = parseArgs({
    options: { runtime: { type: 'string' }, node: { type: 'string' } },
    allowPositionals: false,
  })
  const runtime = values.runtime === undefined ? paths.dsh : resolve(REPOSITORY_ROOT, values.runtime)
  const node = values.node === undefined
    ? join(paths.runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
    : resolve(REPOSITORY_ROOT, values.node)
  await smokeDesktopRuntime(runtime, node)
  console.log(`${NAME}: packaged runtime tree booted and stopped cleanly at ${runtime}`)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
