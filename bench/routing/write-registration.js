/**
 * Writer of the replay-calibrated fields of the routing measurement's
 * registration, and generator of the confirmatory R and N overlays.
 *
 * The offline judge replay is the only event that may calibrate the routing
 * measurement: this module consumes its metrics result (the `method` block,
 * the gate verdict, and the chosen operating point from
 * `bench/analysis/replay-metrics.js`) plus the experiment's fixed seed, and
 * on a passed gate writes `replayGate: 'passed'` with the `enforced` block
 * exactly in the shape `bench/runner/run.js assertConfirmatoryRegistration`
 * enforces. On a failed gate it writes `replayGate: 'failed'` with the full
 * metrics and constructs no `enforced` block and no `calibratedBy` value:
 * a failed gate is recorded, never calibrated, and the runner refuses the
 * confirmatory arms on it.
 *
 * The two denominators stay distinct and are both preserved:
 * - the gate's coverage divides by every cold-point row of the replay set;
 * - `enforced.entryRate` and `enforced.realizedREntryRate` carry the chosen
 *   point's eligible-row rate, because arm N's bench-random engine draws once
 *   per asked consult and asks exactly at eligible cold points.
 *
 * Writes are one-shot and atomic: the registration is rewritten whole through
 * a temp file and rename, a registration past the provisional phase
 * (`registrationPhase`) is never overwritten, the static `status` field is
 * never changed, and the generated confirmatory overlays go to an output
 * directory, never over the committed provisional overlays. This module
 * writes files only; it runs no replay, no model, and no trial.
 *
 * @module bench/routing/write-registration
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registrationPhase } from './registration-phase.js'

/** The committed registration this writer finalizes; the runner reads it by name. */
export const REGISTRATION_SCHEMA = 'shres-code/routing-measurement@1'

/**
 * Restated from `assertConfirmatoryRegistration` (bench/runner/run.js): the
 * calibrated operating point the confirmatory R overlay must carry, and the
 * two lines the confirmatory N overlay must carry. The writer generates these
 * shapes and then re-reads its own output through them, so a number the
 * runner's pattern cannot match refuses here instead of at trial time.
 */
const RUNNER_R_POINT = /"engine":"laya","downgradeThreshold":([\d.]+),"downgradeMargin":([\d.]+),"calibratedBy":"([^"]+)"/
const RUNNER_N_RATE = /entryRate: ([\d.]+)/
const RUNNER_N_SEED = /seed: (\d+)/

/**
 * The provisional operating-point line of the committed R overlay, without
 * `calibratedBy`; generation refuses any other shape rather than guessing.
 */
const PROVISIONAL_R_POINT = /^(\s*)operatingPoints: \[\{"engine":"laya","downgradeThreshold":([\d.]+),"downgradeMargin":([\d.]+)\}\]$/gm

/**
 * The result of one writer run.
 * @typedef {object} WriteRegistrationResult
 * @property {'passed' | 'failed'} replayGate - the gate verdict written into the registration.
 * @property {string} registrationPath - the registration file written.
 * @property {object | undefined} enforced - the enforced block written; undefined on a failed gate.
 * @property {{ routeColdpoint: string, randomMatched: string } | undefined} overlays - the generated confirmatory overlays; undefined on a failed gate.
 */

/**
 * Finalize the registration from the replay metrics, and on a passed gate
 * generate the confirmatory R and N overlays.
 * @param {object} options
 * @param {string} options.registrationPath - the committed registration to finalize; it must
 *   exist, be in the `provisional` phase, and carry the static `"preregistered"` status.
 * @param {object} options.metrics - the replay metrics result; `method`, `gate.passed`, and (on a
 *   pass) `operatingPoint` are validated at this file boundary.
 * @param {number} options.seed - the experiment's fixed seed for arm N's bench-random engine.
 * @param {string} options.outDir - the directory for the generated confirmatory overlays, created
 *   when missing; existing targets refuse the write.
 * @returns {WriteRegistrationResult} what was written, for the CLI and tests.
 * @throws {TypeError} on a malformed metrics result, an inconsistent or already-finalized
 *   registration, an unexpected provisional overlay shape, or an existing output target.
 */
export function writeRegistration({ registrationPath, metrics, seed, outDir }) {
  if (typeof registrationPath !== 'string' || registrationPath === '') throw new TypeError('registrationPath must be a non-empty path')
  const validated = validatedMetrics(metrics)
  if (!Number.isSafeInteger(seed) || seed < 0) throw new TypeError(`seed must be a non-negative safe integer, got ${JSON.stringify(seed)}`)
  if (typeof outDir !== 'string' || outDir === '') throw new TypeError('outDir must be a non-empty path')

  const registration = readRegistration(registrationPath)
  if (registrationPhase(registration) !== 'provisional') {
    throw new TypeError(`${registrationPath} is already finalized (replayGate is set); a registration is written once and never overwritten`)
  }
  const next = { ...registration }
  next.replayGate = validated.passed ? 'passed' : 'failed'
  next.method = { ...validated.method }
  let enforced
  if (validated.passed) {
    enforced = {
      calibratedBy: registration.registration,
      downgradeThreshold: validated.operatingPoint.downgradeThreshold,
      downgradeMargin: validated.operatingPoint.downgradeMargin,
      entryRate: validated.operatingPoint.entryRate,
      realizedREntryRate: validated.operatingPoint.entryRate,
      seed,
    }
    next.enforced = enforced
  } else {
    next.replayMetrics = metrics
  }
  // The built document must read back as one finished phase with the status
  // exactly as it came in: the writer adds the flag and the calibration, and
  // changes nothing else about the file's identity.
  const outputPhase = registrationPhase(next)
  if (outputPhase !== 'replay-qualified' && outputPhase !== 'replay-failed') {
    throw new TypeError(`the built registration is ${outputPhase}; the writer produces replay-qualified or replay-failed only`)
  }
  if (next.status !== registration.status) {
    throw new TypeError('the writer never changes the registration status')
  }

  // Every fallible step of overlay preparation runs before the registration is
  // finalized, so a drifted provisional overlay cannot strand a written
  // registration without its confirmatory overlays.
  let overlays
  if (validated.passed) {
    overlays = prepareConfirmatoryOverlays({ registrationPath, registration, enforced, outDir })
  }
  writeFileAtomic(registrationPath, `${JSON.stringify(next, null, 2)}\n`)
  if (!validated.passed) {
    return { replayGate: next.replayGate, registrationPath, enforced: undefined, overlays: undefined }
  }
  writeConfirmatoryOverlays(overlays)
  return { replayGate: next.replayGate, registrationPath, enforced, overlays: { routeColdpoint: overlays.rTarget, randomMatched: overlays.nTarget } }
}

/** Read and shape-check the committed registration; refusal names the file. */
function readRegistration(registrationPath) {
  if (!existsSync(registrationPath)) {
    throw new TypeError(`the registration to finalize does not exist: ${registrationPath}; the preregistration is committed before the replay writes it`)
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(registrationPath, 'utf8'))
  } catch (error) {
    throw new TypeError(`${registrationPath} is not valid JSON (${error.message})`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${registrationPath} must hold a JSON object`)
  }
  if (parsed.schema !== REGISTRATION_SCHEMA) {
    throw new TypeError(`${registrationPath} has schema ${JSON.stringify(parsed.schema ?? null)}, expected ${REGISTRATION_SCHEMA}`)
  }
  if (typeof parsed.registration !== 'string' || parsed.registration === '') {
    throw new TypeError(`${registrationPath} carries no registration id, which the enforced calibratedBy names`)
  }
  return parsed
}

/** Validate the metrics result fields the writer reads; nothing is defaulted. */
function validatedMetrics(metrics) {
  if (metrics === null || typeof metrics !== 'object') throw new TypeError('metrics must be the replay metrics result object')
  const { method, gate, operatingPoint } = metrics
  if (method === null || typeof method !== 'object') throw new TypeError('metrics.method is required: the recorded preregistration method')
  if (typeof method.version !== 'string' || method.version === '') throw new TypeError('metrics.method.version must be a non-empty string')
  if (!Number.isSafeInteger(method.eceBins) || method.eceBins < 1) throw new TypeError(`metrics.method.eceBins must be a positive integer, got ${JSON.stringify(method.eceBins)}`)
  if (!Array.isArray(method.tieBreak) || method.tieBreak.length === 0) throw new TypeError('metrics.method.tieBreak must be a non-empty array')
  if (gate === null || typeof gate !== 'object' || typeof gate.passed !== 'boolean') {
    throw new TypeError('metrics.gate.passed is required: the Laya replay gate verdict')
  }
  if (!gate.passed) return { passed: false, method, operatingPoint: null }
  if (operatingPoint === null || typeof operatingPoint !== 'object') {
    throw new TypeError('a passed replay gate requires metrics.operatingPoint, the chosen point')
  }
  for (const key of ['downgradeThreshold', 'downgradeMargin', 'coverage', 'entryRate']) {
    const value = operatingPoint[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new TypeError(`metrics.operatingPoint.${key} must be a number from 0 through 1, got ${JSON.stringify(value ?? null)}`)
    }
  }
  return { passed: true, method, operatingPoint }
}

/**
 * Generate the confirmatory R and N overlays into `outDir` from the committed
 * provisional overlays the registration names, replacing exactly the
 * provisional operating point (R) and the entry rate and seed (N) and their
 * provisional header paragraphs. R's point carries the enforced threshold,
 * margin, and `calibratedBy`; N carries the enforced rate and seed, and keeps
 * its point without `calibratedBy`, because the replay calibrated R's gate
 * quantities and N's seeded draw ignores its thresholds. Both generated files
 * are re-read through the runner's own patterns and value-compared before the
 * call returns.
 */
/** Prepare the confirmatory overlay texts and output paths; this writes nothing. */
function prepareConfirmatoryOverlays({ registrationPath, registration, enforced, outDir }) {
  const repoRoot = resolve(dirname(registrationPath), '..', '..')
  const rSource = overlaySource(repoRoot, registrationPath, registration.arms?.R?.overlay)
  const nSource = overlaySource(repoRoot, registrationPath, registration.arms?.N?.overlay)
  const id = registration.registration
  const rText = generateRouteOverlay(readFileSync(rSource, 'utf8'), id, enforced)
  const nText = generateRandomOverlay(readFileSync(nSource, 'utf8'), id, enforced)
  assertRunnerShape(rText, nText, enforced)

  const rTarget = join(outDir, basename(rSource))
  const nTarget = join(outDir, basename(nSource))
  const committedR = resolve(repoRoot, registration.arms.R.overlay)
  const committedN = resolve(repoRoot, registration.arms.N.overlay)
  for (const [target, committed, name] of [[rTarget, committedR, 'R'], [nTarget, committedN, 'N']]) {
    if (resolve(target) === committed) throw new TypeError(`the ${name} output path equals the committed provisional overlay ${committed}; generated overlays never overwrite it`)
    if (existsSync(target)) throw new TypeError(`${target} already exists; the writer never overwrites an output file`)
  }
  return { rText, nText, rTarget, nTarget, outDir }
}

/** Write the prepared overlays; the only step after the registration is finalized. */
function writeConfirmatoryOverlays({ rText, nText, rTarget, nTarget, outDir }) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(rTarget, rText)
  writeFileSync(nTarget, nText)
}

/** Resolve one registration-named overlay under the repo root; refusal names the expected path. */
function overlaySource(repoRoot, registrationPath, overlay) {
  if (typeof overlay !== 'string' || overlay === '') {
    throw new TypeError(`${registrationPath} carries no overlay path for the arm; the confirmatory overlays generate from the committed provisional ones`)
  }
  const source = resolve(repoRoot, overlay)
  if (!existsSync(source)) throw new TypeError(`the committed provisional overlay ${overlay} is missing at ${source}`)
  return source
}

/** Replace the provisional point and its header paragraph in the R overlay text. */
function generateRouteOverlay(text, id, enforced) {
  if (!text.includes(R_PROVISIONAL_PARAGRAPH)) {
    throw new TypeError('route-coldpoint.patch.yml does not carry the expected provisional-point paragraph; refusing to generate from an unexpected shape')
  }
  const matches = [...text.matchAll(PROVISIONAL_R_POINT)]
  if (matches.length !== 1) {
    throw new TypeError(`route-coldpoint.patch.yml must carry exactly one provisional laya operating point without calibratedBy, found ${matches.length}`)
  }
  const [line, indent] = matches[0]
  const point = `${indent}operatingPoints: [{"engine":"laya","downgradeThreshold":${pointNumber(enforced.downgradeThreshold, 'downgradeThreshold')},"downgradeMargin":${pointNumber(enforced.downgradeMargin, 'downgradeMargin')},"calibratedBy":"${id}"}]`
  return text
    .replace(R_PROVISIONAL_PARAGRAPH, R_GENERATED_PARAGRAPH.replaceAll('<id>', id))
    .replace(line, point)
}

/** Replace the provisional rate and seed and their header paragraph in the N overlay text. */
function generateRandomOverlay(text, id, enforced) {
  if (!text.includes(N_PROVISIONAL_PARAGRAPH)) {
    throw new TypeError('random-matched.patch.yml does not carry the expected provisional-rate paragraph; refusing to generate from an unexpected shape')
  }
  for (const [pattern, name] of [[RUNNER_N_RATE, 'entryRate'], [RUNNER_N_SEED, 'seed']]) {
    const found = [...text.matchAll(new RegExp(pattern.source, 'g'))]
    if (found.length !== 1) throw new TypeError(`random-matched.patch.yml must carry exactly one ${name} line, found ${found.length}`)
  }
  return text
    .replace(N_PROVISIONAL_PARAGRAPH, N_GENERATED_PARAGRAPH.replaceAll('<id>', id))
    .replace(new RegExp(RUNNER_N_RATE.source), `entryRate: ${pointNumber(enforced.entryRate, 'entryRate')}`)
    .replace(new RegExp(RUNNER_N_SEED.source), `seed: ${seedNumber(enforced.seed)}`)
}

/** Re-read the generated overlays through the runner's patterns; a mismatch refuses here. */
function assertRunnerShape(rText, nText, enforced) {
  const point = rText.match(RUNNER_R_POINT)
  if (point === null) throw new TypeError("generated R overlay carries no calibrated laya operating point in the runner's pattern")
  if (Number(point[1]) !== enforced.downgradeThreshold || Number(point[2]) !== enforced.downgradeMargin || point[3] !== enforced.calibratedBy) {
    throw new TypeError('generated R overlay does not round-trip the enforced threshold, margin, and calibratedBy')
  }
  const rate = nText.match(RUNNER_N_RATE)
  const seedText = nText.match(RUNNER_N_SEED)
  if (rate === null || seedText === null) throw new TypeError('generated N overlay is missing its entryRate or seed line')
  if (Number(rate[1]) !== enforced.entryRate || Number(seedText[1]) !== enforced.seed) {
    throw new TypeError('generated N overlay does not round-trip the enforced entry rate and seed')
  }
}

/** Serialize one overlay number in the plain decimal form the runner's pattern matches. */
function pointNumber(value, name) {
  const text = String(value)
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(text)) {
    throw new TypeError(`${name} ${value} does not serialize as the plain decimal the overlay pattern matches`)
  }
  return text
}

/** Serialize the seed in the digit form the runner's pattern matches. */
function seedNumber(seed) {
  const text = String(seed)
  if (!/^\d+$/.test(text)) throw new TypeError(`seed ${seed} does not serialize as the digits the overlay pattern matches`)
  return text
}

/** Write through a same-directory temp file and rename; a failed write leaves no temp behind. */
function writeFileAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    writeFileSync(tmp, text)
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // The rename may have completed before the failure surfaced; a stray temp
      // is never mistaken for the registration, whose schema field names it.
    }
    throw error
  }
}

/** The committed R overlay's provisional-point paragraph, replaced only as this exact text. */
const R_PROVISIONAL_PARAGRAPH = [
  '# The router posture below restates the frozen gate of bench/jev-preregistration.md;',
  '# the operating point is the one difference. The point shipped here is',
  "# PROVISIONAL and deliberately carries NO calibratedBy: in the router that key's",
  '# presence alone marks a point calibrated, so writing the preregistration id',
  '# here would misrepresent an enforced gate that has not run. The offline replay',
  '# (bench/routing/replay-judges.mjs) is the only writer of calibratedBy and of',
  "# this point's threshold and margin; the runner refuses confirmatory trials",
  '# unless the registration records a passed Laya gate and the overlay equals it.',
  '# Until then this point logs as an uncalibrated point and the router keeps the',
  '# strong route, fail-closed.',
].join('\n')

/** The paragraph the generated R overlay carries in its place; <id> becomes the registration id. */
const R_GENERATED_PARAGRAPH = [
  '# GENERATED by bench/routing/write-registration.js from the registration',
  '# bench/routing/<id>.registration.json after its replay gate passed: the',
  '# operating point below carries the enforced threshold, margin, and',
  '# calibratedBy id, and the runner refuses confirmatory trials unless this',
  '# overlay equals the registration. The committed route-coldpoint.patch.yml',
  '# keeps its provisional point without calibratedBy and is never overwritten;',
  '# this generated file is the confirmatory composition.',
].join('\n')

/** The committed N overlay's provisional-rate paragraph, replaced only as this exact text. */
const N_PROVISIONAL_PARAGRAPH = [
  '# The entry rate and seed shipped here are PROVISIONAL and the operating point',
  '# deliberately carries NO calibratedBy (its presence alone would mark the point',
  '# calibrated): replay-judges.mjs is the only writer of the matched rate, the',
  "# point's threshold and margin, and the registration's calibratedBy, and the",
  '# runner refuses confirmatory trials unless the registration records a passed',
  "# Laya gate, a matching overlay, and N's rate equal to R's realized entry rate.",
].join('\n')

/** The paragraph the generated N overlay carries in its place; <id> becomes the registration id. */
const N_GENERATED_PARAGRAPH = [
  '# GENERATED by bench/routing/write-registration.js from the registration',
  '# bench/routing/<id>.registration.json after its replay gate passed: the',
  '# entryRate and seed below are the enforced values, and the runner refuses',
  "# confirmatory trials unless they equal the registration's. The operating point",
  "# stays as the provisional overlay ships it: the replay calibrated R's gate",
  "# quantities, not N's thresholds, and the seeded draw ignores them, so N's",
  '# point keeps no calibratedBy. The committed random-matched.patch.yml is never',
  '# overwritten; this generated file is the confirmatory composition.',
].join('\n')

/** Usage exit code, matching the runner CLI's convention. */
const EXIT_USAGE = 2

/** CLI entry: `node bench/routing/write-registration.js <metrics.json> --seed <n> --registration <path> --out-dir <dir>`. */
function main(argv) {
  const positional = []
  const flags = {}
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]
    if (arg === '--seed' || arg === '--registration' || arg === '--out-dir') {
      const value = argv[at + 1]
      if (value === undefined) throw new TypeError(`${arg} requires a value`)
      flags[arg] = value
      at += 1
    } else if (arg.startsWith('--')) {
      throw new TypeError(`unknown flag ${arg}`)
    } else {
      positional.push(arg)
    }
  }
  if (positional.length !== 1 || flags['--seed'] === undefined || flags['--registration'] === undefined || flags['--out-dir'] === undefined) {
    throw new TypeError('usage: write-registration.js <metrics.json> --seed <n> --registration <path> --out-dir <dir>')
  }
  const seed = Number(flags['--seed'])
  if (!Number.isSafeInteger(seed) || seed < 0) throw new TypeError(`--seed must be a non-negative integer, got ${flags['--seed']}`)
  let metrics
  try {
    metrics = JSON.parse(readFileSync(positional[0], 'utf8'))
  } catch (error) {
    throw new TypeError(`${positional[0]} is not readable JSON (${error.message})`)
  }
  const result = writeRegistration({
    registrationPath: flags['--registration'],
    metrics,
    seed,
    outDir: flags['--out-dir'],
  })
  if (result.replayGate === 'passed') {
    console.log(`registration finalized: replayGate passed, enforced ${JSON.stringify(result.enforced)}`)
    console.log(`confirmatory overlays: ${result.overlays.routeColdpoint}`)
    console.log(`                        ${result.overlays.randomMatched}`)
  } else {
    console.log('registration recorded: replayGate failed (metrics embedded, no enforced block; the runner refuses confirmatory arms)')
  }
}

const invokedAsScript = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedAsScript) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof TypeError ? error.message : error)
    process.exitCode = EXIT_USAGE
  }
}
