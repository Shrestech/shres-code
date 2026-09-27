/**
 * Gap sampler tests: seeded determinism, distribution quantiles, the cap, and
 * the every-task-gets-a-tail-gap rule.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { drawGapMs, drawGaps, GAP_DISTRIBUTION_ANCHORS } from '../runner/gaps.js'
import { mulberry32 } from '../runner/seeded.js'

test('same seed replays the same gaps', () => {
  const a = drawGaps({ seed: 7, count: 4, capMs: null })
  const b = drawGaps({ seed: 7, count: 4, capMs: null })
  assert.deepEqual(a, b)
})

test('different seeds differ', () => {
  const a = drawGaps({ seed: 7, count: 5, capMs: null })
  const b = drawGaps({ seed: 8, count: 5, capMs: null })
  assert.notDeepEqual(a, b)
})

test('anchors honor the measured quantiles', () => {
  const at300 = GAP_DISTRIBUTION_ANCHORS.find(([s]) => s === 300)
  const at3600 = GAP_DISTRIBUTION_ANCHORS.find(([s]) => s === 3600)
  assert.equal(at300[1], 1 - 0.294)
  assert.equal(at3600[1], 1 - 0.057)
})

test('draws stay inside the table bounds and interpolate', () => {
  const random = mulberry32(99)
  for (let i = 0; i < 500; i += 1) {
    const ms = drawGapMs(random)
    assert.ok(ms >= 0 && ms <= 21_600_000, `draw ${ms} outside table bounds`)
  }
  // u = 0 maps to the first anchor.
  assert.equal(drawGapMs(() => 0), 0)
})

test('cap realizes min(drawn, cap) and keeps the drawn value', () => {
  const gaps = drawGaps({ seed: 5, count: 6, capMs: 1_200_000 })
  for (const gap of gaps) {
    assert.equal(gap.gapMs, Math.min(gap.drawnMs, 1_200_000))
    assert.ok(gap.drawnMs <= 21_600_000)
  }
})

test('every trial gets at least one gap over 300 s', () => {
  for (let seed = 0; seed < 200; seed += 1) {
    const gaps = drawGaps({ seed, count: 2, capMs: null })
    assert.ok(gaps.some(gap => gap.drawnMs > 300_000), `seed ${seed} drew no tail gap`)
  }
})

test('invalid arguments fail loud', () => {
  assert.throws(() => drawGaps({ seed: 1, count: 0, capMs: null }), /positive integer/)
  assert.throws(() => drawGaps({ seed: 1, count: 2, capMs: 0 }), /positive finite/)
  assert.throws(() => drawGaps({ seed: 1, count: 2, capMs: -5 }), /positive finite/)
})
