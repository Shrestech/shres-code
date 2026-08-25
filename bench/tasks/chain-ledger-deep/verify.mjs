/**
 * Verifier for the chain-ledger-deep task.
 *
 * Resolved when the ledger, REPORT.json, and SUMMARY.json agree on one valid
 * combination of phase-1 free choices (mean|median, half-up|half-even, one of
 * the two tied top categories) and the phase-3 seq base (0|1), the distractor
 * modules behave, fixture data and pinned CLI tests are unchanged, and
 * `node --test` passes. The verifier recomputes every valid combination from
 * the fixture dataset; it does not read the agent's decision file.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const fixture = fileURLToPath(new URL('./fixture/', import.meta.url))
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

/**
 * Convert a dollar amount to integer cents.
 * @param {number} amount - dollars.
 * @param {'half-up' | 'half-even'} rounding - rounding mode.
 * @returns {number} integer cents.
 */
function toCents(amount, rounding) {
  const scaled = amount * 100
  if (rounding === 'half-even') {
    const floor = Math.floor(scaled)
    const frac = scaled - floor
    if (frac < 0.5 - 1e-9) return floor
    if (frac > 0.5 + 1e-9) return floor + 1
    return floor % 2 === 0 ? floor : floor + 1
  }
  return Math.round(scaled)
}

/**
 * Mean and median of a non-empty odd-length amount list.
 * @param {number[]} amounts - dollar amounts.
 * @returns {{ mean: number, median: number }}
 */
function amountStats(amounts) {
  const sorted = [...amounts].sort((a, b) => a - b)
  const mean = amounts.reduce((sum, value) => sum + value, 0) / amounts.length
  const median = sorted[Math.floor(sorted.length / 2)]
  return { mean, median }
}

/**
 * Categories tied for the highest transaction count.
 * @param {{ category: string }[]} transactions - fixture rows.
 * @returns {string[]} category names, sorted.
 */
function tiedTopCategories(transactions) {
  /** @type {Record<string, number>} */
  const counts = {}
  for (const tx of transactions) counts[tx.category] = (counts[tx.category] ?? 0) + 1
  const max = Math.max(...Object.values(counts))
  return Object.keys(counts).filter(name => counts[name] === max).sort()
}

/**
 * Ground truth for one valid choice combination.
 * @param {{ id: string, category: string, amount: number }[]} transactions - fixture rows.
 * @param {{ thresholdStat: 'mean' | 'median', rounding: 'half-up' | 'half-even', primaryCategory: string, entrySeqStart: 0 | 1 }} choice - free choices.
 * @returns {object} expected ledger / report / summary figures.
 */
function groundTruth(transactions, choice) {
  const amounts = transactions.map(tx => tx.amount)
  const stats = amountStats(amounts)
  const threshold = stats[choice.thresholdStat]
  const thresholdCents = toCents(threshold, choice.rounding)
  const entries = transactions.map((tx, index) => {
    const cents = toCents(tx.amount, choice.rounding)
    const bucket = tx.amount > threshold ? 'large' : 'small'
    return { id: tx.id, category: tx.category, bucket, cents, seq: choice.entrySeqStart + index }
  })
  /** @type {Record<string, number>} */
  const byCategory = {}
  const byBucket = { large: 0, small: 0 }
  let postedCents = 0
  let largeCount = 0
  let smallCount = 0
  for (const entry of entries) {
    byCategory[entry.category] = (byCategory[entry.category] ?? 0) + entry.cents
    byBucket[entry.bucket] += entry.cents
    postedCents += entry.cents
    if (entry.bucket === 'large') largeCount += 1
    else smallCount += 1
  }
  byCategory[choice.primaryCategory] = (byCategory[choice.primaryCategory] ?? 0) + 100
  const totalCents = postedCents + 100
  const primaryCents = byCategory[choice.primaryCategory]
  const largeShareBps = Math.round(byBucket.large * 10000 / totalCents)
  const categories = new Set(transactions.map(tx => tx.category))
  return {
    thresholdStat: choice.thresholdStat,
    rounding: choice.rounding,
    primaryCategory: choice.primaryCategory,
    entrySeqStart: choice.entrySeqStart,
    thresholdCents,
    largeCount,
    smallCount,
    totalCents,
    byCategory,
    byBucket,
    primaryCents,
    largeShareBps,
    transactionCount: transactions.length,
    categoryCount: categories.size,
    entries,
  }
}

/**
 * @param {unknown} actual - observed map.
 * @param {Record<string, number>} expected - expected map.
 * @returns {boolean}
 */
function sameIntMap(actual, expected) {
  if (typeof actual !== 'object' || actual === null) return false
  const keys = Object.keys(expected)
  if (Object.keys(actual).length !== keys.length) return false
  for (const key of keys) {
    if (/** @type {Record<string, unknown>} */ (actual)[key] !== expected[key]) return false
  }
  return true
}

/**
 * @param {unknown} value - candidate.
 * @param {number} expected - integer.
 * @returns {boolean}
 */
function sameInt(value, expected) {
  return typeof value === 'number' && Number.isInteger(value) && value === expected
}

/**
 * Load a JSON file from the scratch dir.
 * @param {string} rel - path relative to the scratch dir.
 * @returns {any}
 */
function readScratchJson(rel) {
  const file = path.join(scratch, rel)
  if (!existsSync(file)) fail(`${rel} is missing`)
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    fail(`${rel} is not valid JSON`)
  }
}

for (const rel of ['data/transactions.json', 'data/accounts.json', 'test/cli.test.js']) {
  const target = path.join(scratch, rel)
  if (!existsSync(target)) fail(`${rel} is missing`)
  if (!readFileSync(target).equals(readFileSync(path.join(fixture, rel)))) {
    fail(`${rel} was modified`)
  }
}

const transactions = JSON.parse(readFileSync(path.join(fixture, 'data/transactions.json'), 'utf8'))
const primaries = tiedTopCategories(transactions)
if (primaries.length < 2) fail('fixture data no longer has a tied top category pair')

const cliPath = path.join(scratch, 'src/cli.js')
if (!existsSync(cliPath)) fail('src/cli.js is missing')
let cli
try {
  cli = await import(pathToFileURL(cliPath).href)
} catch {
  fail('src/cli.js failed to load')
}
if (typeof cli.parseArgs !== 'function') fail('src/cli.js does not export parseArgs')
const cliCases = [
  [['--name', 'ada', '--count', '3'], { flags: { name: 'ada', count: '3' }, positionals: [] }],
  [['file.txt', '--verbose'], { flags: { verbose: true }, positionals: ['file.txt'] }],
  [['--out=dest.json'], { flags: { out: 'dest.json' }, positionals: [] }],
  [['--a', '1', '--', '--not-a-flag'], { flags: { a: '1' }, positionals: ['--not-a-flag'] }],
  [['--quiet'], { flags: { quiet: true }, positionals: [] }],
]
for (const [argv, expected] of cliCases) {
  const actual = cli.parseArgs(argv)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`parseArgs(${JSON.stringify(argv)}) returned ${JSON.stringify(actual)}`)
  }
}

const formatPath = path.join(scratch, 'src/format.js')
if (!existsSync(formatPath)) fail('src/format.js is missing')
let format
try {
  format = await import(pathToFileURL(formatPath).href)
} catch {
  fail('src/format.js failed to load')
}
for (const name of ['padRight', 'columnize', 'formatCents']) {
  if (typeof format[name] !== 'function') fail(`src/format.js does not export ${name}`)
}
if (format.padRight('ab', 5) !== 'ab   ') fail('padRight(\'ab\', 5) is wrong')
if (format.padRight('abcdef', 4) !== 'abcd') fail('padRight(\'abcdef\', 4) is wrong')
if (format.columnize([['id', 'amt'], ['a', '1']], [3, 3]) !== 'id  amt\na   1  ') {
  fail('columnize example is wrong')
}
if (format.formatCents(1234) !== '$12.34') fail('formatCents(1234) is wrong')
if (format.formatCents(0) !== '$0.00') fail('formatCents(0) is wrong')
if (format.formatCents(-50) !== '-$0.50') fail('formatCents(-50) is wrong')

const ledgerPath = path.join(scratch, 'src/ledger.js')
if (!existsSync(ledgerPath)) fail('src/ledger.js is missing')
let ledger
try {
  ledger = await import(pathToFileURL(ledgerPath).href)
} catch {
  fail('src/ledger.js failed to load')
}
if (typeof ledger.classify !== 'function') fail('src/ledger.js does not export classify')
if (typeof ledger.post !== 'function') fail('src/ledger.js does not export post')

let posted
try {
  posted = ledger.post(transactions)
} catch {
  fail('ledger.post threw')
}
if (!posted || !Array.isArray(posted.entries) || posted.entries.length !== transactions.length) {
  fail('ledger.post must return one entry per transaction')
}

/** @type {object[]} */
const combos = []
for (const thresholdStat of /** @type {const} */ (['mean', 'median'])) {
  for (const rounding of /** @type {const} */ (['half-up', 'half-even'])) {
    for (const primaryCategory of primaries) {
      for (const entrySeqStart of /** @type {const} */ ([0, 1])) {
        combos.push(groundTruth(transactions, { thresholdStat, rounding, primaryCategory, entrySeqStart }))
      }
    }
  }
}

/**
 * @param {object} truth - one ground-truth combination.
 * @returns {boolean} whether ledger.post matches this combination.
 */
function ledgerMatches(truth) {
  if (!sameInt(posted.totalCents, truth.totalCents)) return false
  if (!sameIntMap(posted.byCategory, truth.byCategory)) return false
  if (!sameInt(posted.byBucket?.large, truth.byBucket.large)) return false
  if (!sameInt(posted.byBucket?.small, truth.byBucket.small)) return false
  for (let i = 0; i < truth.entries.length; i++) {
    const actual = posted.entries[i]
    const expected = truth.entries[i]
    if (!actual || actual.id !== expected.id || actual.category !== expected.category) return false
    if (actual.bucket !== expected.bucket || actual.cents !== expected.cents || actual.seq !== expected.seq) {
      return false
    }
    let classified
    try {
      classified = ledger.classify(transactions[i])
    } catch {
      return false
    }
    if (classified?.bucket !== expected.bucket || classified?.cents !== expected.cents
      || classified?.category !== expected.category) {
      return false
    }
  }
  return true
}

const ledgerHits = combos.filter(ledgerMatches)
if (ledgerHits.length === 0) {
  fail('inconsistent: ledger does not honor any valid recorded-decision combination')
}
if (ledgerHits.length > 1) {
  fail('inconsistent: ledger matches more than one valid decision combination')
}
const truth = ledgerHits[0]

const reportPath = path.join(scratch, 'src/report.js')
if (!existsSync(reportPath)) fail('src/report.js is missing')
let reportMod
try {
  reportMod = await import(pathToFileURL(reportPath).href)
} catch {
  fail('src/report.js failed to load')
}
if (typeof reportMod.generateReport !== 'function') fail('src/report.js does not export generateReport')

const report = readScratchJson('REPORT.json')
const summary = readScratchJson('SUMMARY.json')

/**
 * @param {string} label - artifact name.
 * @param {any} actual - observed record.
 * @param {boolean} isSummary - extra SUMMARY fields.
 * @returns {void}
 */
function assertArtifact(label, actual, isSummary) {
  if (actual?.rounding !== truth.rounding) fail(`inconsistent: ${label} rounding contradicts the ledger`)
  if (actual?.thresholdStat !== truth.thresholdStat) {
    fail(`inconsistent: ${label} thresholdStat contradicts the ledger`)
  }
  if (actual?.primaryCategory !== truth.primaryCategory) {
    fail(`inconsistent: ${label} primaryCategory contradicts the ledger`)
  }
  if (!sameInt(actual?.thresholdCents, truth.thresholdCents)) {
    fail(`inconsistent: ${label} thresholdCents contradicts the ledger`)
  }
  if (!sameInt(actual?.largeCount, truth.largeCount)) {
    fail(`inconsistent: ${label} largeCount contradicts the ledger`)
  }
  if (!sameInt(actual?.smallCount, truth.smallCount)) {
    fail(`inconsistent: ${label} smallCount contradicts the ledger`)
  }
  if (!sameInt(actual?.totalCents, truth.totalCents)) {
    fail(`inconsistent: ${label} totalCents contradicts the ledger`)
  }
  if (!sameInt(actual?.primaryCents, truth.primaryCents)) {
    fail(`inconsistent: ${label} primaryCents contradicts the ledger`)
  }
  if (!sameInt(actual?.entrySeqStart, truth.entrySeqStart)) {
    fail(`inconsistent: ${label} entrySeqStart contradicts the ledger`)
  }
  if (!isSummary && !sameIntMap(actual?.byCategory, truth.byCategory)) {
    fail(`inconsistent: ${label} byCategory contradicts the ledger`)
  }
  if (isSummary) {
    if (!sameInt(actual?.transactionCount, truth.transactionCount)) {
      fail(`inconsistent: ${label} transactionCount is wrong`)
    }
    if (!sameInt(actual?.categoryCount, truth.categoryCount)) {
      fail(`inconsistent: ${label} categoryCount is wrong`)
    }
    if (!sameInt(actual?.largeShareBps, truth.largeShareBps)) {
      fail(`inconsistent: ${label} largeShareBps contradicts the ledger`)
    }
  }
}

assertArtifact('REPORT.json', report, false)
assertArtifact('SUMMARY.json', {
  ...summary,
  rounding: truth.rounding,
  thresholdStat: truth.thresholdStat,
  byCategory: truth.byCategory,
}, true)

const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

console.log('ok: ledger, report, and summary agree on one recorded-decision combination')
