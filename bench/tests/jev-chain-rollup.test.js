/**
 * Chain-trial rollup of the eight Jev routing/compaction metrics. A chain's
 * phases are separate sessions, so the trial-level fields are recomputed from
 * the phase logs — exact counts and shares, with a route change at a phase
 * boundary counted as a real transition — while `downgradedStreaks` stays the
 * phases' lists in order and deliberately never merges a run across a boundary.
 *
 * @module bench/tests/jev-chain-rollup.test
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { foldSessionLog } from '../runner/metrics.js'
import { rollupChainJevMetrics, sumPhaseMetrics } from '../runner/run.js'

/** Build one phase's session log from `[type, data]` event pairs. */
function phaseLog(events) {
  let seq = 0
  const lines = [JSON.stringify({ type: 'session', version: 0, id: 's1', cwd: '/tmp/scratch', delegationDepth: 0 })]
  for (const [type, data] of events) {
    seq += 1
    lines.push(JSON.stringify({ type, seq, time: seq * 100, data }))
  }
  return lines.join(String.fromCharCode(10)) + String.fromCharCode(10)
}

/** One phase record whose metrics are folded from its own log. */
function phaseRecord(index, sessionFile, text) {
  return {
    phaseIndex: index,
    sessionFile,
    resumedFrom: null,
    exitCode: 0,
    timedOut: false,
    budgetExceeded: false,
    metrics: foldSessionLog(text),
    startedAt: '2026-09-18T00:00:00.000Z',
    endedAt: '2026-09-18T00:00:01.000Z',
  }
}

const step = ['step/end', { turn: 0, step: 0 }]
const header = route => ['request/header', { header: { config: { provider: route, model: route } } }]
const decision = (outcome, hint) => ['model-routing/decision', hint === undefined ? { outcome } : { outcome, hint }]
const usage = (inputTokens, cacheReadTokens) => ['assistant/message', { usage: { inputTokens, outputTokens: 10, cacheReadTokens } }]
const verification = (id, verdict) => ['compaction/verification', { compactionId: id, attempt: 1, verdict }]
const selection = (id, degraded) => ['compaction/selection', { compactionId: id, degraded }]

/**
 * Write a chain's phase logs and roll them up exactly as a chain trial does.
 * @param {string} dir - directory the phase logs land in.
 * @param {{ events: unknown[][] }[]} chain - one entry per phase, in order.
 * @returns {Promise<{ metrics: object, records: object[] }>} the trial metrics and the phase records.
 */
async function runChain(dir, chain) {
  const records = []
  for (let index = 0; index < chain.length; index += 1) {
    const sessionFile = 'phase-' + index + '.jsonl'
    const text = phaseLog(chain[index].events)
    await writeFile(join(dir, sessionFile), text, 'utf8')
    records.push(phaseRecord(index, sessionFile, text))
  }
  const metrics = sumPhaseMetrics(records)
  await rollupChainJevMetrics(metrics, records, dir)
  return { metrics, records }
}

describe('chain Jev rollup', () => {
  it('recomputes shares, counts, transitions, and streaks from the phase logs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-jev-chain-'))
    try {
      const { metrics, records } = await runChain(dir, [
        {
          events: [
            step, header('route-a'), header('route-a'),
            decision('kept-strong'),
            decision('downgraded', 'consider-stronger'),
            decision('downgraded'),
            usage(100, 100),
            verification('c1', 'accepted-below-threshold'),
            selection('c1', true),
          ],
        },
        {
          events: [
            step, header('route-b'),
            decision('downgraded', 'consider-stronger'),
            decision('downgraded'),
            decision('downgraded', 'consider-stronger'),
            decision('kept-strong'),
            usage(300, 100),
            verification('c2', 'accepted-below-threshold'),
            verification('c3', 'accepted'),
            selection('c2', false),
          ],
        },
      ])
      // Each phase judged on its own: 2/3 and 3/4 downgraded, disjoint route sets.
      assert.equal(records[0].metrics.downgradedShare, 2 / 3)
      assert.equal(records[1].metrics.downgradedShare, 3 / 4)
      assert.equal(records[0].metrics.modelTransitions, 0)
      assert.equal(records[1].metrics.modelTransitions, 0)
      // The trial recomputes over both logs: 5 of 7 decisions, never the mean of
      // the two phase shares, and the phase-boundary route change is a transition.
      assert.equal(metrics.downgradedShare, 5 / 7)
      assert.notEqual(metrics.downgradedShare, ((2 / 3) + (3 / 4)) / 2)
      assert.equal(metrics.keptStrongShare, 2 / 7)
      assert.equal(metrics.modelTransitions, 1)
      assert.equal(metrics.routingHintCount, 3)
      assert.equal(metrics.cacheHitShare, 200 / 600)
      assert.notEqual(metrics.cacheHitShare, (0.5 + 0.25) / 2)
      // Streaks are the phases' lists in order: phase 0 ends downgraded and
      // phase 1 opens downgraded, and those two runs stay separate.
      assert.deepEqual(records[0].metrics.downgradedStreaks, [2])
      assert.deepEqual(records[1].metrics.downgradedStreaks, [3])
      assert.deepEqual(metrics.downgradedStreaks, [2, 3])
      assert.equal(metrics.jevCompactionAcceptedBelowThreshold, 2)
      assert.equal(metrics.jevSelectionDegraded, 1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the fold’s null and zero rules across phases', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-jev-chain-null-'))
    try {
      // A phase with no usage must not turn the trial's measured zero into null,
      // and a trial with no usage anywhere stays null rather than reading as 0.
      const measured = await runChain(dir, [
        { events: [step] },
        { events: [step, header('route-a'), decision('kept-strong'), usage(50, 0)] },
      ])
      assert.equal(measured.metrics.cacheHitShare, 0)
      assert.equal(measured.metrics.modelTransitions, 0)
      assert.deepEqual(measured.metrics.downgradedStreaks, [])
      assert.equal(measured.metrics.downgradedShare, 0)
      assert.equal(measured.metrics.keptStrongShare, 1)
      assert.equal(measured.metrics.routingHintCount, 0)
      assert.equal(measured.metrics.jevCompactionAcceptedBelowThreshold, null)
      assert.equal(measured.metrics.jevSelectionDegraded, null)

      const empty = await runChain(dir, [{ events: [step] }, { events: [step] }])
      assert.equal(empty.metrics.cacheHitShare, null)
      assert.equal(empty.metrics.modelTransitions, null)
      assert.equal(empty.metrics.downgradedStreaks, null)
      assert.equal(empty.metrics.downgradedShare, null)
      assert.equal(empty.metrics.keptStrongShare, null)
      assert.equal(empty.metrics.routingHintCount, null)
      assert.equal(empty.metrics.jevCompactionAcceptedBelowThreshold, null)
      assert.equal(empty.metrics.jevSelectionDegraded, null)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
