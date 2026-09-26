/**
 * Keyless two-spawn snapshot for the product headless profile’s
 * `--session-id`/`--resume` flags. Spawn one creates the session under the
 * explicit id and routes turn one to the candidate under the router; spawn two
 * resumes the same id through an overlay that composes no router. Together
 * they pin the append-only persisted log, the `request/header` reason `resume`,
 * the durable manual base winning over turn one’s routed candidate, and the
 * second-turn-only stdout.
 */

import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { normalizeSessionLog, scrubRequestHeaders, type NormalizeContext } from '@shres-code/shres-code-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleLaunch } from '@shres-code/shres-code-loader-smoke'
import { startMockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import type { MockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import {
  decompressZstdFrame,
  scanZstdFrames,
} from '@shres-code/shres-code-session-persistence-jsonl/src/zstd.ts'
import { describe, expect, it } from 'vitest'

const testsDir = dirname(fileURLToPath(import.meta.url))
const routedOverlay = join(dirname(testsDir), 'headless-resume.cordis.snapshot.yml')
const plainOverlay = join(dirname(testsDir), 'headless-resume-plain.cordis.snapshot.yml')
const cliBin = fileURLToPath(new URL('../../../apps/cli/src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const routerFixture = join(testsDir, 'fixtures', 'model-router-snapshot-fixture.ts')
const sessionExpected = join(testsDir, 'snapshots', 'headless-resume', 'session.expected.jsonl')
const refreshing = process.env['SHRES_SNAPSHOT'] === 'refresh'

const SESSION_ID = 'bench-resume'
const SUCCESS_TEXT = 'ROUTER_RESUME_OK'
const TURN_ONE = 'Reply with exactly: ' + SUCCESS_TEXT
const TURN_TWO = 'Continue and reply with exactly: ' + SUCCESS_TEXT

interface JsonObject {
  [key: string]: unknown
}

interface SpawnOutcome {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | undefined
}

function parseJsonl(content: string): JsonObject[] {
  return content.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as JsonObject)
}

/** The one persisted session log under the two spawns’ shared profile session root. */
async function sessionLogPath(cwd: string): Promise<string> {
  const root = join(cwd, '.shres', 'sessions')
  const files = (await readdir(root, { recursive: true }))
    .filter(name => name.endsWith('.jsonl') || name.endsWith('.jsonl.zstd'))
  if (files.length !== 1) {
    throw new Error(`expected exactly one persisted session log under ${root}, found ${JSON.stringify(files)}`)
  }
  const found = files[0]
  if (found === undefined) throw new Error('the log listing changed between the filter and the index read')
  return join(root, found)
}

/** The session log’s full event text: raw for jsonl, concatenated frames for zstd. */
async function readPersistedLog(file: string): Promise<string> {
  const content = await readFile(file)
  if (!file.endsWith('.zstd')) return content.toString('utf8')
  const scan = scanZstdFrames(content)
  if (scan.tornStart !== undefined) {
    throw new Error(`the persisted resume log has a torn Zstandard frame: ${file}`)
  }
  const decoded: Buffer[] = []
  for (const frame of scan.frames) {
    decoded.push(await decompressZstdFrame(content.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(decoded).toString('utf8')
}

/**
 * Spawn the product headless profile once in the shared cwd and capture its streams.
 * @param cwd - the two spawns’ shared temporary working directory and Shres home parent.
 * @param args - complete argv after the bin: launcher flags, inner flags, and the task.
 * @param server - the loopback stub endpoint the DeepSeek adapter dials.
 */
async function spawnHeadless(cwd: string, args: string[], server: MockLlmServer): Promise<SpawnOutcome> {
  const launch = resolveExampleLaunch({
    srcBin: cliBin,
    configArgs: args,
    tsconfigPath,
    env: {
      SHRES_HOME: join(cwd, '.shres'),
      SHRES_AGENTS_HOME: join(cwd, '.agents'),
      SHRES_PERMISSION_MODE: 'danger-full-access',
      SHRES_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: 'headless-resume-snapshot-key',
      SHRES_SNAPSHOT_BASE_URL: server.baseURL,
      NODE_OPTIONS: [process.env['NODE_OPTIONS'], '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
    },
  })
  const result = await execa(launch.command, launch.args, {
    cwd,
    env: launch.env,
    input: '',
    timeout: 30_000,
    killSignal: 'SIGKILL',
    reject: false,
    stripFinalNewline: false,
  })
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
}

/**
 * Stderr minus the two known dev-boot warning families: the CLI’s shield
 * edition provisions its npm plugin into every fresh profile and warns that it
 * declares no bundle layer, and a source boot runs under an unsigned developer
 * entitlement. This helper stays local to this snapshot on purpose: do not
 * hoist it into a shared helper or broaden the two patterns. The filter also
 * runs on CI and is inert there only because those warnings do not arise on a
 * clean CI checkout — it is not CI-conditional. Remove it once the warning
 * sources are fixed. Any other stderr line is a failure.
 */
function unexpectedStderr(rawStderr: string): string {
  return rawStderr
    .split('\n')
    .filter(line => line !== ''
      && !line.includes('declares no shres.bundle')
      && !line.includes('unsigned developer entitlement'))
    .join('\n')
}

/** The `model` field of one stub-server request body, keyed by accepted-request order. */
function requestedModels(server: MockLlmServer): unknown[] {
  return server.requests.map(request => (request.body as { model?: unknown } | undefined)?.model)
}

describe('headless --session-id/--resume two-spawn snapshot', () => {
  it('appends turn two to the routed session and returns it to the manual base without the router', async () => {
    const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, chunkSize: 4096, successText: SUCCESS_TEXT })
    const cwd = await mkdtemp(join(tmpdir(), 'headless-resume-snapshot-'))
    try {
      const fixtureDir = join(cwd, '.shres', 'profiles', 'headless', 'snapshot-fixtures')
      await mkdir(fixtureDir, { recursive: true })
      await Promise.all([
        copyFile(routerFixture, join(fixtureDir, 'model-router-snapshot-fixture.ts')),
        writeFile(join(fixtureDir, 'package.json'), '{"type":"module"}\n'),
      ])

      const first = await spawnHeadless(cwd, ['--profile', 'headless', '--patch', routedOverlay, '--session-id', SESSION_ID, TURN_ONE], server)
      expect(unexpectedStderr(first.stderr)).toBe('')
      expect(first.exitCode).toBe(0)
      expect(first.stdout).toBe(SUCCESS_TEXT + '\n')
      const logPath = await sessionLogPath(cwd)
      const requestsAfterFirstSpawn = server.requests.length
      const turnOneLog = await readPersistedLog(logPath)

      const second = await spawnHeadless(cwd, ['--profile', 'headless', '--patch', plainOverlay, '--resume', SESSION_ID, TURN_TWO], server)
      expect(unexpectedStderr(second.stderr)).toBe('')
      expect(second.exitCode).toBe(0)
      // Second turn only: the resumed spawn prints its own interval’s final text.
      expect(second.stdout).toBe(SUCCESS_TEXT + '\n')

      // Append-only same session: the final log extends spawn one’s bytes in place.
      const finalLog = await readPersistedLog(logPath)
      expect(finalLog.startsWith(turnOneLog)).toBe(true)

      const records = parseJsonl(finalLog)
      const headerModel = (record: JsonObject): string => {
        const data = record['data'] as JsonObject
        const header = data['header'] as JsonObject
        const config = header['config'] as JsonObject
        return String(config['model'])
      }
      const headers = records.filter(record => record['type'] === 'request/header')
      // Turn one ran the routed candidate; turn two ran the durable manual base.
      expect(headers.map(headerModel)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
      // Spawn one dials the stub for its routed turn (plus its own title
      // request); the resumed spawn adds exactly one request, on the manual base.
      expect(server.requests.length - requestsAfterFirstSpawn).toBe(1)
      expect(requestedModels(server).slice(requestsAfterFirstSpawn)).toEqual(['deepseek-v4-pro'])
      expect(requestedModels(server)[0]).toBe('deepseek-v4-flash')
      const resumeReasons = records.filter(record => record['type'] === 'request/header'
        && (record['data'] as JsonObject | undefined)?.['reason'] === 'resume')
      expect(resumeReasons).toHaveLength(1)
      const routeBase = records.filter(record => record['type'] === 'agent/route-base').map(record => record['data'])
      expect(routeBase).toEqual([{
        manual: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        routed: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      }])
      // The manual base came from the log, not from a written explicit selection.
      expect(records.filter(record => record['type'] === 'agent/model-selection')).toEqual([])

      const context: NormalizeContext = { sessionIds: [SESSION_ID], cwd }
      const normalized = scrubRequestHeaders(normalizeSessionLog(finalLog, context))
      if (refreshing) {
        await mkdir(dirname(sessionExpected), { recursive: true })
        await writeFile(sessionExpected, normalized)
      } else {
        expect(normalized).toBe(await readFile(sessionExpected, 'utf8'))
      }
    } finally {
      await server.close()
      await rm(cwd, { recursive: true, force: true })
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
