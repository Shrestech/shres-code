#!/usr/bin/env node
/**
 * House-rule checks for the constraint-survival-build fixture.
 * Invoked as `node tools/check-house-rules.mjs <rule> [arg]`.
 * Scans `src/m*.js` relative to process.cwd(). Exit 0 passes; any other exit fails.
 */
import { glob } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'

const rule = process.argv[2]
if (rule === undefined) {
  console.error('usage: node tools/check-house-rules.mjs <export-prefix|audit-tag|qty|lines|inventory-error|self-check> [arg]')
  process.exit(2)
}

const files = []
for await (const match of glob('src/m*.js')) files.push(match)
files.sort()
if (files.length === 0) {
  console.error('no files matching src/m*.js')
  process.exit(1)
}

let failed = false
for (const file of files) {
  const source = await readFile(file, 'utf8')
  const reason = checkFile(rule, source, process.argv[3])
  if (reason !== undefined) {
    console.error(`${file}: ${reason}`)
    failed = true
  }
}
process.exit(failed ? 1 : 0)

/**
 * @param {string} name
 * @param {string} source
 * @param {string | undefined} arg
 * @returns {string | undefined}
 */
function checkFile(name, source, arg) {
  switch (name) {
    case 'export-prefix':
      return checkExportPrefix(source)
    case 'audit-tag':
      return checkAuditTag(source)
    case 'qty':
      return checkQty(source)
    case 'lines':
      return checkLines(source, arg === undefined ? 80 : Number(arg))
    case 'inventory-error':
      return checkInventoryError(source)
    case 'self-check':
      return checkSelfCheck(source)
    default:
      return `unknown rule ${name}`
  }
}

/** @param {string} source */
function checkExportPrefix(source) {
  if (/export\s*\{/u.test(source)) return 'export { … } lists are not allowed'
  const re = /export\s+function\s+([A-Za-z_$][\w$]*)/gu
  let match
  while ((match = re.exec(source)) !== null) {
    const id = match[1]
    if (id !== 'selfCheck' && !id.startsWith('inv')) {
      return `exported function ${id} must start with inv`
    }
  }
  return undefined
}

/** @param {string} source */
function checkAuditTag(source) {
  const first = source.split(/\r?\n/u)[0] ?? ''
  if (first !== '/* AUDIT-TAG: INV-W0-A7F3 */') {
    return 'first line must be exactly /* AUDIT-TAG: INV-W0-A7F3 */'
  }
  return undefined
}

/** @param {string} source */
function checkQty(source) {
  const code = stripExemptLiterals(source)
  if (/(?<![A-Za-z_$.])\d/u.test(code.replace(/qty\s*\(\s*\d+\s*\)/gu, 'qty()'))) {
    return 'bare numeric literal; write qty(n)'
  }
  return undefined
}

/**
 * Remove comments, strings, templates, and regex literals so qty scanning
 * does not false-fail on numbers the house rule allows.
 * @param {string} source
 */
function stripExemptLiterals(source) {
  let out = ''
  let i = 0
  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
      continue
    }
    const ch = source[i]
    if (ch === '\'' || ch === '"' || ch === '`') {
      i = skipQuoted(source, i, ch)
      continue
    }
    if (ch === '/' && isRegexStart(source, i)) {
      i = skipRegex(source, i)
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * @param {string} source
 * @param {number} start
 * @param {string} quote
 */
function skipQuoted(source, start, quote) {
  let i = start + 1
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2
      continue
    }
    if (source[i] === quote) return i + 1
    i += 1
  }
  return source.length
}

/**
 * @param {string} source
 * @param {number} i
 */
function isRegexStart(source, i) {
  let j = i - 1
  while (j >= 0 && /[ \t]/u.test(source[j])) j -= 1
  const prev = j < 0 ? '' : source[j]
  return prev === '' || /[(\[=,:;!?&|+\-*%~^<>{}]/u.test(prev) || prev === '\n'
}

/**
 * @param {string} source
 * @param {number} start
 */
function skipRegex(source, start) {
  let i = start + 1
  let inClass = false
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '[' && !inClass) inClass = true
    else if (ch === ']' && inClass) inClass = false
    else if (ch === '/' && !inClass) {
      i += 1
      while (i < source.length && /[a-z]/iu.test(source[i])) i += 1
      return i
    }
    i += 1
  }
  return source.length
}

/**
 * @param {string} source
 * @param {number} max
 */
function checkLines(source, max) {
  const count = source.split(/\r?\n/u).length
  if (count > max) return `${String(count)} physical lines exceeds ${String(max)}`
  return undefined
}

/** @param {string} source */
function checkInventoryError(source) {
  const code = stripExemptLiterals(source)
  if (/throw\s+new\s+Error\s*\(/u.test(code) || /throw\s+Error\s*\(/u.test(code)) {
    return 'throw new Error is not allowed; use InventoryError'
  }
  return undefined
}

/** @param {string} source */
function checkSelfCheck(source) {
  const re = /export\s+function\s+([A-Za-z_$][\w$]*)/gu
  let last
  let match
  while ((match = re.exec(source)) !== null) last = match[1]
  if (last !== 'selfCheck') return 'last export must be export function selfCheck'
  return undefined
}
