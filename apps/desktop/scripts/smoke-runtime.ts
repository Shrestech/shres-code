/** Boot a packaged runtime tree's host child, exercise its real pipes, and stop it. */

import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '@shres-code/shres-code-desktop-host/wire'
import { HOST_EVENTS_PATH } from '../../../packages/client/connection/src/api-path.ts'
import { DesktopHostProcess } from '../src/host-process.ts'
import { ensureDesktopProfile } from '../src/profile-init.ts'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.ts'

/** Diagnostic prefix on every failure and progress line this smoke emits. */
const NAME = 'shres desktop'

/** Repository root explicit paths are resolved against. */
const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..')

/** Host entry the shell spawns inside an installed runtime tree. */
const INSTALLED_HOST_ENTRY: readonly string[] = ['node_modules', '@shres-code', 'shres-code-desktop-host', 'lib', 'index.js']

/** Installed manifest carrying the shres version the host child reports as ready. */
const INSTALLED_APP_MANIFEST: readonly string[] = ['node_modules', '@shres-code', 'shres-code', 'package.json']

/** Stable, keyless smoke contract for the first document and host downlink. */
const EXPECTED_SMOKE_OUTPUT = join(import.meta.dirname, '..', 'tests', 'expected', 'smoke-runtime.txt')

/** Millisecond budget for each framed request to answer. */
const ROUND_TRIP_TIMEOUT_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
 * @returns the child environment with every home and Shres settings path on disposable state.
 */
export function smokeEnvironment(home: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    name !== 'NODE_OPTIONS' && name !== 'NODE_PATH'
    && name !== 'HOME' && name !== 'USERPROFILE' && name !== 'HOMEDRIVE' && name !== 'HOMEPATH'
    && name !== 'ELECTRON_USER_DATA_DIR' && name !== 'ELECTRON_CACHE_DIR'
    && !name.startsWith('SHRES_')
    && !name.startsWith('XDG_')
    && !/^(?:npm|pnpm|corepack)_/iu.test(name)
    && !/(?:key|token|secret|password|credential)/iu.test(name)
  )))
  return {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    SHRES_HOME: home,
    SHRES_AGENTS_HOME: join(home, 'agents'),
    SHRES_TELEMETRY_DISABLED: '1',
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    ELECTRON_RUN_AS_NODE: '1',
  }
}

/**
 * Stable response markers the packaged smoke compares after exercising the
 * production host-process carrier.
 */
interface SmokeExpectedOutput {
  /** Status returned by the shell document route. */
  readonly documentStatus: number
  /** Marker returned in the shell document body. */
  readonly documentMarker: string
  /** Status returned by the host event downlink. */
  readonly eventsStatus: number
  /** Marker returned in the host event stream body. */
  readonly eventsMarker: string
}

/**
 * Read the committed, keyless output contract used by the packaged smoke.
 * @returns expected status and body markers for the two real transport probes.
 */
function readSmokeExpectedOutput(): SmokeExpectedOutput {
  let documentStatus: number | undefined
  let documentMarker: string | undefined
  let eventsStatus: number | undefined
  let eventsMarker: string | undefined
  for (const line of readFileSync(EXPECTED_SMOKE_OUTPUT, 'utf8').split(/\r?\n/u)) {
    if (line.startsWith('document.status=')) documentStatus = Number(line.slice('document.status='.length))
    else if (line.startsWith('document.marker=')) documentMarker = line.slice('document.marker='.length)
    else if (line.startsWith('events.status=')) eventsStatus = Number(line.slice('events.status='.length))
    else if (line.startsWith('events.marker=')) eventsMarker = line.slice('events.marker='.length)
  }
  if (typeof documentStatus !== 'number' || !Number.isInteger(documentStatus) || documentMarker === undefined
    || typeof eventsStatus !== 'number' || !Number.isInteger(eventsStatus) || eventsMarker === undefined) {
    throw new Error(`${NAME}: smoke output contract is incomplete at ${EXPECTED_SMOKE_OUTPUT}`)
  }
  return { documentStatus, documentMarker, eventsStatus, eventsMarker }
}

/**
 * Read one streaming response until a stable marker arrives, then cancel it
 * through the production carrier so the host can complete its teardown.
 * @param response - response returned by {@link DesktopHostProcess.fetch}.
 * @param marker - body text proving the intended route answered.
 * @returns nothing; rejects when the stream ends without the marker.
 */
async function readStreamingMarker(response: Response, marker: string): Promise<void> {
  if (response.body === null) throw new Error(`${NAME}: the streaming response had no body`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let body = ''
  const deadline = setTimeout(() => { void reader.cancel() }, ROUND_TRIP_TIMEOUT_MS)
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`${NAME}: the streaming response ended before ${JSON.stringify(marker)}`)
      body += decoder.decode(chunk.value, { stream: true })
      if (body.includes(marker)) return
    }
  } finally {
    clearTimeout(deadline)
    await reader.cancel().catch(() => undefined)
  }
}

/** Execute the bundled PTY helper under the app's own Node runtime. */
function smokeTerminal(runtime: string, nodeBinary: string, home: string): void {
  const result = spawnSync(nodeBinary, ['--input-type=module', '--eval', `
    import { createRequire } from 'node:module'
    const { spawn } = createRequire(process.cwd() + '/package.json')('node-pty')
    const terminal = spawn('/bin/sh', ['-c', 'printf DESKTOP_PTY_READY'], { cwd: process.env.HOME })
    let output = ''
    const deadline = setTimeout(() => { terminal.kill(); process.exitCode = 1 }, 10000)
    terminal.onData(data => { output += data })
    terminal.onExit(({ exitCode }) => {
      clearTimeout(deadline)
      if (exitCode !== 0 || !output.includes('DESKTOP_PTY_READY')) process.exitCode = 1
      else console.log('DESKTOP_PTY_READY')
    })
  `], { cwd: runtime, env: smokeEnvironment(home), encoding: 'utf8', timeout: 15_000 })
  if (result.status !== 0 || !result.stdout.includes('DESKTOP_PTY_READY')) {
    throw new Error(`${NAME}: bundled terminal spawn failed: ${result.error?.message ?? result.stderr}`)
  }
}

/**
 * Prove the packaged runtime tree boots its host child and serves its UI.
 * The child uses a production profile initializer and disposable home/project
 * directories removed only after the host process has stopped.
 * @param runtimeDir - packaged runtime tree root the Electron application ships.
 * @param nodeBinary - Electron executable running the host child as Node.
 * @returns nothing; rejects with the child's standard error on any mismatch.
 */
export async function smokeDesktopRuntime(runtimeDir: string, nodeBinary: string): Promise<void> {
  const runtime = resolve(runtimeDir)
  const hostEntry = join(runtime, ...INSTALLED_HOST_ENTRY)
  if (!existsSync(hostEntry)) throw new Error(`${NAME}: the packaged runtime tree has no host entry at ${hostEntry}`)
  if (!existsSync(nodeBinary)) throw new Error(`${NAME}: the Electron executable is missing at ${nodeBinary}`)
  const expectedAppVersion = installedAppVersion(runtime)
  const expected = readSmokeExpectedOutput()
  const home = mkdtempSync(join(tmpdir(), 'shres-desktop-smoke-'))
  const project = join(home, 'project')
  mkdirSync(project, { recursive: true })
  const host = new DesktopHostProcess(nodeBinary, runtime, project, undefined, smokeEnvironment(home))
  let smokeFailure: unknown
  try {
    smokeTerminal(runtime, nodeBinary, home)
    ensureDesktopProfile(project, expectedAppVersion)
    const ready = await host.start()
    if (ready.protocolVersion !== DESKTOP_HOST_PROTOCOL_VERSION) {
      throw new Error(`${NAME}: the packaged host child speaks protocol ${String(ready.protocolVersion)}, expected ${String(DESKTOP_HOST_PROTOCOL_VERSION)}`)
    }
    if (ready.appVersion !== expectedAppVersion) {
      throw new Error(`${NAME}: the packaged host child booted shres ${ready.appVersion}, expected ${expectedAppVersion}`)
    }
    console.log(`${NAME}: packaged host ready at protocol ${String(ready.protocolVersion)} with shres ${ready.appVersion}`)

    const document = await host.fetch(new Request('shres-app://app/', { signal: AbortSignal.timeout(ROUND_TRIP_TIMEOUT_MS) }))
    if (document.status !== expected.documentStatus) {
      throw new Error(`${NAME}: the packaged document answered ${String(document.status)}, expected ${String(expected.documentStatus)}`)
    }
    const documentBody = await document.text()
    if (!documentBody.includes(expected.documentMarker)) {
      throw new Error(`${NAME}: the packaged document did not contain ${JSON.stringify(expected.documentMarker)}`)
    }
    if (!documentBody.includes('__SHRES_BOOT__') || !documentBody.includes('__SHRES_TRANSPORT__')) {
      throw new Error(`${NAME}: the packaged document is missing its client boot or desktop transport configuration`)
    }
    console.log(`${NAME}: served the bundled UI with desktop transport configuration`)

    const events = await host.fetch(new Request(`shres-app://app${HOST_EVENTS_PATH}`, {
      method: 'POST',
      headers: { accept: 'application/x-ndjson' },
      signal: AbortSignal.timeout(ROUND_TRIP_TIMEOUT_MS),
    }))
    if (events.status !== expected.eventsStatus) {
      throw new Error(`${NAME}: ${HOST_EVENTS_PATH} answered ${String(events.status)}, expected ${String(expected.eventsStatus)}`)
    }
    const workspace = join(home, 'workspace')
    mkdirSync(workspace)
    // Host downlinks have no baseline frames; a real workspace write proves
    // both RPC dispatch and delivery through the open event stream.
    await Promise.all([
      readStreamingMarker(events, expected.eventsMarker),
      (async () => {
        const response = await host.fetch(new Request('shres-app://app/api/workspace.create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'workspace.create', payload: { path: workspace } }),
          signal: AbortSignal.timeout(ROUND_TRIP_TIMEOUT_MS),
        }))
        const envelope: unknown = await response.json()
        if (response.status !== 200 || !isRecord(envelope) || !isRecord(envelope.result) || envelope.result.ok !== true) {
          throw new Error(`${NAME}: packaged workspace creation failed: ${JSON.stringify(envelope)}`)
        }
      })(),
    ])
    console.log(`${NAME}: served ${expected.documentMarker} and ${HOST_EVENTS_PATH}`)
  } catch (error) {
    smokeFailure = error
  } finally {
    let teardownFailure: unknown
    try {
      await host.stop()
    } catch (error) {
      teardownFailure = error
    }
    rmSync(home, { recursive: true, force: true })
    if (smokeFailure !== undefined && teardownFailure !== undefined) {
      throw new AggregateError([smokeFailure, teardownFailure], `${NAME}: smoke and teardown failed`)
    }
    if (teardownFailure !== undefined) throw teardownFailure
  }
  if (smokeFailure !== undefined) throw smokeFailure
}

/** Smoke the selected target's packaged runtime tree under its own bundled Node executable. */
async function main(): Promise<void> {
  const paths = resolveDesktopTargetBuildPaths()
  const { values } = parseArgs({
    options: { runtime: { type: 'string' }, node: { type: 'string' } },
    allowPositionals: false,
  })
  const defaultBundle = join(paths.artifacts, resolveDesktopBuildTarget(), 'Shres Code.app')
  const runtime = values.runtime === undefined ? join(defaultBundle, 'Contents', 'Resources', 'shres') : resolve(REPOSITORY_ROOT, values.runtime)
  const node = values.node === undefined
    ? join(defaultBundle, 'Contents', 'MacOS', 'Shres Code')
    : resolve(REPOSITORY_ROOT, values.node)
  await smokeDesktopRuntime(runtime, node)
  console.log(`${NAME}: packaged runtime tree booted, served / and ${HOST_EVENTS_PATH}, and stopped at ${runtime}`)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
