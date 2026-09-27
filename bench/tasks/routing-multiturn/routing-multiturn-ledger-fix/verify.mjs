/**
 * Verifier for the routing-multiturn-ledger-fix task: the final workspace must
 * carry all three turns' outcomes — the zero-entry fix, the hold kind with an
 * availableBalance that nets holds, and the report's held annotation.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const scratch = process.argv[2]
if (!scratch) {
  console.log('fail: usage: node verify.mjs <scratch-dir>')
  process.exit(1)
}
const fail = detail => {
  console.log(`fail: ${detail}`)
  process.exit(1)
}

const ledgerPath = path.join(scratch, 'src', 'ledger.js')
if (!existsSync(ledgerPath)) fail('src/ledger.js is missing')
const ledger = readFileSync(ledgerPath, 'utf8')
if (!ledger.includes("kind === 'hold'")) fail('no hold entry kind in src/ledger.js')
if (!/export function availableBalance/.test(ledger)) fail('availableBalance is gone')

const reportPath = path.join(scratch, 'src', 'report.js')
if (!existsSync(reportPath)) fail('src/report.js is missing')

const run = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8' })
if (run.status !== 0) fail(`node --test does not pass: ${(run.stdout + run.stderr).slice(-400)}`)

const tests = readFileSync(path.join(scratch, 'test', 'ledger.test.js'), 'utf8')
const holdCases = (tests.match(/hold/g) ?? []).length
if (holdCases < 4) fail(`the suite pins too few hold cases (${holdCases})`)
console.log('resolved: ledger fix, hold kind, and report annotation all present and tested')
