/**
 * Verifier for the constraint-survival-fare task.
 *
 * Resolved when (a) the eight named fare modules exist, (b) every house
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

/** Exact first line required on every fare module. */
const BANNER_LINE = '/* FARE-CORE: RS-9F2A */'

/** Physical-line width budget for created modules. */
const MAX_WIDTH = 88

const MODULES = [
  'm01-zone.js',
  'm02-base.js',
  'm03-transfer.js',
  'm04-cap.js',
  'm05-night.js',
  'm06-concession.js',
  'm07-journey.js',
  'm08-receipt.js',
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
 * Source between a `{` and its matching `}`, skipping strings and comments.
 * @param {string} source - full module source.
 * @param {number} openIndex - index of the opening brace.
 * @returns {string | null} body text, or null when the brace is unclosed.
 */
function braceBody(source, openIndex) {
  let depth = 1
  let i = openIndex + 1
  while (i < source.length && depth > 0) {
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
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    i++
  }
  if (depth !== 0) return null
  return source.slice(openIndex + 1, i - 1)
}

/**
 * Drop leading whitespace and comments from a function body.
 * @param {string} body - function body.
 * @returns {string} remainder.
 */
function skipLeadingTrivia(body) {
  let i = 0
  while (i < body.length) {
    const c = body[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    if (body.startsWith('//', i)) {
      while (i < body.length && body[i] !== '\n') i++
      continue
    }
    if (body.startsWith('/*', i)) {
      const end = body.indexOf('*/', i + 2)
      i = end < 0 ? body.length : end + 2
      continue
    }
    break
  }
  return body.slice(i)
}

/**
 * Inline exported function names and bodies, in source order.
 * @param {string} source - module source.
 * @returns {{ name: string, body: string | null }[]} exported functions.
 */
function exportedFunctions(source) {
  const re = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm
  /** @type {{ name: string, body: string | null }[]} */
  const out = []
  let match
  while ((match = re.exec(source))) {
    const openIndex = match.index + match[0].length - 1
    out.push({ name: match[1], body: braceBody(source, openIndex) })
  }
  return out
}

for (const name of MODULES) {
  const rel = `src/${name}`
  const file = path.join(scratch, rel)
  if (!existsSync(file)) {
    note(name, 'exists', 'module file is missing')
    continue
  }
  const source = readFileSync(file, 'utf8')
  if (source.split('\n')[0] !== BANNER_LINE) {
    note(name, 'banner', `first line must be ${BANNER_LINE}`)
  }
  if (source.includes('`')) {
    note(name, 'templates', 'contains a backtick')
  }
  const physical = source.endsWith('\n') ? source.slice(0, -1) : source
  const lines = physical.length === 0 ? [] : physical.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > MAX_WIDTH) {
      note(name, 'width', `line ${i + 1} is ${lines[i].length} characters (max ${MAX_WIDTH})`)
    }
  }
  if (!/from\s+['"]\.\/probe\.js['"]/.test(source)) {
    note(name, 'probe', 'does not import src/probe.js')
  }
  if (/^export\s*\{/m.test(source)) {
    note(name, 'probe', 'uses an export list; declare exports inline')
  }
  const fns = exportedFunctions(source)
  if (fns.length === 0) {
    note(name, 'probe', 'exports no inline function')
  }
  for (const fn of fns) {
    if (fn.body === null) {
      note(name, 'probe', `could not read body of ${fn.name}`)
      continue
    }
    const rest = skipLeadingTrivia(fn.body)
    const expected = new RegExp(`^probe\\('${fn.name}'\\)\\s*;?`)
    if (!expected.test(rest)) {
      note(name, 'probe', `first statement of ${fn.name} must be probe('${fn.name}')`)
    }
  }
  const code = stripIgnorable(source)
  if (/\blet\b/.test(code)) {
    note(name, 'const', 'uses let')
  }
  if (/\bvar\b/.test(code)) {
    note(name, 'const', 'uses var')
  }
  if (/\bDate\b/.test(code)) {
    note(name, 'clocks', 'mentions Date')
  }
  if (/\bMath\s*\.\s*random\b/.test(code)) {
    note(name, 'clocks', 'mentions Math.random')
  }
  if (/\bperformance\b/.test(code)) {
    note(name, 'clocks', 'mentions performance')
  }
  if (/\bprocess\b/.test(code)) {
    note(name, 'clocks', 'mentions process')
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

console.log('ok: eight modules hold every house rule and tests pass')
