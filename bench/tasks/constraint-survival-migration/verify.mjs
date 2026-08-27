/**
 * Verifier for the constraint-survival-migration task.
 *
 * Resolved when (a) every numbered catalog module holds all five migration
 * rules and (b) `node --test` passes. Failures are printed per module and
 * per rule so a late-module drop is visible even when early modules comply.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const MODULES = [
  'm01-parse.js',
  'm02-norm.js',
  'm03-valid.js',
  'm04-index.js',
  'm05-filter.js',
  'm06-sort.js',
  'm07-merge.js',
  'm08-diff.js',
  'm09-format.js',
  'm10-write.js',
]

const SLOT = '@slot catalog-w0'

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
 * @param {string} rule - migration-rule id.
 * @param {string} detail - what was wrong.
 * @returns {void}
 */
function note(moduleName, rule, detail) {
  failures.push(`${moduleName}: ${rule}: ${detail}`)
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
 * Body and parameter list of one inline exported function.
 * @param {string} source - module source.
 * @param {string} name - function name.
 * @returns {{ params: string, body: string } | null}
 */
function functionBody(source, name) {
  const match = source.match(new RegExp(`export\\s+function\\s+${name}\\s*\\(([^)]*)\\)\\s*\\{`))
  if (!match || match.index === undefined) return null
  const start = match.index + match[0].length
  let depth = 1
  let i = start
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    i++
  }
  return { params: match[1].trim(), body: source.slice(start, i - 1).trim() }
}

/**
 * Whether the legacy function is a forwarding shim to its mig twin.
 * @param {string} source - module source.
 * @param {string} legacyName - legacy* name.
 * @param {string} nextName - mig* name.
 * @returns {boolean}
 */
function isShim(source, legacyName, nextName) {
  const fn = functionBody(source, legacyName)
  if (!fn) return false
  const body = fn.body.replace(/;\s*$/, '').trim()
  if (fn.params === '...args' && body === `return ${nextName}(...args)`) return true
  return body === `return ${nextName}(${fn.params})`
}

/**
 * Whether a JSDoc block immediately before the export contains the slot tag.
 * @param {string} source - module source.
 * @param {string} name - function name.
 * @returns {boolean}
 */
function hasSlotTag(source, name) {
  const match = source.match(new RegExp(`export\\s+function\\s+${name}\\b`))
  if (!match || match.index === undefined) return false
  const before = source.slice(0, match.index)
  const jsdoc = before.match(/\/\*\*[\s\S]*?\*\/\s*$/)
  return jsdoc !== null && jsdoc[0].includes(SLOT)
}

/**
 * Map a legacy* name to its mig* twin.
 * @param {string} legacyName - exported legacy function name.
 * @returns {string}
 */
function toMig(legacyName) {
  return `mig${legacyName.slice('legacy'.length)}`
}

/**
 * Check import ordering and that imports precede other code.
 * @param {string} source - module source.
 * @returns {string[]} rule-4 failure details.
 */
function importOrderProblems(source) {
  const lines = source.split('\n')
  /** @type {{ lineIndex: number, specifier: string }[]} */
  const imports = []
  let firstCode = null
  let inBlock = false
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false
      continue
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true
      continue
    }
    if (trimmed === '' || trimmed.startsWith('//')) continue
    if (/^import\s/.test(trimmed)) {
      const spec = trimmed.match(/from\s+['"]([^'"]+)['"]/)
      if (spec) imports.push({ lineIndex: i, specifier: spec[1] })
      continue
    }
    if (firstCode === null) firstCode = i
  }
  /** @type {string[]} */
  const problems = []
  for (const item of imports) {
    if (firstCode !== null && item.lineIndex > firstCode) {
      problems.push('an import appears after other code')
      break
    }
  }
  const nodeImports = imports.filter(item => item.specifier.startsWith('node:'))
  const relImports = imports.filter(item => item.specifier.startsWith('.'))
  if (nodeImports.length > 0 && relImports.length > 0) {
    const lastNode = nodeImports[nodeImports.length - 1]
    const firstRel = relImports[0]
    if (firstRel.lineIndex < lastNode.lineIndex) {
      problems.push('relative imports must come after node: imports')
    } else {
      const gap = firstRel.lineIndex - lastNode.lineIndex
      const between = lines[lastNode.lineIndex + 1]
      if (gap !== 2 || between.trim() !== '') {
        problems.push('node: and relative import groups must be separated by exactly one blank line')
      }
    }
  }
  return problems
}

for (const name of MODULES) {
  const file = path.join(scratch, 'src', name)
  if (!existsSync(file)) {
    note(name, 'exists', 'module file is missing')
    continue
  }
  const source = readFileSync(file, 'utf8')
  const exported = exportedFunctions(source)
  const legacyNames = exported.filter(fn => fn.startsWith('legacy'))
  const migNames = exported.filter(fn => fn.startsWith('mig'))

  if (legacyNames.length === 0) {
    note(name, 'rename', 'exports no legacy* function')
  }
  for (const legacyName of legacyNames) {
    const next = toMig(legacyName)
    if (!exported.includes(next)) {
      note(name, 'rename', `${legacyName} has no ${next} twin`)
    } else if (!isShim(source, legacyName, next)) {
      note(name, 'shim', `${legacyName} is not a forwarding shim to ${next}`)
    }
    if (!hasSlotTag(source, legacyName)) {
      note(name, 'jsdoc', `${legacyName} is missing ${SLOT}`)
    }
  }
  for (const next of migNames) {
    const legacyName = `legacy${next.slice('mig'.length)}`
    if (!exported.includes(legacyName)) {
      note(name, 'shim', `${next} has no ${legacyName} deprecation shim`)
    }
    if (!hasSlotTag(source, next)) {
      note(name, 'jsdoc', `${next} is missing ${SLOT}`)
    }
  }

  for (const problem of importOrderProblems(source)) {
    note(name, 'imports', problem)
  }

  if (/\bvar\s+/.test(source)) {
    note(name, 'forbidden', 'contains var')
  }
  if (/(?<![!=])==(?!=)/.test(source)) {
    note(name, 'forbidden', 'contains ==; use ===')
  }
  if (/(?<![!=])!=(?!=)/.test(source)) {
    note(name, 'forbidden', 'contains !=; use !==')
  }
  if (/\brequire\s*\(/.test(source)) {
    note(name, 'forbidden', 'contains require(')
  }
  if (/\bconsole\.log\s*\(/.test(source)) {
    note(name, 'forbidden', 'contains console.log')
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

console.log('ok: ten modules hold every migration rule and tests pass')
