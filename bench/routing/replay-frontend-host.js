/**
 * Parent orchestrator for launcher-hosted replay. One child per trial; consult
 * construction runs inside the plugin. Class C refusals aggregate here.
 * @module
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { entryListSchema } from '../../vendor/include/lib/index.js'
import { getArm, renderArmOverlay } from '../runner/arms.js'
import { resolveHarnessLaunch } from '../runner/execute.js'
import { startRequestSink } from '../runner/preflight-models.js'
import { renderReplayFrontendOverlay } from './replay-frontend-overlay.js'
import { TrialInputIncompleteError } from './replay-frontend.js'

const PREFLIGHT_TIMEOUT_MS = 120_000
const ROUTER_NAME = '@shres-code/shres-code-model-router'

function scrubEnv(env) {
  const childEnv = { ...env }
  for (const key of Object.keys(childEnv)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/.test(key)) delete childEnv[key]
  }
  return childEnv
}

/**
 * Snapshot every file under a persistence root: sha256, size, mtimeMs.
 * @param {string} root
 * @returns {Promise<Record<string, { sha256: string, size: number, mtimeMs: number }>>}
 */
export async function snapshotSessionLogRoot(root) {
  const files = {}
  const walk = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error && error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        const info = await stat(full)
        const bytes = await readFile(full)
        files[relative(root, full)] = {
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: info.size,
          mtimeMs: info.mtimeMs,
        }
      }
    }
  }
  await walk(root)
  return files
}

/**
 * Refuse when any file under the root changed, appeared, or disappeared.
 * @param {Record<string, { sha256: string, size: number, mtimeMs: number }>} before
 * @param {Record<string, { sha256: string, size: number, mtimeMs: number }>} after
 */
export function assertUnchangedSnapshots(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    const left = before[key]
    const right = after[key]
    if (left === undefined || right === undefined || left.sha256 !== right.sha256
      || left.size !== right.size || left.mtimeMs !== right.mtimeMs) {
      throw new TrialInputIncompleteError('trial-artifact-mutated')
    }
  }
}

function countEnabledRouters(nodes, into = []) {
  if (!Array.isArray(nodes)) return into
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue
    if (Array.isArray(node.insert)) countEnabledRouters(node.insert, into)
    if (Array.isArray(node.patches)) countEnabledRouters(node.patches, into)
    if (node.name === ROUTER_NAME && node.disabled !== true) into.push(node)
  }
  return into
}

/**
 * Count enabled model-router rows in a --dump-config YAML document.
 * @param {string} yamlText
 * @returns {{ count: number, row: object | undefined }}
 */
export function countRoutersInDump(yamlText) {
  const doc = loadYaml(yamlText, { schema: entryListSchema })
  const rows = countEnabledRouters(Array.isArray(doc) ? doc : doc?.plugins ?? [])
  return { count: rows.length, row: rows[0] }
}

async function spawnLauncher({ repoRoot, scratchDir, armOverlayPath, overlayPath, homeDir, env, extraArgs = [] }) {
  const launch = resolveHarnessLaunch(repoRoot)
  const childEnv = { ...scrubEnv(env), ...launch.env, SHRES_HOME: homeDir }
  const argv = [...launch.argsPrefix, '--profile', 'headless', '--patch', armOverlayPath, '--patch', overlayPath, ...extraArgs]
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
  return { exitCode, stderr, stdout }
}

/**
 * Host one trial's replay inside a launcher child.
 * @param {object} input
 */
export async function hostReplayTrial({
  repoRoot, trial, path, arm, method, trialOwnRoute, now = Date.now(), env = process.env,
  extraOverlay,
}) {
  const root = await mkdtemp(join(tmpdir(), 'bench-replay-host-'))
  const home = join(root, 'home')
  const scratchDir = join(root, 'cwd')
  const sessionLogRoot = dirname(dirname(dirname(path)))
  await mkdir(home)
  await mkdir(scratchDir)
  const sink = await startRequestSink()
  const before = await snapshotSessionLogRoot(sessionLogRoot)
  try {
    const jobPath = join(root, 'job.json')
    const outPath = join(root, 'out.jsonl')
    const armOverlay = renderArmOverlay(getArm('route-coldpoint'), { sessionLogRoot })
    const armPath = join(root, 'arm.patch.yml')
    const overlayPath = join(root, 'replay.patch.yml')
    await writeFile(armPath, armOverlay)
    await writeFile(overlayPath, renderReplayFrontendOverlay({
      sinkUrl: sink.sinkUrl, sessionLogRoot, job: jobPath, out: outPath,
    }) + (extraOverlay ?? ''))
    const dumped = await spawnLauncher({
      repoRoot, scratchDir, armOverlayPath: armPath, overlayPath, homeDir: home, env,
      extraArgs: ['--dump-config'],
    })
    if (dumped.exitCode !== 0) {
      throw new Error('replay host: --dump-config failed: ' + dumped.stderr)
    }
    const routers = countRoutersInDump(dumped.stdout)
    if (routers.count !== 1) {
      throw new TrialInputIncompleteError('router-count:' + String(routers.count))
    }
    await writeFile(jobPath, JSON.stringify({
      trial, path, arm, method, trialOwnRoute, now, routerRowConfig: routers.row?.config,
    }))
    const spawned = await spawnLauncher({
      repoRoot, scratchDir, armOverlayPath: armPath, overlayPath, homeDir: home, env,
    })
    if (sink.count() !== 0) {
      throw new Error('replay host: loopback sink recorded ' + String(sink.count()) + ' requests')
    }
    const after = await snapshotSessionLogRoot(sessionLogRoot)
    assertUnchangedSnapshots(before, after)
    const line = spawned.stdout.split('\n').map((candidate) => {
      try { return JSON.parse(candidate) } catch { return undefined }
    }).find(candidate => candidate !== undefined && typeof candidate === 'object' && typeof candidate.ok === 'boolean')
    if (line === undefined) {
      throw new Error('replay host: child emitted no status line; stderr: ' + spawned.stderr)
    }
    if (line.classC === true) {
      throw new TrialInputIncompleteError(line.reason, { path })
    }
    if (line.ok !== true) {
      throw new Error('replay host: child refused: ' + line.reason + '\n' + spawned.stderr)
    }
    const text = await readFile(outPath, 'utf8')
    const records = text.trimEnd().split('\n').map(lineText => JSON.parse(lineText))
    const summary = records.at(-1)
    const rows = records.filter(record => record.kind === 'row').map(record => record.row)
    const consults = records.filter(record => record.kind === 'consult').map(record => record.consult)
    return { rows, consults, summary, status: line, sink: 0, routerCount: routers.count }
  } finally {
    await sink.close()
    await rm(root, { recursive: true, force: true })
  }
}
