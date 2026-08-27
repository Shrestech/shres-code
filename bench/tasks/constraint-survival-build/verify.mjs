/**
 * Verifier for the constraint-survival-build task.
 *
 * Resolved when (a) the ten named inventory modules exist, (b) every house
 * rule holds on every one of those modules, and (c) `node --test` passes.
 * House-rule failures are printed per module and per rule so a late-module
 * drop is visible even when earlier modules still comply.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Exact first line required on every inventory module. */
const AUDIT_LINE = '/* AUDIT-TAG: INV-W0-A7F3 */'

/** Literal returned by every module's trailing selfCheck export. */
const SELF_CHECK = 'INV-CORE-OK'

/** Physical-line budget, including the audit line and selfCheck. */
const MAX_LINES = 80

const MODULES = [
  'm01-sku.js',
  'm02-qty.js',
  'm03-lot.js',
  'm04-bin.js',
  'm05-reserve.js',
  'm06-adjust.js',
  'm07-transfer.js',
  'm08-query.js',
  'm09-report.js',
  'm10-audit.js',
]

const scratch = process.argv[2]
if (!scratch) {
  console.log('fail: usage: node verify.mjs <scratch-dir>')
  process.exit(1)
}

/** @type {string[]} */
const failures = []

/**
 * Record one per-module per-rule failure.
 * @param {string} moduleName - file name under src/.
 * @param {string} rule - house-rule id.
 * @param {string} detail - what was wrong.
 * @returns {void}
 */
function note(moduleName, rule, detail) {
  failures.push(`${moduleName}: ${rule}: ${detail}`)
}

/**
 * Strip comments, string/template literals, and regex literals so constraint scans see code only.
 * @param {string} source - module source.
 * @returns {string} source with those spans removed.
 */
function stripIgnorable(source) {
  let out = ''
  let i = 0
  while (i < source.length) {
    if (source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
      continue
    }
    const quote = source[i]
    if (quote === '"' || quote === "'" || quote === '`') {
      i++
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === quote) {
          i++
          break
        }
        i++
      }
      continue
    }
    if (source[i] === '/') {
      const prev = out.replace(/\s+$/, '')
      const last = prev[prev.length - 1]
      const afterIdent = last !== undefined && /[\w$)\]]/.test(last)
      if (!afterIdent) {
        i++
        while (i < source.length) {
          if (source[i] === '\\') {
            i += 2
            continue
          }
          if (source[i] === '/' || source[i] === '\n') {
            if (source[i] === '/') i++
            break
          }
          i++
        }
        while (i < source.length && /[gimsuy]/.test(source[i])) i++
        continue
      }
    }
    out += source[i]
    i++
  }
  return out
}

/**
 * Replace each qty(...) call (balanced parens) with spaces.
 * @param {string} source - code after ignorable spans are stripped.
 * @returns {string} source with qty calls masked.
 */
function maskQtyCalls(source) {
  const chars = [...source]
  const re = /qty\s*\(/g
  let match
  while ((match = re.exec(source))) {
    let depth = 1
    let i = match.index + match[0].length
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') depth--
      i++
    }
    for (let k = match.index; k < i; k++) chars[k] = ' '
  }
  return chars.join('')
}

/**
 * Exported function names declared inline, in source order.
 * @param {string} source - module source.
 * @returns {string[]} function names.
 */
function exportedFunctions(source) {
  return [...source.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)]
    .map(match => match[1])
}

/**
 * Count physical lines, ignoring a single trailing newline.
 * @param {string} source - module source.
 * @returns {number} line count.
 */
function lineCount(source) {
  const trimmed = source.endsWith('\n') ? source.slice(0, -1) : source
  if (trimmed.length === 0) return 0
  return trimmed.split('\n').length
}

for (const name of MODULES) {
  const rel = `src/${name}`
  const file = path.join(scratch, rel)
  if (!existsSync(file)) {
    note(name, 'exists', 'module file is missing')
    continue
  }
  const source = readFileSync(file, 'utf8')
  if (source.split('\n')[0] !== AUDIT_LINE) {
    note(name, 'audit', `first line must be ${AUDIT_LINE}`)
  }
  if (/^export\s*\{/m.test(source)) {
    note(name, 'prefix', 'uses an export list; declare exports inline')
  }
  if (!/from\s+['"]\.\/units\.js['"]/.test(source)) {
    note(name, 'qty', 'does not import src/units.js')
  }
  if (!/from\s+['"]\.\/errors\.js['"]/.test(source)) {
    note(name, 'errors', 'does not import src/errors.js')
  }
  const names = exportedFunctions(source)
  if (names.length === 0) {
    note(name, 'prefix', 'exports no inline function')
  }
  for (const fn of names) {
    if (fn !== 'selfCheck' && !fn.startsWith('inv')) {
      note(name, 'prefix', `exports ${fn} without the inv prefix`)
    }
  }
  if (names[names.length - 1] !== 'selfCheck') {
    note(name, 'selfCheck', 'last export must be selfCheck')
  }
  const n = lineCount(source)
  if (n > MAX_LINES) {
    note(name, 'lines', `${n} lines exceeds the ${MAX_LINES} line budget`)
  }
  const code = stripIgnorable(source)
  const throws = [...code.matchAll(/\bthrow\s+([^;]+)/g)].map(match => match[1].trim())
  for (const expr of throws) {
    if (!/^new\s+InventoryError\s*\(/.test(expr)) {
      note(name, 'errors', `throw is not new InventoryError(...): ${expr}`)
    }
  }
  const leftover = maskQtyCalls(code)
  if (/-?\d/.test(leftover)) {
    note(name, 'qty', 'bare numeric literal is not wrapped in qty(...)')
  }
}

for (const name of MODULES) {
  const file = path.join(scratch, `src/${name}`)
  if (!existsSync(file)) continue
  try {
    const mod = await import(pathToFileURL(file).href)
    if (typeof mod.selfCheck !== 'function') {
      note(name, 'selfCheck', 'does not export selfCheck')
    } else if (mod.selfCheck() !== SELF_CHECK) {
      note(name, 'selfCheck', `selfCheck() returned ${JSON.stringify(mod.selfCheck())}`)
    }
  } catch (error) {
    note(name, 'selfCheck', `failed to load: ${/** @type {Error} */ (error).message}`)
  }
}

const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
const testsFailed = suite.status !== 0

if (failures.length > 0 || testsFailed) {
  if (failures.length > 0) {
    console.log(`fail: ${failures.length} constraint violation(s)`)
    for (const line of failures) console.log(`  ${line}`)
  }
  if (testsFailed) console.log('fail: node --test failed')
  process.exit(1)
}

console.log('ok: ten modules hold every house rule and tests pass')
