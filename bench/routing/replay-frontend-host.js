/**
 * Parent orchestrator for launcher-hosted replay. One child per trial; consult
 * construction runs inside the plugin. Class C refusals aggregate here.
 * @module
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
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
import { validateReplayRow } from '../analysis/replay-metrics.js'

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
  repoRoot, trial, path, arm, method, trialOwnRoute, env = process.env,
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
      trial, path, arm, method, trialOwnRoute, routerRowConfig: routers.row?.config,
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
      let published = true
      try {
        await access(outPath)
      } catch (error) {
        if (error && error.code === 'ENOENT') published = false
        else throw error
      }
      if (published) throw new TrialInputIncompleteError('partial-accepted-output', { path })
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

const STRATA = new Set(['routine', 'moderate', 'hard'])

function consultEligible(consults, turn, step, where) {
  const match = consults.find(entry => entry.turn === turn && entry.step === step)
  if (match === undefined || match.result?.kind === 'warm' || match.result?.kind === undefined) {
    throw new Error('row/consult mismatch at ' + where)
  }
  if (match.result.kind === 'ask') return true
  if (match.result.kind === 'ineligible') return false
  throw new Error('row/consult mismatch at ' + where)
}

function prepareRows(hosted, { id, taskId, arm, stratum, trialIndex }) {
  const keys = new Set()
  const rows = hosted.rows.map((row) => {
    const prepared = {
      ...row,
      task: taskId,
      stratum,
      trialIndex,
      eligible: consultEligible(hosted.consults, row.turn, row.step, id + ' turn:' + row.turn + '/step:' + row.step),
    }
    const key = [taskId, arm, String(trialIndex), prepared.coldPointId].join('\0')
    if (keys.has(key)) throw new TypeError('duplicate (task, arm, trialIndex, coldPointId): ' + key)
    keys.add(key)
    return validateReplayRow(prepared, id + ' ' + prepared.coldPointId)
  })
  return { rows, keys }
}

/**
 * Host every trial of one replay run, then aggregate class-C refusals.
 * `preRefused` is the reader's per-trial refusals (`source: 'reader'`). After every
 * hosted trial, one `TrialInputIncompleteError` lists `preRefused` then host class-C
 * (`source: 'host'`) and returns no rows. Empty `trials` is allowed only when
 * `preRefused` is non-empty (all-reader-refused). Ids and (arm, taskId, trialIndex)
 * are unique across `trials` and `preRefused`. When `discovered` is provided,
 * `trials.length + preRefused.length === discovered.length` and every id appears in
 * exactly one of those two lists.
 * @param {object} input
 * @param {object[]} [input.preRefused]
 * @param {string[]} [input.discovered]
 * @returns {Promise<{ rows: object[], consults: object[], summaries: object[] }>}
 */
export async function hostReplayRun({
  repoRoot, method, tasks, trials, env = process.env, extraOverlay,
  preRefused = [], discovered,
}) {
  if (!Array.isArray(preRefused)) throw new TypeError('preRefused must be an array')
  if (!Array.isArray(trials)) throw new TypeError('hostReplayRun requires a trials array')
  if (trials.length === 0 && preRefused.length === 0) throw new TypeError('hostReplayRun requires a non-empty trials array')
  const seenIds = new Set()
  const seenTriple = new Set()
  for (const entry of preRefused) {
    if (typeof entry?.id !== 'string' || entry.id === '') throw new TypeError('every preRefused trial needs a non-empty id')
    if (seenIds.has(entry.id)) throw new TypeError('duplicate trial id: ' + entry.id)
    seenIds.add(entry.id)
    if (!Number.isSafeInteger(entry.trialIndex) || entry.trialIndex < 0) {
      throw new TypeError('every preRefused trial needs a non-negative trialIndex')
    }
    const triple = entry.arm + '\0' + entry.taskId + '\0' + String(entry.trialIndex)
    if (seenTriple.has(triple)) throw new TypeError('duplicate (arm, taskId, trialIndex): ' + triple)
    seenTriple.add(triple)
  }
  for (const trial of trials) {
    if (typeof trial.id !== 'string' || trial.id === '') throw new TypeError('every trial needs a non-empty id')
    if (seenIds.has(trial.id)) throw new TypeError('duplicate trial id: ' + trial.id)
    seenIds.add(trial.id)
    if (!Number.isSafeInteger(trial.trialIndex) || trial.trialIndex < 0) {
      throw new TypeError('every trial needs a non-negative trialIndex')
    }
    const triple = trial.arm + '\0' + trial.taskId + '\0' + String(trial.trialIndex)
    if (seenTriple.has(triple)) throw new TypeError('duplicate (arm, taskId, trialIndex): ' + triple)
    seenTriple.add(triple)
    const stratum = tasks?.[trial.taskId]?.stratum
    if (!STRATA.has(stratum)) throw new TypeError('task ' + String(trial.taskId) + ' has no preregistered stratum')
  }
  if (discovered !== undefined) {
    if (!Array.isArray(discovered)) throw new TypeError('discovered must be an array of trial ids')
    if (trials.length + preRefused.length !== discovered.length) {
      throw new TypeError('hosted.length + preRefused.length must equal discovered.length')
    }
    const discoveredSet = new Set(discovered)
    if (discoveredSet.size !== discovered.length) throw new TypeError('duplicate discovered id')
    for (const id of seenIds) {
      if (!discoveredSet.has(id)) throw new TypeError('trial id not in discovered: ' + id)
    }
    for (const id of discovered) {
      if (!seenIds.has(id)) throw new TypeError('discovered id not in trials or preRefused: ' + id)
    }
  }
  const refusals = []
  const rows = []
  const consults = []
  const summaries = []
  const runKeys = new Set()
  for (const item of trials) {
    let hosted
    try {
      hosted = await hostReplayTrial({
        repoRoot,
        trial: item.trial,
        path: item.path,
        arm: item.arm,
        method,
        trialOwnRoute: item.trialOwnRoute,
        env,
        extraOverlay,
      })
    } catch (error) {
      if (error instanceof TrialInputIncompleteError) {
        refusals.push({
          id: item.id, taskId: item.taskId, trialIndex: item.trialIndex, arm: item.arm, path: item.path,
          reason: error.message, source: 'host',
        })
        continue
      }
      throw error
    }
    const prepared = prepareRows(hosted, {
      id: item.id, taskId: item.taskId, arm: item.arm, stratum: tasks[item.taskId].stratum, trialIndex: item.trialIndex,
    })
    for (const key of prepared.keys) {
      if (runKeys.has(key)) throw new TypeError('duplicate (task, arm, trialIndex, coldPointId): ' + key)
      runKeys.add(key)
    }
    rows.push(...prepared.rows)
    consults.push({ id: item.id, consults: hosted.consults })
    summaries.push({
      id: item.id,
      artifact: hosted.summary?.artifact ?? hosted.status?.artifact,
      rows: prepared.rows.length,
      summary: hosted.summary,
    })
  }
  const all = [
    ...preRefused.map(entry => ({ ...entry, source: 'reader' })),
    ...refusals,
  ]
  if (all.length > 0) {
    throw new TrialInputIncompleteError(
      'replay run refused: ' + String(all.length) + ' trial(s)',
      { trials: all },
    )
  }
  return { rows, consults, summaries }
}
