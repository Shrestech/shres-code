/**
 * A scripted `bsk` stand-in for unit tests: a real executable child process
 * with the CLI's argument surface, state kept under the owned BSK_HOME it is
 * handed. It binds real ports and records real pids so the runner, daemon,
 * lease, and supervisor tests exercise genuine process semantics without any
 * BrowserSkill binary.
 *
 * @module tests/fake-bsk
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The stand-in script source. State lives under the BSK_HOME the runner supplies. */
const SCRIPT = `#!${process.execPath}
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

const home = process.env.BSK_HOME
const stateDir = join(home, '.fake-bsk')
const state = name => join(stateDir, name)
const readJson = (name, fallback) => {
  try { return JSON.parse(readFileSync(state(name), 'utf8')) } catch { return fallback }
}
const argv = process.argv.slice(2)
const command = argv[0]
// A test can park any command by dropping hold-<command> into the state dir;
// the busy wait is bounded so a forgotten marker cannot hang the suite.
const holdStart = Date.now()
while (existsSync(state('hold-' + String(command))) && Date.now() - holdStart < 8000) {}
mkdirSync(stateDir, { recursive: true })

const reply = value => {
  process.stdout.write(JSON.stringify(value))
  process.exit(0)
}
const fail = (code, message) => {
  process.stderr.write(message)
  process.exit(code)
}
const record = entry => {
  const log = readJson('invocations.json', [])
  log.push(entry)
  writeFileSync(state('invocations.json'), JSON.stringify(log))
}

if (command === 'daemon' && argv[1] === 'start') {
  const portIndex = argv.indexOf('--port')
  const port = Number(argv[portIndex + 1])
  writeFileSync(state('daemon.json'), JSON.stringify({ pid: process.pid, port }))
  const server = createServer(socket => socket.destroy())
  server.listen({ host: '127.0.0.1', port, exclusive: true })
  process.on('SIGTERM', () => process.exit(0))
  setInterval(() => {}, 10_000)
} else if (command === 'daemon' && argv[1] === 'stop') {
  const daemon = readJson('daemon.json', undefined)
  if (daemon !== undefined) {
    try { process.kill(daemon.pid, 'SIGTERM') } catch {}
    rmSync(state('daemon.json'))
  }
  reply({})
} else if (command === 'status') {
  record({ command: 'status' })
  const daemon = readJson('daemon.json', undefined)
  if (daemon === undefined || !existsSync(state('daemon.json'))) fail(1, 'no daemon')
  reply({ daemon_version: '0.3.1', pid: daemon.pid, ws_port: daemon.port, uptime_secs: 1 })
} else if (command === 'browsers') {
  record({ command: 'browsers' })
  reply(readJson('instances.json', []))
} else if (command === 'session' && argv[1] === 'start') {
  const browserIndex = argv.indexOf('--browser')
  const requested = argv[browserIndex + 1]
  const instances = readJson('instances.json', [])
  const target = instances.some(entry => entry.instance_id === requested) ? requested : instances[0]?.instance_id
  if (target === undefined) fail(3, 'no such browser')
  const sessionId = 'sess-' + Math.random().toString(36).slice(2, 8)
  const sessions = readJson('sessions.json', {})
  sessions[sessionId] = target
  writeFileSync(state('sessions.json'), JSON.stringify(sessions))
  record({ command: 'session start', session: sessionId, browser: target })
  reply({ session_id: sessionId, browser_instance_id: target })
} else if (command === 'session' && argv[1] === 'stop') {
  const id = argv[argv.indexOf('--json') + 1] ?? argv[argv.length - 1]
  const sessions = readJson('sessions.json', {})
  delete sessions[id]
  writeFileSync(state('sessions.json'), JSON.stringify(sessions))
  record({ command: 'session stop', session: id })
  reply({ stopped: id })
} else if (command === 'navigate') {
  const url = argv[argv.length - 1]
  record({ command: 'navigate', url })
  reply({ reached: 'load', final_url: url })
} else if (command === 'observe') {
  reply({ text: 'fake observation' })
} else if (command === 'click') {
  reply({ used_selector: argv[argv.indexOf('--ref') + 1] })
} else if (command === 'fill') {
  const value = argv.find(argument => argument.startsWith('--value='))
  reply({ value_length: (value ?? '').length - '--value='.length })
} else if (command === 'press') {
  reply({ key: argv[argv.length - 1] })
} else {
  fail(2, 'fake bsk: unsupported command ' + String(command))
}
`

/**
 * Write the stand-in executable under `dir`.
 * @param dir - owned test directory for the script.
 * @returns the absolute script path and its SHA-256 pin.
 */
export async function writeFakeBsk(dir: string): Promise<{ path: string; sha256: string }> {
  const path = join(dir, 'fake-bsk.mjs')
  await writeFile(path, SCRIPT, { mode: 0o644 })
  await chmod(path, 0o755)
  const sha256 = createHash('sha256').update(await readFile(path)).digest('hex')
  return { path, sha256 }
}

/** State directory the fake keeps inside its BSK_HOME. */
export function fakeBskStateDir(root: string): string {
  return join(root, 'bsk-home', '.fake-bsk')
}

/**
 * Read the fake's invocation log.
 * @param root - owned runtime root.
 * @returns the recorded invocations.
 */
export async function readFakeInvocations(root: string): Promise<readonly Record<string, unknown>[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(fakeBskStateDir(root), 'invocations.json'), 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed as readonly Record<string, unknown>[]
  } catch {
    return []
  }
}

/**
 * Seed the fake daemon's browser instance list.
 * @param root - owned runtime root.
 * @param instances - entries to publish to future `browsers` calls.
 */
export async function seedFakeInstances(root: string, instances: readonly { instance_id: string; label: string }[]): Promise<void> {
  await mkdir(fakeBskStateDir(root), { recursive: true })
  await writeFile(join(fakeBskStateDir(root), 'instances.json'), JSON.stringify(instances))
}
