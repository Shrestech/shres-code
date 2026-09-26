/**
 * Composed-metadata preflight for the routing measurement (prereg §8): per
 * selected arm, spawn the real launcher (`shres --profile headless`, the same
 * `resolveHarnessLaunch` argv the trials use) with a generated overlay that
 * disables the one-shot runner and its startup row and inserts the bench-owned
 * preflight plugin instead, so the composition is exactly the launcher's and
 * no product code changes. The plugin resolves every conversation and
 * candidate route against the real adapter registry and prints one JSON
 * result line.
 *
 * Keyless and spend-free by construction: the child runs with a scratch
 * `SHRES_HOME` holding no credentials and a credential-free environment,
 * every configured adapter endpoint points at a loopback request sink whose
 * counter must stay at zero, and the child creates no session — the run
 * refuses when a session log appears. The child boots from an empty scratch
 * cwd with the trial launcher's explicit source-mapping environment.
 *
 * Arm purity: arm C is the preregistered always-cheap composition. Its pinned
 * overlay must carry no worker-escalation row — bench trials are root
 * sessions the ladder never engages, so a composed-but-dormant observer would
 * make "no trigger" vacuous — and the preflight fails loud when one appears.
 *
 * @module bench/runner/preflight-models
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getArm, renderArmOverlay } from './arms.js'
import { resolveHarnessLaunch } from './execute.js'

/** The bench directory the arm overlays resolve under. */
const benchRootOf = dirname(dirname(fileURLToPath(import.meta.url)))

/** The preflight plugin the generated overlay inserts by absolute path. */
export const PREFLIGHT_PLUGIN_PATH = join(benchRootOf, 'routing', 'preflight-plugin.mjs')

/** Routing-measurement arms with composed-metadata preflight coverage. */
export const PREFLIGHT_ARMS = new Set(['route-strong', 'route-cheap', 'route-coldpoint', 'route-random', 'route-static'])

/** Per-arm cap on the spawned launcher, generous enough for cold profile provisioning. */
export const PREFLIGHT_TIMEOUT_MS = 120_000

/**
 * Extract one arm overlay's conversation and candidate routes, exactly as
 * `assertRoutesPriced` reads them, so pricing and preflight cannot disagree
 * about what an arm dials.
 * @param {string} text - the arm overlay's text.
 * @returns {{ provider: string, model: string }[]} the pinned base route plus every candidate route.
 */
export function extractArmRoutes(text) {
  const routes = []
  const base = text.match(/- id: agent-default-model\n  config:\n    provider: "([^"]+)"\n    model: "([^"]+)"/)
  if (base) routes.push({ provider: base[1], model: base[2] })
  for (const match of text.matchAll(/\{"id":"[^"]+","provider":"([^"]+)","model":"([^"]+)"/g)) {
    routes.push({ provider: match[1], model: match[2] })
  }
  return routes
}

/**
 * Arm-overlay purity: arm C must compose no worker-escalation row. The ladder
 * engages delegated sessions only, so on a root bench trial the row would be
 * dead composition, and "no trigger" would be vacuous rather than measured;
 * triggers are computed offline by the replay labeller instead.
 * @param {string} armName - the arm the overlay belongs to.
 * @param {string} armOverlayText - the arm's pinned overlay text.
 * @returns {void}
 * @throws {Error} when the always-cheap arm's overlay names worker-escalation.
 */
export function assertArmOverlayPurity(armName, armOverlayText) {
  if (armName !== 'route-cheap') return
  if (/worker-escalation/.test(armOverlayText)) {
    throw new Error(`composed-metadata preflight: arm C (route-cheap) is the preregistered always-cheap composition and must not compose worker-escalation; triggers are folded offline by the replay labeller`)
  }
}

/**
 * Render one arm overlay's `llm-pi-ai` config block with every provider
 * endpoint pointed at the sink: an existing `baseURL` value is replaced and a
 * provider without one gains the sink as its first key. The block is emitted
 * verbatim otherwise, so the arm's own model declarations survive the
 * redirect.
 * @param {string} block - the block's lines, from `- id: llm-pi-ai` to the next same-indent entry.
 * @param {string} sinkUrl - the loopback sink endpoint.
 * @returns {string} the redirected block.
 */
function redirectPiAiBlock(block, sinkUrl) {
  const sinkValue = JSON.stringify(sinkUrl)
  const lines = block.split('\n')
  const out = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    out.push(line)
    if (!/^      [\w-]+:\s*$/.test(line)) continue
    let hasBaseURL = false
    for (let peek = index + 1; peek < lines.length; peek++) {
      if (/^      [\w-]+:\s*$/.test(lines[peek]) || /^- id: /.test(lines[peek])) break
      if (/^        baseURL:/.test(lines[peek])) hasBaseURL = true
    }
    if (!hasBaseURL) out.push(`        baseURL: ${sinkValue}`)
  }
  return out.join('\n').replace(/^        baseURL: .*$/gm, `        baseURL: ${sinkValue}`)
}

/**
 * Render the generated preflight overlay for one arm: the two disable rows,
 * the adapter redirects, and the preflight plugin insert carrying the arm's
 * routes by absolute plugin path.
 * @param {object} input
 * @param {string} input.pluginPath - absolute path of the bench preflight plugin.
 * @param {string} input.sinkUrl - loopback sink endpoint every configured adapter dials.
 * @param {{ provider: string, model: string }[]} input.routes - the arm's conversation and candidate routes.
 * @param {string} input.armOverlayText - the arm's pinned overlay text, redirected into the composition.
 * @returns {string} the overlay YAML text.
 */
export function renderPreflightOverlay({ pluginPath, sinkUrl, routes, armOverlayText }) {
  const rows = [
    '# Generated by bench/runner/preflight-models.js for the composed-metadata preflight.',
    '# Disabling both one-shot rows leaves the preflight plugin as the composition\'s',
    '# only driver: no task is parsed and no session is created.',
    '- id: headless-runner',
    '  disabled: true',
    '- id: headless-startup',
    '  disabled: true',
    '# Redirect the DeepSeek adapter wholesale: every config field defaults, so',
    '# the sink endpoint is the one restated value.',
    '- id: llm-deepseek',
    '  config:',
    `    baseURL: ${JSON.stringify(sinkUrl)}`,
  ]
  const piAiStart = armOverlayText.indexOf('- id: llm-pi-ai')
  if (piAiStart !== -1) {
    const lines = armOverlayText.slice(piAiStart).split('\n')
    let end = lines.length
    for (let index = 1; index < lines.length; index++) {
      if (/^- /.test(lines[index])) {
        end = index
        break
      }
    }
    const block = lines.slice(0, end).join('\n')
    rows.push(
      '# The arm configures the pi-ai adapter; its providers dial the sink.',
      redirectPiAiBlock(block.trimEnd(), sinkUrl),
    )
  }
  rows.push(
    '- insert:',
    '    - id: bench-preflight',
    `      name: ${JSON.stringify(pluginPath)}`,
    '      config:',
    '        routes:',
    ...routes.map(route => `          - provider: ${JSON.stringify(route.provider)}\n            model: ${JSON.stringify(route.model)}`),
  )
  return rows.join('\n') + '\n'
}

/**
 * Start the loopback request sink: an HTTP server that only counts requests.
 * @returns {Promise<{ sinkUrl: string, count: () => number, close: () => Promise<void> }>} the sink handle.
 */
export async function startRequestSink() {
  const seen = { requests: 0 }
  const server = createServer((_request, response) => {
    seen.requests += 1
    response.destroy()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  return {
    sinkUrl: `http://127.0.0.1:${address.port}`,
    count: () => seen.requests,
    close: () => new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))),
  }
}

/**
 * Spawn the launcher once with one arm overlay plus one generated preflight
 * overlay and return the preflight plugin's JSON result line.
 * @param {object} input
 * @param {string} input.repoRoot - the harness repository root.
 * @param {string} input.scratchDir - empty scratch working directory.
 * @param {string} input.armOverlayPath - absolute path of the arm's pinned overlay, applied first.
 * @param {string} input.overlayPath - absolute path of the generated preflight overlay.
 * @param {string} input.homeDir - scratch SHRES_HOME (no credentials inside).
 * @param {NodeJS.ProcessEnv} input.env - the caller's environment; credentials are stripped here.
 * @returns {Promise<{ line: Record<string, unknown>, exitCode: number | null, stderr: string }>} the parsed result line.
 * @throws {Error} when the launcher emits no parsable result line or exceeds the timeout.
 */
export async function spawnPreflight({ repoRoot, scratchDir, armOverlayPath, overlayPath, homeDir, env }) {
  const launch = resolveHarnessLaunch(repoRoot)
  const childEnv = { ...env, ...launch.env }
  for (const key of Object.keys(childEnv)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/.test(key)) delete childEnv[key]
  }
  childEnv.SHRES_HOME = homeDir
  const argv = [...launch.argsPrefix, '--profile', 'headless', '--patch', armOverlayPath, '--patch', overlayPath]
  const child = spawn(launch.command, argv, { cwd: scratchDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000)
    }, PREFLIGHT_TIMEOUT_MS)
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  const parsed = stdout.split('\n').map(candidate => {
    try {
      return JSON.parse(candidate)
    } catch {
      return undefined
    }
  }).find(candidate => candidate !== undefined && typeof candidate === 'object' && typeof candidate.ok === 'boolean')
  if (parsed === undefined) {
    throw new Error(`composed-metadata preflight emitted no result line (exit ${exitCode}); stderr: ${stderr.trim()}`)
  }
  return { line: parsed, exitCode, stderr }
}

/**
 * Find any session log under the scratch home: the preflight creates no
 * session, so one found means a disabled one-shot row leaked a driver into
 * the composition.
 * @param {string} homeDir - the scratch home to walk.
 * @returns {Promise<string | null>} one session-log path, or null.
 */
async function findSessionLog(homeDir) {
  let found = null
  const walk = async dir => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (found !== null) continue
      if (entry.isFile() && (entry.name === 'session.jsonl' || entry.name.startsWith('session.jsonl.'))) found = path
      else if (entry.isDirectory()) await walk(path)
    }
  }
  await walk(homeDir)
  return found
}

/**
 * Refuse fixture-local launcher context that a metadata-only empty cwd cannot represent.
 * @param {Iterable<{ dir: string }>} tasks - selected task definitions.
 * @returns {Promise<void>} resolves when the fixture names contain no launcher config.
 */
export async function assertFixturesCarryNoLauncherConfig(tasks) {
  const forbidden = new Set(['cordis.yml', 'cordis.patch.yml', '.shres', '.agents', 'agents.md'])
  for (const task of tasks) {
    const fixture = join(task.dir, 'fixture')
    let entries
    try {
      entries = await readdir(fixture, { withFileTypes: true, recursive: true })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      if (forbidden.has(entry.name.toLowerCase())) {
        throw new Error(`composed-metadata preflight cannot represent fixture launcher config: ${join(entry.parentPath, entry.name)}`)
      }
    }
  }
}

/**
 * Run the composed-metadata preflight for every selected routing-measurement
 * arm and throw with the named arm and reason on the first failure.
 * @param {object} input
 * @param {string} input.repoRoot - the harness repository root.
 * @param {string} input.benchRoot - the bench directory the arm overlays resolve under.
 * @param {string[]} input.arms - selected arm names.
 * @param {NodeJS.ProcessEnv} input.env - the runner's environment; credentials never reach the child.
 * @param {boolean} input.confirmatory - selected R/N arms require adopted bodies.
 * @param {ReadonlyMap<string, string>} [input.pinnedBodies] - adopted confirmatory overlay bodies.
 * @returns {Promise<{ arm: string, routes: number }[]>} one record per covered arm.
 * @throws {Error} when an arm overlay fails its purity check, a route
 *   does not resolve, the sink observed a request, or a session log exists.
 */
export async function runPreflight({ repoRoot, benchRoot, arms, env, confirmatory, pinnedBodies }) {
  const targets = arms.filter(name => PREFLIGHT_ARMS.has(name))
  if (targets.length === 0) return []
  const { UsageError } = await import('./run.js')
  const sink = await startRequestSink()
  const scratch = await mkdtemp(join(tmpdir(), 'bench-preflight-'))
  const homeDir = join(scratch, 'home')
  const overlayDir = join(scratch, 'overlays')
  const scratchDir = join(scratch, 'cwd')
  await mkdir(scratchDir)
  await mkdir(homeDir, { recursive: true })
  await mkdir(overlayDir, { recursive: true })
  /** @type {{ arm: string, routes: number }[]} */
  const records = []
  try {
    for (const armName of targets) {
      const arm = getArm(armName)
      if (arm.pinnedOverlay === undefined) throw new UsageError(`composed-metadata preflight: arm ${armName} has no pinned overlay`)
      const adopted = pinnedBodies?.get(armName)
      if (confirmatory && (armName === 'route-coldpoint' || armName === 'route-random') && adopted === undefined) {
        throw new UsageError(`composed-metadata preflight: confirmatory ${armName} requires its adopted overlay body`)
      }
      const pinnedBody = adopted ?? (await readFile(join(benchRoot, arm.pinnedOverlay), 'utf8')).trimEnd()
      const armOverlayText = renderArmOverlay(arm, { sessionLogRoot: join(scratch, 'sessions', armName), pinnedBody })
      const armOverlayPath = join(overlayDir, `${armName}.arm.patch.yml`)
      await writeFile(armOverlayPath, armOverlayText)
      assertArmOverlayPurity(armName, armOverlayText)
      const routes = extractArmRoutes(armOverlayText)
      if (routes.length === 0) throw new UsageError(`composed-metadata preflight: arm ${armName} pins no route to resolve`)
      const overlayPath = join(overlayDir, `${armName}.preflight.patch.yml`)
      await writeFile(overlayPath, renderPreflightOverlay({
        pluginPath: PREFLIGHT_PLUGIN_PATH,
        sinkUrl: sink.sinkUrl,
        routes,
        armOverlayText,
      }))
      const { line, exitCode, stderr } = await spawnPreflight({ repoRoot, scratchDir, armOverlayPath, overlayPath, homeDir, env })
      const routeLines = /** @type {{ reason?: string, routes?: { provider: string, model: string, resolved?: boolean, error?: string }[] }} */ (line)
      const unresolved = (routeLines.routes ?? [])
        .filter(route => route.resolved !== true)
        .map(route => `${route.provider}/${route.model}${route.error === undefined ? '' : ': ' + route.error}`)
      const failure = line.ok !== true || exitCode !== 0
        ? routeLines.reason ?? `launcher exited ${exitCode}`
        : unresolved.length > 0 ? unresolved.join('; ') : undefined
      if (failure !== undefined) {
        const bootDetail = exitCode !== 0 && stderr.trim() ? `; launcher stderr: ${stderr.trim()}` : ''
        throw new UsageError(`composed-metadata preflight failed for arm ${armName}: ${failure}${bootDetail}`)
      }
      records.push({
        arm: armName,
        routes: routeLines.routes?.length ?? 0,
      })
    }
    if (sink.count() !== 0) {
      throw new UsageError(`composed-metadata preflight: the request sink observed ${sink.count()} requests; no model request may precede a run`)
    }
    const sessionLog = await findSessionLog(scratch)
    if (sessionLog !== null) {
      throw new UsageError(`composed-metadata preflight: the disabled one-shot rows leaked a session log (${sessionLog})`)
    }
    return records
  } finally {
    await sink.close()
    await rm(scratch, { recursive: true, force: true })
  }
}
