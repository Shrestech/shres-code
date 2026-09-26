/**
 * Replay a complete S/C run with the composed fitted judge and publish its
 * labelled rows and metrics. Method choices are required before any child is
 * launched. Registration finalization is explicit and happens after the
 * evidence directory is published; a writer refusal keeps that evidence.
 * @module bench/routing/calibrate
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual, parseArgs as parseNodeArgs } from 'node:util'
import { computeReplayMetrics, validateReplayRow } from '../analysis/replay-metrics.js'
import { UsageError } from '../runner/run.js'
import { ALL_METHOD_FIELDS, MethodInvalidError, MethodProvenanceError, MethodUnpinnedError, parseReplayMethod } from './replay-method.js'
import { registrationPhase } from './registration-phase.js'
import { REGISTRATION_SCHEMA, writeRegistration as finalizeRegistration } from './write-registration.js'
import { TrialInputIncompleteError } from './replay-frontend.js'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const USAGE = 'Usage: node bench/routing/calibrate.js --experiment-dir <dir> --registration <file> --task-root <dir> --out <dir> [--extra-overlay <file>] [--write-registration --seed <int> --overlays-out <dir>]'
const PATH_FLAGS = {
  'experiment-dir': 'experimentDir', registration: 'registrationPath',
  'task-root': 'taskRoot', out: 'outDir',
  'extra-overlay': 'extraOverlayPath', 'overlays-out': 'overlaysOut',
}
const GATE_KEYS = ['aurocMin', 'falseDowngradeMax', 'coverageMin']

/**
 * Parse the explicit calibration inputs; no numerical method choice defaults.
 * @param {string[]} argv - arguments after the script name.
 * @returns {object} resolved paths, optional seed, and action flags.
 */
export function parseArgs(argv) {
  let values
  try {
    values = parseNodeArgs({ args: argv, strict: true, allowPositionals: false, options: {
      ...Object.fromEntries(Object.keys(PATH_FLAGS).map(key => [key, { type: 'string' }])),
      seed: { type: 'string' }, 'write-registration': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    } }).values
  } catch (error) {
    throw new UsageError(error.message)
  }
  if (values.help) return { help: true }
  for (const flag of ['experiment-dir', 'registration', 'task-root', 'out']) {
    if (!values[flag]) throw new UsageError(`--${flag} is required`)
  }
  const writing = values['write-registration'] === true
  if (writing && (values.seed === undefined || !values['overlays-out'])) {
    throw new UsageError('--write-registration requires --seed and --overlays-out')
  }
  if (!writing && (values.seed !== undefined || values['overlays-out'] !== undefined)) {
    throw new UsageError('--seed and --overlays-out require --write-registration')
  }
  let seed
  if (values.seed !== undefined) {
    if (!/^[0-9]+$/.test(values.seed) || !Number.isSafeInteger(Number(values.seed))) {
      throw new UsageError('--seed must be a non-negative safe integer')
    }
    seed = Number(values.seed)
  }
  const paths = {}
  for (const [flag, key] of Object.entries(PATH_FLAGS)) {
    if (values[flag] !== undefined) {
      if (values[flag] === '') throw new UsageError(`--${flag} must name a path`)
      paths[key] = resolve(values[flag])
    }
  }
  return { ...paths, writeRegistration: writing, ...(writing ? { seed } : {}), help: false }
}

/** SHA-256 of file bytes or a UTF-8 artifact string. */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Refuse existing directories, files and dangling links without following them. */
async function requireAbsent(path) {
  try {
    await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new UsageError(`output already exists: ${path}`)
}

/** Validate the registration bounds before a judge can be asked. */
function gateBounds(registration) {
  const source = registration.operatingPoint?.layaGate
  const gate = {}
  for (const key of GATE_KEYS) {
    const value = source?.[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new UsageError(`registration.operatingPoint.layaGate.${key} must be a number from 0 through 1`)
    }
    gate[key] = value
  }
  return gate
}

/** Serialize complete records without inserting an empty JSONL record. */
function jsonl(records) {
  return records.map(record => `${JSON.stringify(record)}\n`).join('')
}

/**
 * Produce one complete evidence directory and optionally finalize registration.
 * @param {object} options - resolved values from parseArgs.
 * @param {object} runtime - launcher environment and repository location.
 * @param {string} runtime.repoRoot - repository containing the built launcher.
 * @param {object} runtime.env - child environment, never included in artifacts.
 * @returns {Promise<object>} output path, method identity, metrics and writer result.
 */
export async function calibrateRun(options, { repoRoot, env }) {
  const registrationBytes = await readFile(options.registrationPath)
  let registration
  try {
    registration = JSON.parse(registrationBytes.toString('utf8'))
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new UsageError(`registration is not valid JSON: ${error.message}`)
  }
  if (registration === null || typeof registration !== 'object' || Array.isArray(registration)
    || registration.schema !== REGISTRATION_SCHEMA) {
    throw new UsageError(`registration must use schema ${REGISTRATION_SCHEMA}`)
  }
  const { method, methodSha256 } = parseReplayMethod(registration.method, { require: ALL_METHOD_FIELDS })
  let phase
  try {
    phase = registrationPhase(registration)
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    throw new UsageError(error.message)
  }
  if (options.writeRegistration && phase !== 'provisional') {
    throw new UsageError('registration is already finalized; replayGate must be absent before writing')
  }
  const gate = gateBounds(registration)
  await requireAbsent(options.outDir)
  const extraOverlay = options.extraOverlayPath === undefined ? undefined : await readFile(options.extraOverlayPath, 'utf8')
  const { readReplayRun } = await import('./replay-run-reader.js')
  const { hostReplayRun } = await import('./replay-frontend-host.js')
  let input
  try {
    input = await readReplayRun({ experimentDir: options.experimentDir, registration, taskRoot: options.taskRoot })
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    throw new UsageError(error.message)
  }
  await mkdir(dirname(options.outDir), { recursive: true })
  const temp = await mkdtemp(join(dirname(options.outDir), `.${basename(options.outDir)}.tmp-`))
  let published = false
  let metrics
  try {
    const replay = await hostReplayRun({
      repoRoot, env, method, tasks: input.tasks, trials: input.trials,
      preRefused: input.refused, discovered: input.discovered, extraOverlay, judge: true,
    })
    const routerConfig = replay.summaries[0]?.routerConfig
    if (!routerConfig?.difficultyInstructions || replay.summaries.some(item => !isDeepStrictEqual(item.routerConfig, routerConfig))) {
      throw new UsageError('calibration requires one shared resolved R config with difficultyInstructions')
    }
    for (const [index, row] of replay.rows.entries()) validateReplayRow(row, `calibration row ${index}`)
    metrics = computeReplayMetrics(replay.rows, { method, gate, entry: {
      entryScoreCeiling: routerConfig.difficulty.entryScoreCeiling,
      candidateIds: routerConfig.candidates.map(candidate => candidate.id),
    } })
    const files = {
      'labelled-scores.jsonl': jsonl(replay.rows),
      'consults.jsonl': jsonl(replay.consults),
      'asks.jsonl': jsonl(replay.summaries.map(item => ({ id: item.id, asks: item.summary.asks }))),
      'metrics.json': `${JSON.stringify(metrics, null, 2)}\n`,
    }
    const hashes = {}
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(temp, name), content, { flag: 'wx', mode: 0o600 })
      hashes[name] = sha256(content)
    }
    const manifest = {
      schema: 'shres-code/routing-calibration@1', options, methodSha256,
      registrationSha256: sha256(registrationBytes),
      ...(extraOverlay === undefined ? {} : { extraOverlaySha256: sha256(extraOverlay) }),
      trialIds: input.trials.map(item => item.id), discovered: input.discovered,
      counts: { discovered: input.discovered.length, refused: input.refused.length, hosted: replay.summaries.length, rows: replay.rows.length },
      routerConfig, files: hashes,
    }
    await writeFile(join(temp, 'run.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await requireAbsent(options.outDir)
    await rename(temp, options.outDir)
    published = true
  } finally {
    if (!published) await rm(temp, { recursive: true, force: true })
  }
  let registrationResult
  if (options.writeRegistration) {
    try {
      registrationResult = finalizeRegistration({ registrationPath: options.registrationPath, metrics, seed: options.seed, outDir: options.overlaysOut })
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
      return { outDir: options.outDir, methodSha256, metrics, writerRefusal: error.message }
    }
  }
  return { outDir: options.outDir, methodSha256, metrics, registrationResult }
}

/**
 * Run the CLI. Usage/method refusals return 2; corrupt trial aggregates return 3;
 * a registration refusal after evidence publication returns 4. Other failures throw.
 * @param {string[]} argv - command-line arguments.
 * @param {object} io - output callbacks and launcher environment.
 * @returns {Promise<number>} process exit code.
 */
export async function main(argv, { print = console.log, error = console.error, env = process.env } = {}) {
  try {
    const options = parseArgs(argv)
    if (options.help) { print(USAGE); return 0 }
    const result = await calibrateRun(options, { repoRoot: REPO_ROOT, env })
    print(JSON.stringify({ outDir: result.outDir, methodSha256: result.methodSha256, gate: result.metrics.gate }))
    if (result.writerRefusal !== undefined) { error(result.writerRefusal); return 4 }
    return 0
  } catch (failure) {
    if (failure instanceof TrialInputIncompleteError) {
      error(JSON.stringify({ error: failure.message, trials: failure.trials }))
      return 3
    }
    if (failure instanceof UsageError || failure instanceof MethodUnpinnedError
      || failure instanceof MethodInvalidError || failure instanceof MethodProvenanceError) {
      error(failure.message)
      return 2
    }
    throw failure
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, error => {
    console.error(error)
    process.exitCode = 1
  })
}
