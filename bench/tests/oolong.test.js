/**
 * OOLONG-lite generator and verifier tests: seed determinism, planted-question
 * exactness, and verifier discrimination. No API calls.
 *
 * @module bench/tests/oolong
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ANSWERS_FILE,
  CATEGORIES,
  CORPUS_FILE,
  OOLONG_SEED,
  ROW_COUNT,
  computeAggregateAnswers,
  computePairAnswers,
  exactAnswersMismatch,
  generateOolong,
  serializeCorpus,
} from '../tasks/oolong-lib.mjs'

const tasksDir = fileURLToPath(new URL('../tasks/', import.meta.url))

/**
 * @param {string} taskId
 * @returns {Record<string, unknown>}
 */
function loadTask(taskId) {
  return JSON.parse(readFileSync(path.join(tasksDir, taskId, 'task.json'), 'utf8'))
}

/**
 * @param {string} taskId
 * @returns {string}
 */
function loadCorpus(taskId) {
  return readFileSync(path.join(tasksDir, taskId, 'fixture', CORPUS_FILE), 'utf8')
}

/**
 * @param {string} taskId
 * @param {string} scratch
 * @returns {{ status: number | null, output: string }}
 */
function runVerifier(taskId, scratch) {
  const result = spawnSync(process.execPath, [path.join(tasksDir, taskId, 'verify.mjs'), scratch], {
    encoding: 'utf8',
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

test('equal seeds emit byte-identical corpora and answers', () => {
  const a = generateOolong(OOLONG_SEED)
  const b = generateOolong(OOLONG_SEED)
  assert.equal(a.corpusText, b.corpusText)
  assert.deepEqual(a.aggregateAnswers, b.aggregateAnswers)
  assert.deepEqual(a.pairAnswers, b.pairAnswers)
  assert.deepEqual(a.aggregate, b.aggregate)
  assert.deepEqual(a.pairs, b.pairs)
  const other = generateOolong(OOLONG_SEED + 1)
  assert.notEqual(other.corpusText, a.corpusText)
})

test('committed fixtures match generateOolong(seed) and are byte-identical across tasks', () => {
  const generated = generateOolong(OOLONG_SEED)
  for (const taskId of ['oolong-aggregate', 'oolong-pairs', 'oolong-aggregate-cued']) {
    assert.equal(loadCorpus(taskId), generated.corpusText, `${taskId} corpus drifted from the generator`)
  }
  const aggregate = loadTask('oolong-aggregate')
  const pairs = loadTask('oolong-pairs')
  const cued = loadTask('oolong-aggregate-cued')
  assert.equal(aggregate.seed, OOLONG_SEED)
  assert.deepEqual(aggregate.expectedAnswers, generated.aggregateAnswers)
  assert.deepEqual(pairs.expectedAnswers, generated.pairAnswers)
  assert.deepEqual(cued.expectedAnswers, generated.aggregateAnswers)
  assert.deepEqual(aggregate.constants, generated.aggregate)
  assert.deepEqual(cued.constants, generated.aggregate)
  assert.equal(cued.stuffedInstruction, cued.armInstructions.stuffed)
})

test('corpus rows have synthetic ids, non-English names, integer values, and A–F categories', () => {
  const generated = generateOolong(OOLONG_SEED)
  assert.equal(generated.rows.length, ROW_COUNT)
  const namePattern = /^[qxz][aeioyqxzwvk]{2,5}$/
  const roman = /^(?:xiv|xvi|xix|xii|xxi|xxx|xvii|xxii|viii|vii|iii|xiii)$/
  const seen = new Set()
  for (const [index, row] of generated.rows.entries()) {
    assert.equal(row.id, `r${String(index).padStart(3, '0')}`)
    assert.equal(seen.has(row.id), false)
    seen.add(row.id)
    assert.match(row.name, namePattern)
    assert.equal(roman.test(row.name), false)
    assert.ok(row.name.length >= 3 && row.name.length <= 6)
    assert.ok(Number.isInteger(row.value) && row.value >= 1 && row.value <= 999)
    assert.ok(CATEGORIES.includes(row.category))
  }
  assert.equal(serializeCorpus(generated.rows), generated.corpusText)
  assert.equal(generated.corpusText.endsWith('\n'), true)
})

test('planted expectedAnswers equal a fresh scan of the committed corpus', () => {
  const generated = generateOolong(OOLONG_SEED)
  const lines = loadCorpus('oolong-aggregate').trimEnd().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(computeAggregateAnswers(lines, generated.aggregate), generated.aggregateAnswers)
  assert.deepEqual(computePairAnswers(lines, generated.pairs), generated.pairAnswers)
  const aggregate = loadTask('oolong-aggregate')
  assert.equal(exactAnswersMismatch(aggregate.expectedAnswers, generated.aggregateAnswers), null)
  const pairs = loadTask('oolong-pairs')
  assert.equal(exactAnswersMismatch(pairs.expectedAnswers, generated.pairAnswers), null)
})

test('oolong-aggregate: missing file fails, planted answers pass, a wrong integer fails', (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'bench-oolong-aggregate-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))

  const missing = runVerifier('oolong-aggregate', scratch)
  assert.equal(missing.status, 1, missing.output)
  assert.match(missing.output, /answers\.json is missing/)

  const expected = loadTask('oolong-aggregate').expectedAnswers
  writeFileSync(path.join(scratch, ANSWERS_FILE), `${JSON.stringify(expected)}\n`)
  const planted = runVerifier('oolong-aggregate', scratch)
  assert.equal(planted.status, 0, planted.output)
  assert.equal(runVerifier('oolong-aggregate', scratch).status, 0)

  writeFileSync(path.join(scratch, ANSWERS_FILE), `${JSON.stringify({ ...expected, q1: expected.q1 + 1 })}\n`)
  const wrong = runVerifier('oolong-aggregate', scratch)
  assert.equal(wrong.status, 1, wrong.output)
  assert.match(wrong.output, /q1 expected/)
})

test('oolong-aggregate: float or extra key fails exactness', (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'bench-oolong-aggregate-exact-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const expected = loadTask('oolong-aggregate').expectedAnswers

  writeFileSync(path.join(scratch, ANSWERS_FILE), `${JSON.stringify({ ...expected, q1: expected.q1 + 0.5 })}\n`)
  const floated = runVerifier('oolong-aggregate', scratch)
  assert.equal(floated.status, 1, floated.output)
  assert.match(floated.output, /not an integer/)

  writeFileSync(path.join(scratch, ANSWERS_FILE), `${JSON.stringify({ ...expected, extra: 1 })}\n`)
  const extra = runVerifier('oolong-aggregate', scratch)
  assert.equal(extra.status, 1, extra.output)
  assert.match(extra.output, /keys/)
})

test('oolong-pairs: planted matrix passes and a mutated cell fails', (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'bench-oolong-pairs-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))

  assert.equal(runVerifier('oolong-pairs', scratch).status, 1)

  const expected = loadTask('oolong-pairs').expectedAnswers
  writeFileSync(path.join(scratch, ANSWERS_FILE), `${JSON.stringify(expected)}\n`)
  assert.equal(runVerifier('oolong-pairs', scratch).status, 0)

  const mutated = structuredClone(expected)
  mutated.matrix[0][0] += 1
  writeFileSync(path.join(scratch, ANSWERS_FILE), `${JSON.stringify(mutated)}\n`)
  const wrong = runVerifier('oolong-pairs', scratch)
  assert.equal(wrong.status, 1, wrong.output)
  assert.match(wrong.output, /matrix\[0\]\[0\] expected/)
})

test('oolong-aggregate-cued shares answers with oolong-aggregate and its cue adapts per arm', () => {
  const aggregate = loadTask('oolong-aggregate')
  const cued = loadTask('oolong-aggregate-cued')
  assert.deepEqual(cued.expectedAnswers, aggregate.expectedAnswers)
  assert.equal(loadCorpus('oolong-aggregate-cued'), loadCorpus('oolong-aggregate'))
  assert.match(cued.armInstructions.read, /session_search \/ session_event_search/)
  assert.match(cued.armInstructions.code, /run_code program that loads corpus\.jsonl/)
  assert.match(cued.armInstructions.stuffed, /corpus is inlined above/)
  assert.equal(cued.armInstructions.read.includes('run_code program'), false)
  assert.equal(cued.instruction, cued.armInstructions.read)
})

test('cued planted answers pass the cued verifier', (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'bench-oolong-cued-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  writeFileSync(path.join(scratch, ANSWERS_FILE), `${JSON.stringify(loadTask('oolong-aggregate-cued').expectedAnswers)}\n`)
  assert.equal(runVerifier('oolong-aggregate-cued', scratch).status, 0)
})
