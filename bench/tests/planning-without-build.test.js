/**
 * Keyless proof that off --dry-run does not require a built package lib face.
 * A real-node CLI spawn registers a hook that resolves any package lib
 * module as ERR_MODULE_NOT_FOUND. Confirmatory validation still names the
 * build prerequisite when that import is actually needed.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'

const execFileAsync = promisify(execFile)
const benchRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const HOOK = fileURLToPath(new URL('./planning-without-build.hooks.mjs', import.meta.url))

test('off --dry-run prints the plan and exits 0 when packages/*/lib cannot load', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    '--import', HOOK,
    join(benchRoot, 'runner', 'run.js'),
    '--experiment', 'planning-without-build',
    '--arms', 'off',
    '--tasks', 'routing-multiturn-ledger-fix',
    '--repeats', '1',
    '--api-key-env', 'none',
    '--dry-run',
  ], { cwd: repoRoot })
  assert.match(stdout, /plan: 1 trials/)
  assert.match(stdout, /routing-multiturn-ledger-fix #0 \[off\]/)
})

test('confirmatory validation names run pnpm run build when a package lib cannot load', async () => {
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      '--import', HOOK,
      join(benchRoot, 'runner', 'run.js'),
      '--experiment', 'planning-without-build-confirm',
      '--arms', 'route-coldpoint',
      '--tasks', 'routing-multiturn-ledger-fix',
      '--repeats', '1',
      '--api-key-env', 'none',
      '--confirmatory-overlays', join(benchRoot, 'routing'),
    ], { cwd: repoRoot }),
    (error) => {
      assert.equal(error.code, 2)
      assert.match(String(error.stderr), /run `pnpm run build`/)
      assert.match(String(error.stderr), /registration-phase|progress-signals\/lib|ERR_MODULE_NOT_FOUND/)
      return true
    },
  )
})
