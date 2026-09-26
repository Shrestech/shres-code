/**
 * Parent orchestrator for launcher-hosted replay. One child per trial; consult
 * construction runs inside the plugin. Class C refusals aggregate here.
 * @module
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getArm, renderArmOverlay } from '../runner/arms.js'
import { resolveHarnessLaunch } from '../runner/execute.js'
import { spawn } from 'node:child_process'
import { startRequestSink } from '../runner/preflight-models.js'
import { renderReplayFrontendOverlay } from './replay-frontend-overlay.js'
import { TrialInputIncompleteError } from './replay-frontend.js'

const PREFLIGHT_TIMEOUT_MS = 120_000

function scrubEnv(env) {
  const childEnv = { ...env }
  for (const key of Object.keys(childEnv)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/.test(key)) delete childEnv[key]
  }
  return childEnv
}

async function spawnChild({ repoRoot, scratchDir, armOverlayPath, overlayPath, homeDir, env }) {
  const launch = resolveHarnessLaunch(repoRoot)
  const childEnv = { ...scrubEnv(env), ...launch.env, SHRES_HOME: homeDir }
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
  const line = stdout.split('\n').map((candidate) => {
    try { return JSON.parse(candidate) } catch { return undefined }
  }).find(candidate => candidate !== undefined && typeof candidate === 'object' && typeof candidate.ok === 'boolean')
  return { line, exitCode, stderr, stdout }
}

/**
 * Host one trial's replay inside a launcher child.
 * @param {object} input
 */
export async function hostReplayTrial({
  repoRoot, trial, path, arm, method, trialOwnRoute, now = Date.now(), env = process.env,
}) {
  const root = await mkdtemp(join(tmpdir(), 'bench-replay-host-'))
  const home = join(root, 'home')
  const scratchDir = join(root, 'cwd')
  const sessionLogRoot = dirname(dirname(dirname(path)))
  await mkdir(home)
  await mkdir(scratchDir)
  const sink = await startRequestSink()
  const before = await stat(path)
  try {
    const jobPath = join(root, 'job.json')
    const outPath = join(root, 'out.jsonl')
    await writeFile(jobPath, JSON.stringify({ trial, path, arm, method, trialOwnRoute, now }))
    const armOverlay = renderArmOverlay(getArm('route-coldpoint'), { sessionLogRoot })
    const armPath = join(root, 'arm.patch.yml')
    const overlayPath = join(root, 'replay.patch.yml')
    await writeFile(armPath, armOverlay)
    await writeFile(overlayPath, renderReplayFrontendOverlay({
      sinkUrl: sink.sinkUrl, sessionLogRoot, job: jobPath, out: outPath,
    }))
    const spawned = await spawnChild({
      repoRoot, scratchDir, armOverlayPath: armPath, overlayPath, homeDir: home, env,
    })
    if (sink.count() !== 0) {
      throw new Error('replay host: loopback sink recorded ' + String(sink.count()) + ' requests')
    }
    const after = await stat(path)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('replay host: trial session log bytes or mtime changed')
    }
    if (spawned.line === undefined) {
      throw new Error('replay host: child emitted no status line; stderr: ' + spawned.stderr)
    }
    if (spawned.line.classC === true) {
      throw new TrialInputIncompleteError(spawned.line.reason, { path })
    }
    if (spawned.line.ok !== true) {
      throw new Error('replay host: child refused: ' + spawned.line.reason + '\n' + spawned.stderr)
    }
    const text = await readFile(outPath, 'utf8')
    const records = text.trimEnd().split('\n').map(line => JSON.parse(line))
    const summary = records.at(-1)
    const rows = records.filter(record => record.kind === 'row').map(record => record.row)
    const consults = records.filter(record => record.kind === 'consult').map(record => record.consult)
    return { rows, consults, summary, status: spawned.line, sink: 0 }
  } finally {
    await sink.close()
    await rm(root, { recursive: true, force: true })
  }
}
