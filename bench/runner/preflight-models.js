/**
 * Composed-metadata preflight for the routing measurement (prereg §8): per
 * selected arm, spawn the real launcher (`shres --profile headless`, the same
 * `resolveHarnessLaunch` argv the trials use) with a generated overlay that
 * disables the one-shot runner and its startup row and inserts the bench-owned
 * preflight plugin instead, so the composition is exactly the launcher's and
 * no product code changes. The plugin resolves every conversation and
 * candidate route against the real adapter registry and reports whether the
 * worker-escalation observer is part of the loaded composition.
 *
 * Keyless and spend-free by construction: the child runs with a scratch
 * `SHRES_HOME` holding no credentials and a credential-free environment,
 * every configured adapter endpoint points at a loopback request sink whose
 * counter must stay at zero, and the child creates no session — the run
 * refuses when a session log appears. The child boots from the repository
 * root because the launcher's tsx resolves workspace imports through the
 * repo-root tsconfig facade; the preflight touches no workspace file.
 *
 * @module bench/runner/preflight-models
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getArm } from './arms.js'
import { resolveHarnessLaunch } from './execute.js'

/** The bench directory the arm overlays resolve under. */
const benchRootOf = dirname(dirname(fileURLToPath(import.meta.url)))

/** The preflight plugin the generated overlay inserts by absolute path. */
export const PREFLIGHT_PLUGIN_PATH = join(benchRootOf, 'routing', 'preflight-plugin.mjs')

/** The routing-measurement arms the preflight covers today (prereg §8: S, C, R, N). */
export const PREFLIGHT_ARMS = new Set(['route-strong', 'route-cheap', 'route-coldpoint', 'route-random'])

/** The arm that composes the worker-escalation observer the §4 label reads (arm C). */
const OBSERVER_ARM = 'route-cheap'

/**
 * Arms the preflight refuses by name instead of skipping: a silent skip would
 * let an unmeasured composition reach a spend.
 * @type {ReadonlyMap<string, string>}
 */
export const REFUSED_ARMS = new Map([
  ['route-static', 'arm T (route-static) pins childPolicies from PR 13b, which this branch has not integrated; the preflight refuses it by name until then'],
])

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
 * @param {boolean} input.requireWorkerEscalation - whether a missing worker-escalation observer fails the line.
 * @param {string} input.armOverlayText - the arm's pinned overlay text, redirected into the composition.
 * @returns {string} the overlay YAML text.
 */
export function renderPreflightOverlay({ pluginPath, sinkUrl, routes, requireWorkerEscalation, armOverlayText }) {
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
    `        requireWorkerEscalation: ${requireWorkerEscalation}`,
  )
  return rows.join('\n') + '\n'
}

/**
 * Refuse the preflight's named refusals before any spawn.
 * @param {string[]} arms - selected arm names.
 * @returns {Promise<void>}
 * @throws {Error} naming the refused arm and its reason, as a UsageError.
 */
export async function assertPreflightArms(arms) {
  const { UsageError } = await import('./run.js')
  for (const armName of arms) {
    const reason = REFUSED_ARMS.get(armName)
    if (reason !== undefined) throw new UsageError(`composed-metadata preflight refused: ${reason}`)
  }
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
 * @param {string} input.repoRoot - the harness repository root (also the child cwd).
 * @param {string} input.armOverlayPath - absolute path of the arm's pinned overlay, applied first.
 * @param {string} input.overlayPath - absolute path of the generated preflight overlay.
 * @param {string} input.homeDir - scratch SHRES_HOME (no credentials inside).
 * @param {NodeJS.ProcessEnv} input.env - the caller's environment; credentials are stripped here.
 * @returns {Promise<{ line: Record<string, unknown>, exitCode: number | null, stderr: string }>} the parsed result line.
 * @throws {Error} when the launcher emits no parsable result line or exceeds the timeout.
 */
export async function spawnPreflight({ repoRoot, armOverlayPath, overlayPath, homeDir, env }) {
  const launch = resolveHarnessLaunch(repoRoot)
  const childEnv = { ...env }
  for (const key of Object.keys(childEnv)) {
    if (/KEY|TOKEN|SECRET|CREDENTIAL/.test(key)) delete childEnv[key]
  }
  childEnv.SHRES_HOME = homeDir
  const argv = [...launch.argsPrefix, '--profile', 'headless', '--patch', armOverlayPath, '--patch', overlayPath]
  const child = spawn(launch.command, argv, { cwd: repoRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
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
    } catch {
      // The home simply has no such subtree yet.
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (found !== null) continue
      if (entry.isFile() && entry.name === 'session.jsonl') found = path
      else if (entry.isDirectory()) await walk(path)
    }
  }
  await walk(homeDir)
  return found
}

/**
 * Run the composed-metadata preflight for every selected routing-measurement
 * arm and throw with the named arm and reason on the first failure.
 * @param {object} input
 * @param {string} input.repoRoot - the harness repository root.
 * @param {string} input.benchRoot - the bench directory the arm overlays resolve under.
 * @param {string[]} input.arms - selected arm names.
 * @param {NodeJS.ProcessEnv} input.env - the runner's environment; credentials never reach the child.
 * @returns {Promise<{ arm: string, workerEscalation: boolean, routes: number }[]>} one record per covered arm.
 * @throws {Error} when a refused arm is selected, a route does not resolve, a required observer is absent,
 *   the sink observed a request, or a session log exists.
 */
export async function runPreflight({ repoRoot, benchRoot, arms, env }) {
  await assertPreflightArms(arms)
  const targets = arms.filter(name => PREFLIGHT_ARMS.has(name))
  if (targets.length === 0) return []
  const { UsageError } = await import('./run.js')
  const sink = await startRequestSink()
  const scratch = await mkdtemp(join(tmpdir(), 'bench-preflight-'))
  const homeDir = join(scratch, 'home')
  const overlayDir = join(scratch, 'overlays')
  await mkdir(homeDir, { recursive: true })
  await mkdir(overlayDir, { recursive: true })
  /** @type {{ arm: string, workerEscalation: boolean, routes: number }[]} */
  const records = []
  try {
    for (const armName of targets) {
      const arm = getArm(armName)
      if (arm.pinnedOverlay === undefined) continue
      const armOverlayText = await readFile(join(benchRoot, arm.pinnedOverlay), 'utf8')
      const routes = extractArmRoutes(armOverlayText)
      if (routes.length === 0) throw new UsageError(`composed-metadata preflight: arm ${armName} pins no route to resolve`)
      const overlayPath = join(overlayDir, `${armName}.preflight.patch.yml`)
      await writeFile(overlayPath, renderPreflightOverlay({
        pluginPath: PREFLIGHT_PLUGIN_PATH,
        sinkUrl: sink.sinkUrl,
        routes,
        requireWorkerEscalation: armName === OBSERVER_ARM,
        armOverlayText,
      }))
      const { line, exitCode } = await spawnPreflight({ repoRoot, armOverlayPath: join(benchRoot, arm.pinnedOverlay), overlayPath, homeDir, env })
      const routeLines = /** @type {{ reason?: string, workerEscalation?: unknown, routes?: { provider: string, model: string, resolved?: boolean, error?: string }[] }} */ (line)
      const unresolved = (routeLines.routes ?? [])
        .filter(route => route.resolved !== true)
        .map(route => `${route.provider}/${route.model}${route.error === undefined ? '' : ': ' + route.error}`)
      const failure = line.ok !== true || exitCode !== 0
        ? routeLines.reason ?? `launcher exited ${exitCode}`
        : unresolved.length > 0 ? unresolved.join('; ') : undefined
      if (failure !== undefined) {
        throw new UsageError(`composed-metadata preflight failed for arm ${armName}: ${failure}`)
      }
      records.push({
        arm: armName,
        workerEscalation: routeLines.workerEscalation === true,
        routes: routeLines.routes?.length ?? 0,
      })
    }
    if (sink.count() !== 0) {
      throw new UsageError(`composed-metadata preflight: the request sink observed ${sink.count()} requests; no model request may precede a run`)
    }
    const sessionLog = await findSessionLog(homeDir)
    if (sessionLog !== null) {
      throw new UsageError(`composed-metadata preflight: the disabled one-shot rows leaked a session log (${sessionLog})`)
    }
    return records
  } finally {
    await sink.close()
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}
