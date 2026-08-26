/**
 * Verifier for oolong-aggregate-cued: identical to oolong-aggregate (same
 * planted answers). The agent never sees task.json.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { ANSWERS_FILE, exactAnswersMismatch } from '../oolong-lib.mjs'

const scratch = process.argv[2]
if (!scratch) {
  console.log('fail: usage: node verify.mjs <scratch-dir>')
  process.exit(1)
}

/**
 * @param {string} detail
 * @returns {never}
 */
function fail(detail) {
  console.log(`fail: ${detail}`)
  process.exit(1)
}

const answersPath = path.join(scratch, ANSWERS_FILE)
if (!existsSync(answersPath)) fail(`${ANSWERS_FILE} is missing`)

let actual
try {
  actual = JSON.parse(readFileSync(answersPath, 'utf8'))
} catch (error) {
  fail(`${ANSWERS_FILE} is not valid JSON: ${/** @type {Error} */ (error).message}`)
}

const expected = JSON.parse(readFileSync(new URL('./task.json', import.meta.url), 'utf8')).expectedAnswers
const mismatch = exactAnswersMismatch(actual, expected)
if (mismatch !== null) fail(mismatch)

console.log('ok: q1–q4 match')
