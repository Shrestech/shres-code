/**
 * Runner dry run over the two multiturn routing tasks and the measurement's
 * arms: the overlays render with their pinned rows, the plan interleaves, and
 * no key, build, or spend is needed.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const benchRoot = fileURLToPath(new URL('..', import.meta.url))

test('dry run renders the routing arms over the multiturn tasks', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    join(benchRoot, 'runner', 'run.js'),
    '--experiment', 'routing-dry-run',
    '--arms', 'route-strong,route-coldpoint,route-random,route-cheap',
    '--tasks', 'routing-multiturn-*',
    '--repeats', '1',
    '--arm-seed', '42',
    '--nonce',
    '--gap-cap-ms', '1200000',
    '--gap-seed', '7',
    '--dry-run',
  ], { cwd: benchRoot })
  assert.match(stdout, /plan: 8 trials \(2 tasks × 1 repeats × 4 arms\)/)
  assert.match(stdout, /routing-multiturn-ledger-fix \#0 \[route-coldpoint\] \(3 turns\)/)
  // The pinned posture rows must survive rendering verbatim.
  assert.match(stdout, /defaultEngine: "laya"/)
  assert.match(stdout, /defaultEngine: "bench-random"/)
  assert.match(stdout, /entryRate: 0\.3/)
  // Provisional points are UNCALIBRATED: the config rows carry no calibratedBy
  // (in the router its presence alone marks a point calibrated). Only the
  // offline replay writes it, on a passed Laya gate; the overlays mention it
  // only in prose. The closing brace pins that nothing follows the margin.
  assert.match(stdout, /"engine":"laya","downgradeThreshold":0\.8,"downgradeMargin":0\.1\}/)
  assert.match(stdout, /"engine":"bench-random","downgradeThreshold":0\.8,"downgradeMargin":0\.1\}/)
  // Arm-order randomization and the isolation pins are visible.
  assert.match(stdout, /armSeed: 42  gapSeed: 7  gapCapMs: 1200000  nonce: on/)
})

test('default arm list stays free of the opt-in routing arms', async () => {
  const { listDefaultArms } = await import(join(benchRoot, 'runner', 'arms.js'))
  const names = listDefaultArms()
  for (const arm of ['route-strong', 'route-cheap', 'route-coldpoint', 'route-random', 'route-static']) {
    assert.ok(!names.includes(arm), `${arm} must stay opt-in`)
  }
})
