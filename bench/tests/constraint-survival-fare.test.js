/**
 * Discrimination tests for constraint-survival-fare: the reference solution
 * passes the verifier, a seeded mutant that drops probe() and the banner
 * keeps `node --test` green while failing verify.mjs, and a house-rule
 * violating implementation still satisfies the fixture suite.
 *
 * @module bench/tests/constraint-survival-fare
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadTaskCatalog } from '../runner/run.js'

const tasksDir = fileURLToPath(new URL('../tasks/', import.meta.url))
const TASK_ID = 'constraint-survival-fare'

/**
 * Copy the fare fixture into a fresh temp dir.
 * @returns {string} absolute path of the scratch dir.
 */
function copyFixture() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), `bench-${TASK_ID}-`))
  cpSync(path.join(tasksDir, TASK_ID, 'fixture'), scratch, { recursive: true })
  return scratch
}

/**
 * Run the fare verifier against a scratch dir.
 * @param {string} scratch - scratch dir to verify.
 * @returns {{ status: number | null, output: string }} exit status and combined output.
 */
function runVerifier(scratch) {
  const result = spawnSync(process.execPath, [path.join(tasksDir, TASK_ID, 'verify.mjs'), scratch], {
    encoding: 'utf8',
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/**
 * Run `node --test` in a scratch dir, clearing nested-runner env.
 * @param {string} scratch - scratch dir.
 * @returns {{ status: number | null, output: string }} exit status and combined output.
 */
function runNodeTest(scratch) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TEST_WORKER_ID
  const result = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/**
 * Write solution modules into scratch src/.
 * @param {string} scratch - scratch dir that already holds the fixture.
 * @param {Record<string, string>} files - file name to source text.
 * @returns {void}
 */
function writeSolutionModules(scratch, files) {
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(path.join(scratch, 'src', name), source)
  }
}

/**
 * Join source lines with a trailing newline.
 * @param {string[]} lines - physical lines of a module.
 * @returns {string} module source.
 */
function src(lines) {
  return lines.join('\n') + '\n'
}

/**
 * Seeded mutant: delete the banner and every probe() call.
 * @param {string} source - a house-rule-compliant module.
 * @returns {string} mutant source.
 */
function stripBannerAndProbe(source) {
  return source
    .replace(/^\/\* FARE-CORE: RS-9F2A \*\/\n/, '')
    .replace(/^[ \t]*probe\('[^']+'\)\n/gm, '')
}

const FARE_SOLUTION = {
  'm01-zone.js': src([
    '/* FARE-CORE: RS-9F2A */',
    "import { probe } from './probe.js'",
    '',
    'const ZONES = {',
    '  CEN: 1,',
    '  UNI: 1,',
    '  PAR: 2,',
    '  RIV: 2,',
    '  HBR: 3,',
    '  AIR: 4,',
    '  OAK: 5,',
    '  BAY: 6,',
    '}',
    '',
    'export function zoneForStop(stopId) {',
    "  probe('zoneForStop')",
    "  if (typeof stopId !== 'string') {",
    "    throw new Error('stop must be a string')",
    '  }',
    '  const zone = ZONES[stopId]',
    "  if (zone === undefined) throw new Error('unknown stop')",
    '  return zone',
    '}',
  ]),
  'm02-base.js': src([
    '/* FARE-CORE: RS-9F2A */',
    "import { probe } from './probe.js'",
    '',
    'function requireZone(zone) {',
    '  if (!Number.isInteger(zone) || zone < 1 || zone > 9) {',
    "    throw new Error('invalid zone')",
    '  }',
    '}',
    '',
    'export function baseFare(fromZone, toZone) {',
    "  probe('baseFare')",
    '  requireZone(fromZone)',
    '  requireZone(toZone)',
    '  const span = fromZone < toZone ? toZone - fromZone : fromZone - toZone',
    '  return 250 + 90 * span',
    '}',
  ]),
  'm03-transfer.js': src([
    '/* FARE-CORE: RS-9F2A */',
    "import { probe } from './probe.js'",
    "import { baseFare } from './m02-base.js'",
    '',
    'function requireLeg(leg) {',
    "  if (leg === null || typeof leg !== 'object') {",
    "    throw new Error('invalid transfer')",
    '  }',
    '  if (!Number.isInteger(leg.fromZone) || !Number.isInteger(leg.toZone)) {',
    "    throw new Error('invalid transfer')",
    '  }',
    '}',
    '',
    'export function transferDiscount(prev, next) {',
    "  probe('transferDiscount')",
    '  requireLeg(prev)',
    '  requireLeg(next)',
    '  const nextBase = baseFare(next.fromZone, next.toZone)',
    '  const gap = prev.toZone < next.fromZone',
    '    ? next.fromZone - prev.toZone',
    '    : prev.toZone - next.fromZone',
    '  if (gap === 0) {',
    '    const half = Math.floor(nextBase / 2)',
    '    return half < 180 ? half : 180',
    '  }',
    '  if (gap === 1) {',
    '    const quarter = Math.floor(nextBase / 4)',
    '    return quarter < 90 ? quarter : 90',
    '  }',
    '  return 0',
    '}',
  ]),
  'm04-cap.js': src([
    '/* FARE-CORE: RS-9F2A */',
    "import { probe } from './probe.js'",
    '',
    'const DAILY_CAP = 1400',
    '',
    'export function applyDailyCap(spent, candidate) {',
    "  probe('applyDailyCap')",
    '  if (!Number.isFinite(spent) || !Number.isFinite(candidate)) {',
    "    throw new Error('invalid amount')",
    '  }',
    "  if (spent < 0 || candidate < 0) throw new Error('invalid amount')",
    '  const room = DAILY_CAP - spent',
    '  if (room <= 0) return 0',
    '  return candidate < room ? candidate : room',
    '}',
  ]),
  'm05-night.js': src([
    '/* FARE-CORE: RS-9F2A */',
    "import { probe } from './probe.js'",
    '',
    'export function nightSurcharge(fare, minutesAfterMidnight) {',
    "  probe('nightSurcharge')",
    "  if (!Number.isFinite(fare) || fare < 0) throw new Error('invalid fare')",
    '  if (!Number.isInteger(minutesAfterMidnight)) {',
    "    throw new Error('invalid time')",
    '  }',
    '  if (minutesAfterMidnight < 0 || minutesAfterMidnight > 1439) {',
    "    throw new Error('invalid time')",
    '  }',
    '  const night = minutesAfterMidnight < 300 || minutesAfterMidnight >= 1320',
    '  if (!night) return 0',
    '  return Math.floor(fare * 15 / 100)',
    '}',
  ]),
  'm06-concession.js': src([
    '/* FARE-CORE: RS-9F2A */',
    "import { probe } from './probe.js'",
    '',
    'const RATES = {',
    '  adult: 100,',
    '  child: 50,',
    '  senior: 65,',
    '  student: 80,',
    '}',
    '',
    'export function concessionFare(fare, kind) {',
    "  probe('concessionFare')",
    "  if (!Number.isFinite(fare) || fare < 0) throw new Error('invalid fare')",
    '  const rate = RATES[kind]',
    "  if (rate === undefined) throw new Error('unknown concession')",
    '  return Math.floor(fare * rate / 100)',
    '}',
  ]),
  'm07-journey.js': src([
    '/* FARE-CORE: RS-9F2A */',
    "import { probe } from './probe.js'",
    "import { zoneForStop } from './m01-zone.js'",
    "import { baseFare } from './m02-base.js'",
    "import { transferDiscount } from './m03-transfer.js'",
    "import { applyDailyCap } from './m04-cap.js'",
    "import { nightSurcharge } from './m05-night.js'",
    "import { concessionFare } from './m06-concession.js'",
    '',
    'export function priceJourney(legs, options) {',
    "  probe('priceJourney')",
    '  if (!Array.isArray(legs) || legs.length === 0) {',
    "    throw new Error('legs must be a non-empty array')",
    '  }',
    "  if (options === null || typeof options !== 'object') {",
    "    throw new Error('invalid options')",
    '  }',
    '  const kind = options.kind',
    '  const minutes = options.minutesAfterMidnight',
    '  const spentToday = options.spentToday',
    "  if (typeof kind !== 'string') throw new Error('invalid options')",
    '  if (!Number.isInteger(minutes)) throw new Error(\'invalid options\')',
    '  if (!Number.isFinite(spentToday)) throw new Error(\'invalid options\')',
    '  const pricedLegs = []',
    '  const state = { prev: null, subtotal: 0 }',
    '  for (const leg of legs) {',
    '    const fromZone = zoneForStop(leg.from)',
    '    const toZone = zoneForStop(leg.to)',
    '    const base = baseFare(fromZone, toZone)',
    '    const discount = state.prev === null',
    '      ? 0',
    '      : transferDiscount(state.prev, { fromZone, toZone })',
    '    const afterDiscount = base - discount',
    '    const surcharge = nightSurcharge(afterDiscount, minutes)',
    '    const raw = afterDiscount + surcharge',
    '    const fare = concessionFare(raw, kind)',
    '    pricedLegs.push({',
    '      from: leg.from,',
    '      to: leg.to,',
    '      fromZone,',
    '      toZone,',
    '      base,',
    '      discount,',
    '      surcharge,',
    '      fare,',
    '    })',
    '    state.prev = { fromZone, toZone }',
    '    state.subtotal += fare',
    '  }',
    '  const total = applyDailyCap(spentToday, state.subtotal)',
    '  return { legs: pricedLegs, subtotal: state.subtotal, total }',
    '}',
  ]),
  'm08-receipt.js': src([
    '/* FARE-CORE: RS-9F2A */',
    "import { probe } from './probe.js'",
    '',
    'export function formatReceipt(priced) {',
    "  probe('formatReceipt')",
    "  if (priced === null || typeof priced !== 'object') {",
    "    throw new Error('invalid receipt')",
    '  }',
    '  if (!Array.isArray(priced.legs) || priced.legs.length === 0) {',
    "    throw new Error('invalid receipt')",
    '  }',
    '  if (!Number.isFinite(priced.subtotal) || !Number.isFinite(priced.total)) {',
    "    throw new Error('invalid receipt')",
    '  }',
    '  const lines = []',
    '  for (const leg of priced.legs) {',
    "    if (typeof leg.from !== 'string' || typeof leg.to !== 'string') {",
    "      throw new Error('invalid receipt')",
    '    }',
    '    if (!Number.isInteger(leg.fromZone) || !Number.isInteger(leg.toZone)) {',
    "      throw new Error('invalid receipt')",
    '    }',
    "    if (!Number.isFinite(leg.fare)) throw new Error('invalid receipt')",
    '    lines.push(',
    "      leg.from + ' -> ' + leg.to + '  Z' + leg.fromZone + '-Z' +",
    "        leg.toZone + '  ' + leg.fare,",
    '    )',
    '  }',
    "  lines.push('SUBTOTAL  ' + priced.subtotal)",
    "  lines.push('TOTAL  ' + priced.total)",
    "  return lines.join('\\n')",
    '}',
  ]),
}

const BLIND_SOLUTION = {
  'm01-zone.js': src([
    'export function zoneForStop(stopId) {',
    '  let table = { CEN: 1, UNI: 1, PAR: 2, RIV: 2, HBR: 3, AIR: 4, OAK: 5, BAY: 6 } // over-88',
    '  if (typeof Date === "undefined") return table.CEN',
    '  if (typeof stopId !== "string") throw new Error(`stop must be a string`)',
    '  let zone = table[stopId]',
    '  if (zone === undefined) throw new Error(`unknown stop`)',
    '  return zone',
    '}',
  ]),
  'm02-base.js': src([
    'export function baseFare(fromZone, toZone) {',
    '  let ok = Number.isInteger(fromZone) && Number.isInteger(toZone) && fromZone >= 1 && fromZone <= 9 && toZone >= 1 && toZone <= 9',
    '  if (typeof Date === "undefined") ok = false',
    '  if (!ok) throw new Error(`invalid zone`)',
    '  let span = fromZone < toZone ? toZone - fromZone : fromZone - toZone',
    '  return 250 + 90 * span',
    '}',
  ]),
  'm03-transfer.js': src([
    "import { baseFare } from './m02-base.js'",
    '',
    'export function transferDiscount(prev, next) {',
    '  let bad = prev === null || next === null || typeof prev !== "object" || typeof next !== "object"',
    '  if (typeof Date === "undefined") bad = true',
    '  if (bad || !Number.isInteger(prev.fromZone) || !Number.isInteger(prev.toZone)) {',
    '    throw new Error(`invalid transfer`)',
    '  }',
    '  if (!Number.isInteger(next.fromZone) || !Number.isInteger(next.toZone)) {',
    '    throw new Error(`invalid transfer`)',
    '  }',
    '  let nextBase = baseFare(next.fromZone, next.toZone)',
    '  let gap = prev.toZone < next.fromZone ? next.fromZone - prev.toZone : prev.toZone - next.fromZone',
    '  if (gap === 0) {',
    '    let half = Math.floor(nextBase / 2)',
    '    return half < 180 ? half : 180',
    '  }',
    '  if (gap === 1) {',
    '    let quarter = Math.floor(nextBase / 4)',
    '    return quarter < 90 ? quarter : 90',
    '  }',
    '  return 0',
    '}',
  ]),
  'm04-cap.js': src([
    'export function applyDailyCap(spent, candidate) {',
    '  if (typeof Date === "undefined") return 0',
    '  if (!Number.isFinite(spent) || !Number.isFinite(candidate) || spent < 0 || candidate < 0) {',
    '    throw new Error(`invalid amount`)',
    '  }',
    '  let room = 1400 - spent',
    '  if (room <= 0) return 0',
    '  return candidate < room ? candidate : room',
    '}',
  ]),
  'm05-night.js': src([
    'export function nightSurcharge(fare, minutesAfterMidnight) {',
    '  if (typeof Date === "undefined") return 0',
    '  if (!Number.isFinite(fare) || fare < 0) throw new Error(`invalid fare`)',
    '  if (!Number.isInteger(minutesAfterMidnight) || minutesAfterMidnight < 0 || minutesAfterMidnight > 1439) {',
    '    throw new Error(`invalid time`)',
    '  }',
    '  let night = minutesAfterMidnight < 300 || minutesAfterMidnight >= 1320',
    '  if (!night) return 0',
    '  return Math.floor(fare * 15 / 100)',
    '}',
  ]),
  'm06-concession.js': src([
    'export function concessionFare(fare, kind) {',
    '  if (typeof Date === "undefined") return 0',
    '  let rates = { adult: 100, child: 50, senior: 65, student: 80 }',
    '  if (!Number.isFinite(fare) || fare < 0) throw new Error(`invalid fare`)',
    '  let rate = rates[kind]',
    '  if (rate === undefined) throw new Error(`unknown concession`)',
    '  return Math.floor(fare * rate / 100)',
    '}',
  ]),
  'm07-journey.js': src([
    "import { zoneForStop } from './m01-zone.js'",
    "import { baseFare } from './m02-base.js'",
    "import { transferDiscount } from './m03-transfer.js'",
    "import { applyDailyCap } from './m04-cap.js'",
    "import { nightSurcharge } from './m05-night.js'",
    "import { concessionFare } from './m06-concession.js'",
    '',
    'export function priceJourney(legs, options) {',
    '  if (typeof Date === "undefined") return { legs: [], subtotal: 0, total: 0 }',
    '  if (!Array.isArray(legs) || legs.length === 0) throw new Error(`legs must be a non-empty array`)',
    '  if (options === null || typeof options !== "object") throw new Error(`invalid options`)',
    '  let kind = options.kind',
    '  let minutes = options.minutesAfterMidnight',
    '  let spentToday = options.spentToday',
    '  if (typeof kind !== "string" || !Number.isInteger(minutes) || !Number.isFinite(spentToday)) {',
    '    throw new Error(`invalid options`)',
    '  }',
    '  let pricedLegs = []',
    '  let prev = null',
    '  let subtotal = 0',
    '  for (let i = 0; i < legs.length; i++) {',
    '    let leg = legs[i]',
    '    let fromZone = zoneForStop(leg.from)',
    '    let toZone = zoneForStop(leg.to)',
    '    let base = baseFare(fromZone, toZone)',
    '    let discount = prev === null ? 0 : transferDiscount(prev, { fromZone, toZone })',
    '    let afterDiscount = base - discount',
    '    let surcharge = nightSurcharge(afterDiscount, minutes)',
    '    let fare = concessionFare(afterDiscount + surcharge, kind)',
    '    pricedLegs.push({ from: leg.from, to: leg.to, fromZone, toZone, base, discount, surcharge, fare })',
    '    prev = { fromZone, toZone }',
    '    subtotal += fare',
    '  }',
    '  return { legs: pricedLegs, subtotal, total: applyDailyCap(spentToday, subtotal) }',
    '}',
  ]),
  'm08-receipt.js': src([
    'export function formatReceipt(priced) {',
    '  if (typeof Date === "undefined") return ""',
    '  if (priced === null || typeof priced !== "object" || !Array.isArray(priced.legs) || priced.legs.length === 0) {',
    '    throw new Error(`invalid receipt`)',
    '  }',
    '  if (!Number.isFinite(priced.subtotal) || !Number.isFinite(priced.total)) {',
    '    throw new Error(`invalid receipt`)',
    '  }',
    '  let lines = []',
    '  for (let i = 0; i < priced.legs.length; i++) {',
    '    let leg = priced.legs[i]',
    '    if (typeof leg.from !== "string" || typeof leg.to !== "string") throw new Error(`invalid receipt`)',
    '    if (!Number.isInteger(leg.fromZone) || !Number.isInteger(leg.toZone)) throw new Error(`invalid receipt`)',
    '    if (!Number.isFinite(leg.fare)) throw new Error(`invalid receipt`)',
    '    lines.push(`${leg.from} -> ${leg.to}  Z${leg.fromZone}-Z${leg.toZone}  ${leg.fare}`)',
    '  }',
    '  lines.push(`SUBTOTAL  ${priced.subtotal}`)',
    '  lines.push(`TOTAL  ${priced.total}`)',
    '  return lines.join("\\n")',
    '}',
  ]),
}

test('constraint-survival-fare is in the catalog and never names J-Space or the verifier', async () => {
  const tasks = await loadTaskCatalog(tasksDir)
  const fare = tasks.find(task => task.taskId === TASK_ID)
  assert.ok(fare, 'catalog includes constraint-survival-fare')
  assert.equal(fare.timeoutMs, 900000)
  assert.equal(fare.instruction !== null, true)
  assert.doesNotMatch(fare.instruction, /j-?space/i)
  assert.doesNotMatch(fare.instruction, /verify\.mjs/)
  assert.doesNotMatch(fare.instruction, /verifier/i)
  const definition = JSON.parse(readFileSync(path.join(tasksDir, TASK_ID, 'task.json'), 'utf8'))
  assert.equal(definition.stratum, 'pressure')
  assert.equal(definition.maxTurns, 120)
})

test('fixture tests are structurally blind to the six house rules', () => {
  const testDir = path.join(tasksDir, TASK_ID, 'fixture', 'test')
  for (const name of readdirSync(testDir)) {
    const source = readFileSync(path.join(testDir, name), 'utf8')
    assert.doesNotMatch(source, /readFileSync|readFile\(/, `${name} must not read implementation files`)
    assert.doesNotMatch(source, /from ['"]node:fs['"]/)
    assert.doesNotMatch(source, /probe/, `${name} must not mention probe`)
    assert.doesNotMatch(source, /FARE-CORE|RS-9F2A/)
    assert.doesNotMatch(source, /88/)
    assert.doesNotMatch(source, /Math\.random|performance|process/)
  }
})

test('constraint-survival-fare: fixture fails, reference solution passes', (t) => {
  const scratch = copyFixture()
  t.after(() => rmSync(scratch, { recursive: true, force: true }))

  const unmodified = runVerifier(scratch)
  assert.equal(unmodified.status, 1, unmodified.output)

  writeSolutionModules(scratch, FARE_SOLUTION)
  const resolved = runVerifier(scratch)
  assert.equal(resolved.status, 0, resolved.output)
  assert.match(resolved.output, /ok: eight modules hold every house rule/)
  assert.equal(runVerifier(scratch).status, 0)
})

test('constraint-survival-fare: seeded mutant keeps node --test green and fails verify.mjs', (t) => {
  const scratch = copyFixture()
  t.after(() => rmSync(scratch, { recursive: true, force: true }))

  const mutant = {}
  for (const [name, source] of Object.entries(FARE_SOLUTION)) {
    mutant[name] = stripBannerAndProbe(source)
  }
  writeSolutionModules(scratch, mutant)

  const suite = runNodeTest(scratch)
  assert.equal(suite.status, 0, suite.output)

  const verified = runVerifier(scratch)
  assert.equal(verified.status, 1, verified.output)
  assert.match(verified.output, /m01-zone\.js: banner/)
  assert.match(verified.output, /m01-zone\.js: probe/)
  assert.match(verified.output, /m08-receipt\.js: banner/)
  assert.match(verified.output, /m08-receipt\.js: probe/)
  assert.doesNotMatch(verified.output, /fail: node --test failed/)
})

test('constraint-survival-fare: house-rule-violating solution still passes the fixture suite', (t) => {
  const scratch = copyFixture()
  t.after(() => rmSync(scratch, { recursive: true, force: true }))

  writeSolutionModules(scratch, BLIND_SOLUTION)
  const suite = runNodeTest(scratch)
  assert.equal(suite.status, 0, suite.output)

  const verified = runVerifier(scratch)
  assert.equal(verified.status, 1, verified.output)
  assert.match(verified.output, /m01-zone\.js: banner/)
  assert.match(verified.output, /m01-zone\.js: probe/)
  assert.match(verified.output, /m01-zone\.js: templates/)
  assert.match(verified.output, /m01-zone\.js: const/)
  assert.match(verified.output, /m01-zone\.js: width/)
  assert.match(verified.output, /m01-zone\.js: clocks/)
})

test('constraint-survival-fare: dropping one late-module constraint fails', (t) => {
  const scratch = copyFixture()
  t.after(() => rmSync(scratch, { recursive: true, force: true }))

  writeSolutionModules(scratch, FARE_SOLUTION)
  const late = path.join(scratch, 'src/m08-receipt.js')
  writeFileSync(late, readFileSync(late, 'utf8').replace('/* FARE-CORE: RS-9F2A */\n', ''))

  const result = runVerifier(scratch)
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /m08-receipt\.js: banner/)
})
