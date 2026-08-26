/**
 * OOLONG-lite corpus generator and instruction templates.
 *
 * Seeded by `mulberry32` from `bench/stats/intervals.js`. Equal seeds emit
 * byte-identical JSONL corpora and the same integer answers. Names are
 * consonant-vowel syllables from a fixed non-English table so they are not
 * recallable words. Regeneration: `node bench/tasks/oolong-aggregate/generate.mjs`
 * (rewrites all three OOLONG-lite task directories).
 *
 * @module bench/tasks/oolong-lib
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mulberry32 } from '../stats/intervals.js'

/** Pinned seed recorded in each OOLONG-lite `task.json`. */
export const OOLONG_SEED = 20260826

/** Corpus length. Regeneration with this count is the committed fixture. */
export const ROW_COUNT = 400

/** Category alphabet. */
export const CATEGORIES = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F'])

/** Scratch-relative JSONL path copied from `fixture/`. */
export const CORPUS_FILE = 'corpus.jsonl'

/** Scratch-relative answers file the instruction names. */
export const ANSWERS_FILE = 'answers.json'

/** First-letter onsets; every name starts with one of these so CVC tokens cannot be English words. */
const FIRST_ONSETS = Object.freeze(['q', 'x', 'z'])

/** Later onsets; excludes letters that complete common English CVC (t/p/n/g). */
const ONSETS = Object.freeze(['q', 'x', 'z', 'v', 'w', 'k'])

/** Nuclei; `u` is omitted so a leading `q` cannot form `qua`/`quo`. */
const NUCLEI = Object.freeze(['a', 'e', 'i', 'o', 'y'])

/**
 * @typedef {object} CorpusRow
 * @property {string} id - `r` plus a zero-padded index.
 * @property {string} name - 3–6 character synthetic token.
 * @property {number} value - integer 1–999.
 * @property {string} category - one of {@link CATEGORIES}.
 */

/**
 * @typedef {object} AggregateConstants
 * @property {number} N - q1 threshold: category C and value > N.
 * @property {string} D - q2 category letter.
 * @property {number} X - q4 inclusive lower bound.
 * @property {number} Y - q4 inclusive upper bound.
 */

/**
 * @typedef {object} PairConstants
 * @property {number} lo - inclusive end of bucket b0; b1 starts at lo+1.
 * @property {number} hi - inclusive end of bucket b1; b2 starts at hi+1.
 * @property {string[]} categories - three category letters, sorted, used as columns.
 */

/**
 * @typedef {object} AggregateAnswers
 * @property {number} q1
 * @property {number} q2
 * @property {number} q3
 * @property {number} q4
 */

/**
 * @typedef {object} PairAnswers
 * @property {number[][]} matrix - 3×3 integers, rows b0–b2, columns `categories`.
 */

/**
 * @typedef {object} OolongGenerated
 * @property {number} seed
 * @property {CorpusRow[]} rows
 * @property {string} corpusText - JSONL including the trailing newline.
 * @property {AggregateConstants} aggregate
 * @property {PairConstants} pairs
 * @property {AggregateAnswers} aggregateAnswers
 * @property {PairAnswers} pairAnswers
 */

/**
 * @typedef {'stuffed' | 'read' | 'code' | null} OolongCue
 */

/** Roman-numeral spellings that would otherwise be legal CVC(V…) tokens. */
const REJECT_NAME = /^(?:xiv|xvi|xix|xii|xxi|xxx|xvii|xxii|viii|vii|iii|xiii)$/

/**
 * Draw one CVC(V…) token of length 3–6.
 * @param {() => number} rng - mulberry32 stream.
 * @returns {string} a name of the requested length.
 */
function drawName(rng) {
  const length = 3 + Math.floor(rng() * 4)
  let name = /** @type {string} */ (FIRST_ONSETS[Math.floor(rng() * FIRST_ONSETS.length)])
  let consonantNext = false
  while (name.length < length) {
    name += consonantNext
      ? ONSETS[Math.floor(rng() * ONSETS.length)]
      : NUCLEI[Math.floor(rng() * NUCLEI.length)]
    consonantNext = !consonantNext
  }
  return name
}

/**
 * Draw a 3–6 character name from the onset/nucleus tables. Redraws roman-numeral
 * spellings from the same stream so a fixture rebuilt from the same seed stays
 * byte-identical.
 * @param {() => number} rng - mulberry32 stream.
 * @returns {string} a synthetic token.
 */
export function generateName(rng) {
  let name = drawName(rng)
  while (REJECT_NAME.test(name)) name = drawName(rng)
  return name
}

/**
 * Serialize rows as JSONL with a trailing newline. Key order is id, name,
 * value, category.
 * @param {CorpusRow[]} rows - generated rows.
 * @returns {string} byte-stable JSONL.
 */
export function serializeCorpus(rows) {
  return `${rows.map(row => JSON.stringify({
    id: row.id,
    name: row.name,
    value: row.value,
    category: row.category,
  })).join('\n')}\n`
}

/**
 * Compute the four aggregate answers from a corpus and the planted constants.
 * @param {CorpusRow[]} rows - corpus.
 * @param {AggregateConstants} constants - N, D, X, Y.
 * @returns {AggregateAnswers} integer answers.
 */
export function computeAggregateAnswers(rows, constants) {
  const names = new Set()
  let q1 = 0
  let q2 = 0
  let q4 = 0
  for (const row of rows) {
    names.add(row.name)
    if (row.category === 'C' && row.value > constants.N) q1 += 1
    if (row.category === constants.D) q2 += row.value
    if (row.value >= constants.X && row.value <= constants.Y) q4 += 1
  }
  return { q1, q2, q3: names.size, q4 }
}

/**
 * Compute the 3×3 (range-bucket × category) count matrix.
 * @param {CorpusRow[]} rows - corpus.
 * @param {PairConstants} constants - buckets and column categories.
 * @returns {PairAnswers} integer matrix.
 */
export function computePairAnswers(rows, constants) {
  /** @type {(value: number) => boolean}[] */
  const buckets = [
    value => value >= 1 && value <= constants.lo,
    value => value >= constants.lo + 1 && value <= constants.hi,
    value => value >= constants.hi + 1 && value <= 999,
  ]
  const matrix = buckets.map(inBucket => constants.categories.map(category => {
    let count = 0
    for (const row of rows) {
      if (row.category === category && inBucket(row.value)) count += 1
    }
    return count
  }))
  return { matrix }
}

/**
 * Generate the corpus, question constants, and ground-truth answers from a seed.
 * Constants are drawn first so they do not depend on name-generation consumption.
 * @param {number} [seed] - mulberry32 seed; default {@link OOLONG_SEED}.
 * @returns {OolongGenerated} deterministic corpus and answers.
 */
export function generateOolong(seed = OOLONG_SEED) {
  const rng = mulberry32(seed)
  const N = 100 + Math.floor(rng() * 700)
  const D = CATEGORIES[Math.floor(rng() * CATEGORIES.length)]
  const X = 1 + Math.floor(rng() * 400)
  const span = 80 + Math.floor(rng() * 400)
  const Y = Math.min(999, X + span)
  const lo = 120 + Math.floor(rng() * 220)
  const hi = Math.min(850, lo + 120 + Math.floor(rng() * 220))
  const pool = [...CATEGORIES]
  /** @type {string[]} */
  const pairCategories = []
  for (let index = 0; index < 3; index += 1) {
    const pick = Math.floor(rng() * pool.length)
    pairCategories.push(/** @type {string} */ (pool.splice(pick, 1)[0]))
  }
  pairCategories.sort()

  /** @type {CorpusRow[]} */
  const rows = []
  for (let index = 0; index < ROW_COUNT; index += 1) {
    rows.push({
      id: `r${String(index).padStart(3, '0')}`,
      name: generateName(rng),
      value: 1 + Math.floor(rng() * 999),
      category: /** @type {string} */ (CATEGORIES[Math.floor(rng() * CATEGORIES.length)]),
    })
  }

  const aggregate = { N, D, X, Y }
  const pairs = { lo, hi, categories: pairCategories }
  return {
    seed,
    rows,
    corpusText: serializeCorpus(rows),
    aggregate,
    pairs,
    aggregateAnswers: computeAggregateAnswers(rows, aggregate),
    pairAnswers: computePairAnswers(rows, pairs),
  }
}

/**
 * Shared description of the JSONL schema, used by every instruction.
 * @returns {string} one paragraph.
 */
function schemaSentence() {
  return 'Each line is one JSON object with fields id (synthetic token r000–r399), name (a 3–6 character non-English token), value (integer 1–999), and category (a single letter A–F).'
}

/**
 * Cue line appended only on the cued task family. Null means no cue.
 * @param {OolongCue} cue - arm-specific cue, or null.
 * @returns {string} a trailing paragraph, or empty.
 */
function cueParagraph(cue) {
  if (cue === 'read') {
    return 'To answer without re-reading files, use session_search / session_event_search over your earlier reads.'
  }
  if (cue === 'code') {
    return 'To answer without re-reading files, write one run_code program that loads corpus.jsonl and computes all four answers in one pass.'
  }
  if (cue === 'stuffed') {
    return 'The corpus is inlined above; compute the four answers from that table.'
  }
  return ''
}

/**
 * Join instruction sections, omitting empty ones.
 * @param {string[]} parts - paragraphs.
 * @returns {string} the instruction.
 */
function joinParts(parts) {
  return parts.filter(part => part.length > 0).join('\n\n')
}

/**
 * Render the four aggregate questions and the required answers.json format.
 * @param {AggregateConstants} constants - planted N/D/X/Y.
 * @returns {string} question block.
 */
function aggregateQuestionBlock(constants) {
  return [
    'Answer these four questions over the corpus. Integers only.',
    `q1: How many rows have category C and value greater than ${constants.N}?`,
    `q2: What is the sum of value over rows whose category is ${constants.D}?`,
    'q3: How many distinct names appear in the corpus?',
    `q4: How many rows have value in the closed interval [${constants.X}, ${constants.Y}]?`,
    `Write a JSON object to ${ANSWERS_FILE} at the workspace root with exactly these keys and integer values:`,
    '{"q1": <int>, "q2": <int>, "q3": <int>, "q4": <int>}',
    'No extra keys, no floats, no surrounding commentary.',
  ].join('\n')
}

/**
 * Render the 3×3 pairs question and the required answers.json format.
 * @param {PairConstants} constants - buckets and columns.
 * @returns {string} question block.
 */
function pairQuestionBlock(constants) {
  const [c0, c1, c2] = constants.categories
  return [
    'Build the 3x3 count matrix of (range bucket × category).',
    'Value range buckets (inclusive):',
    `- b0: value in [1, ${constants.lo}]`,
    `- b1: value in [${constants.lo + 1}, ${constants.hi}]`,
    `- b2: value in [${constants.hi + 1}, 999]`,
    `Category columns, in this order: ${c0}, ${c1}, ${c2}.`,
    'Each cell is the number of rows whose value falls in that bucket AND whose category is that column. Rows whose category is not one of those three letters do not appear in the matrix.',
    `Write a JSON object to ${ANSWERS_FILE} at the workspace root:`,
    '{"matrix": [[n00, n01, n02], [n10, n11, n12], [n20, n21, n22]]}',
    `Rows are b0, b1, b2. Columns follow the category order ${c0}, ${c1}, ${c2}. Integers only. No extra keys.`,
  ].join('\n')
}

/**
 * On-disk (read/code) preamble pointing at fixture/corpus.jsonl.
 * @returns {string} preamble.
 */
function onDiskPreamble() {
  return `The file ${CORPUS_FILE} in this directory has ${ROW_COUNT} rows of JSONL. ${schemaSentence()} Scan the whole file; answers are not stored anywhere else.`
}

/**
 * Stuffed preamble that inlines the corpus so the prompt carries every row.
 * @param {string} corpusText - JSONL including the trailing newline.
 * @returns {string} preamble.
 */
function stuffedPreamble(corpusText) {
  return `The following JSONL table is the complete corpus (${ROW_COUNT} rows). ${schemaSentence()} Do not look for another copy.\n\n\`\`\`\n${corpusText.trimEnd()}\n\`\`\``
}

/**
 * Render one aggregate (or cued-aggregate) instruction.
 * @param {object} options
 * @param {AggregateConstants} options.constants
 * @param {string} options.corpusText
 * @param {boolean} options.stuffed - inline the corpus.
 * @param {OolongCue} [options.cue] - cued-family final line; omit on the uncued task.
 * @returns {string} the model-visible instruction.
 */
export function renderAggregateInstruction({ constants, corpusText, stuffed, cue = null }) {
  return joinParts([
    stuffed ? stuffedPreamble(corpusText) : onDiskPreamble(),
    aggregateQuestionBlock(constants),
    cueParagraph(cue),
  ])
}

/**
 * Render one pairs instruction.
 * @param {object} options
 * @param {PairConstants} options.constants
 * @param {string} options.corpusText
 * @param {boolean} options.stuffed - inline the corpus.
 * @returns {string} the model-visible instruction.
 */
export function renderPairInstruction({ constants, corpusText, stuffed }) {
  return joinParts([
    stuffed ? stuffedPreamble(corpusText) : onDiskPreamble(),
    pairQuestionBlock(constants),
  ])
}

/**
 * Exact-match check used by every OOLONG-lite verifier. Objects must have the
 * same keys; arrays the same length; numbers must be integers and equal.
 * @param {unknown} actual - parsed answers.json.
 * @param {unknown} expected - task.json expectedAnswers.
 * @param {string} [path] - dotted path for the error.
 * @returns {string | null} a failure detail, or null when equal.
 */
export function exactAnswersMismatch(actual, expected, path = '') {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path || 'value'} is not an array`
    if (actual.length !== expected.length) {
      return `${path || 'array'} length ${actual.length} !== ${expected.length}`
    }
    for (let index = 0; index < expected.length; index += 1) {
      const mismatch = exactAnswersMismatch(actual[index], expected[index], `${path}[${index}]`)
      if (mismatch !== null) return mismatch
    }
    return null
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      return `${path || 'value'} is not an object`
    }
    const actualRecord = /** @type {Record<string, unknown>} */ (actual)
    const expectedRecord = /** @type {Record<string, unknown>} */ (expected)
    const actualKeys = Object.keys(actualRecord).sort()
    const expectedKeys = Object.keys(expectedRecord).sort()
    if (actualKeys.join('\0') !== expectedKeys.join('\0')) {
      return `${path || 'object'} keys ${JSON.stringify(actualKeys)} !== ${JSON.stringify(expectedKeys)}`
    }
    for (const key of expectedKeys) {
      const mismatch = exactAnswersMismatch(actualRecord[key], expectedRecord[key], path === '' ? key : `${path}.${key}`)
      if (mismatch !== null) return mismatch
    }
    return null
  }
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !Number.isInteger(actual)) {
      return `${path || 'value'} is not an integer`
    }
    if (actual !== expected) return `${path || 'value'} expected ${expected} got ${actual}`
    return null
  }
  if (actual !== expected) return `${path || 'value'} expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`
  return null
}

const TASKS_ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * Write corpus.jsonl and task.json for one OOLONG-lite task directory.
 * @param {string} taskId - directory name under bench/tasks.
 * @param {Record<string, unknown>} definition - full task.json body.
 * @param {string} corpusText - JSONL including the trailing newline.
 * @returns {void}
 */
function writeTaskDir(taskId, definition, corpusText) {
  const dir = join(TASKS_ROOT, taskId)
  mkdirSync(join(dir, 'fixture'), { recursive: true })
  writeFileSync(join(dir, 'fixture', CORPUS_FILE), corpusText)
  writeFileSync(join(dir, 'task.json'), `${JSON.stringify(definition, null, 2)}\n`)
}

/**
 * Write the three committed OOLONG-lite tasks from one seed. Same seed rewrites
 * identical names, ids, values, and answers.
 * @param {number} [seed] - mulberry32 seed; default {@link OOLONG_SEED}.
 * @returns {OolongGenerated} the generated corpus (tests inspect this).
 */
export function writeOolongTasks(seed = OOLONG_SEED) {
  const generated = generateOolong(seed)
  const { corpusText, aggregate, pairs, aggregateAnswers, pairAnswers } = generated

  const aggregateInstruction = renderAggregateInstruction({
    constants: aggregate, corpusText, stuffed: false,
  })
  const aggregateStuffed = renderAggregateInstruction({
    constants: aggregate, corpusText, stuffed: true,
  })
  writeTaskDir('oolong-aggregate', {
    taskId: 'oolong-aggregate',
    stratum: 'long',
    description: 'Exact-count aggregation over a 400-row synthetic JSONL corpus.',
    seed,
    constants: aggregate,
    expectedAnswers: aggregateAnswers,
    instruction: aggregateInstruction,
    stuffedInstruction: aggregateStuffed,
    verify: 'node verify.mjs',
    timeoutMs: 600000,
    maxTurns: 40,
  }, corpusText)

  const pairInstruction = renderPairInstruction({
    constants: pairs, corpusText, stuffed: false,
  })
  const pairStuffed = renderPairInstruction({
    constants: pairs, corpusText, stuffed: true,
  })
  writeTaskDir('oolong-pairs', {
    taskId: 'oolong-pairs',
    stratum: 'long',
    description: 'Exact 3x3 range-bucket × category count matrix over the same synthetic corpus.',
    seed,
    constants: pairs,
    expectedAnswers: pairAnswers,
    instruction: pairInstruction,
    stuffedInstruction: pairStuffed,
    verify: 'node verify.mjs',
    timeoutMs: 600000,
    maxTurns: 40,
  }, corpusText)

  writeTaskDir('oolong-aggregate-cued', {
    taskId: 'oolong-aggregate-cued',
    stratum: 'long',
    description: 'Same corpus and questions as oolong-aggregate, with an arm-adaptive capability cue.',
    seed,
    constants: aggregate,
    expectedAnswers: aggregateAnswers,
    instruction: renderAggregateInstruction({
      constants: aggregate, corpusText, stuffed: false, cue: 'read',
    }),
    stuffedInstruction: renderAggregateInstruction({
      constants: aggregate, corpusText, stuffed: true, cue: 'stuffed',
    }),
    armInstructions: {
      stuffed: renderAggregateInstruction({
        constants: aggregate, corpusText, stuffed: true, cue: 'stuffed',
      }),
      read: renderAggregateInstruction({
        constants: aggregate, corpusText, stuffed: false, cue: 'read',
      }),
      code: renderAggregateInstruction({
        constants: aggregate, corpusText, stuffed: false, cue: 'code',
      }),
    },
    verify: 'node verify.mjs',
    timeoutMs: 600000,
    maxTurns: 40,
  }, corpusText)

  return generated
}
