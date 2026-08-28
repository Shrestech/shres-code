/**
 * Verifier for the research microcycle tasks: recompute the ground truth from
 * `data.json`, read the agent's `verdict.json`, and score verdict correctness
 * plus the recorded measurement. The dataset is pinned by SHA-256 so an agent
 * cannot edit `data.json` to inflate the share. Arm-neutral: any arm's trial
 * that writes a correct verdict + measurement is gradable.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  DATA_FILE,
  HYPOTHESIS,
  VERDICT_FILE,
  computeTruth,
  dataMatchesFixture,
  expectedVerdict,
  verdictMismatch,
} from '../microcycle-lib.mjs'

/** SHA-256 of the pinned fixture/data.json. */
const DATA_SHA256 = '0080550ee648c64e35965772704be648cc210bdaf6719dc9e293d017c4fd54f7'

const scratch = process.argv[2]
if (!scratch) {
  console.log('fail: usage: node verify.mjs <scratch-dir>')
  process.exit(1)
}

/**
 * Print the one-line detail and exit 1.
 * @param {string} detail - why the scratch dir is not resolved.
 * @returns {never}
 */
function fail(detail) {
  console.log(`fail: ${detail}`)
  process.exit(1)
}

const dataPath = path.join(scratch, DATA_FILE)
if (!existsSync(dataPath)) fail(`${DATA_FILE} is missing`)
const dataText = readFileSync(dataPath, 'utf8')
if (!dataMatchesFixture(dataText, DATA_SHA256)) fail(`${DATA_FILE} was modified; the dataset is part of the measured condition`)

let values
try {
  const parsed = JSON.parse(dataText)
  if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'number')) {
    fail(`${DATA_FILE} is not a numeric array`)
  }
  values = parsed
} catch (error) {
  fail(`${DATA_FILE} is not valid JSON: ${/** @type {Error} */ (error).message}`)
}

const truth = computeTruth(values)
const expected = expectedVerdict(truth.share)

const verdictPath = path.join(scratch, VERDICT_FILE)
if (!existsSync(verdictPath)) fail(`${VERDICT_FILE} is missing`)

let actual
try {
  actual = JSON.parse(readFileSync(verdictPath, 'utf8'))
} catch (error) {
  fail(`${VERDICT_FILE} is not valid JSON: ${/** @type {Error} */ (error).message}`)
}
if (actual.hypothesis !== HYPOTHESIS) fail('hypothesis does not match the task')

const mismatch = verdictMismatch(actual, truth, expected)
if (mismatch !== null) fail(mismatch)

console.log(`ok: verdict ${expected} matches the measured share ${truth.share.toFixed(3)}`)
