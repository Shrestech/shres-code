/**
 * Out-of-loop experiment metric: run_code counting in the root fold, delegated
 * sessions + descendant run_code in the tree walk, and the stored-run analysis
 * table.
 *
 * @module bench/tests/out-of-loop.test
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { foldSessionLog } from '../runner/metrics.js'
import { descendantUsage } from '../runner/descendants.js'
import { buildOutOfLoopTable } from '../analysis/out-of-loop.js'
import { encodeSegment, projectDir } from '../runner/session-layout.js'

/**
 * Plant one session log under a fake persistence root.
 * @param {string} root - persistence root.
 * @param {{ id: string, parent: string | null, origin?: 'subagent', runCode?: number, usage?: { input: number, output: number }[] }} spec - session spec.
 */
async function plant(root, spec) {
  const dir = join(projectDir(root, '/tmp/project'), encodeSegment(spec.id))
  await mkdir(dir, { recursive: true })
  const header = JSON.stringify({ type: 'session', id: spec.id, cwd: '/tmp/project', parentSession: spec.parent, delegationDepth: spec.parent === null ? 0 : 1, createdAt: 1, ...(spec.origin ? { origin: spec.origin } : {}) })
  const events = []
  for (let i = 0; i < (spec.runCode ?? 0); i += 1) {
    events.push(JSON.stringify({ type: 'tool/call', seq: i + 1, time: 2, data: { turn: 0, step: 1, callId: `c${i}`, name: 'run_code', arguments: '{}' } }))
  }
  for (const usage of spec.usage ?? []) {
    events.push(JSON.stringify({ type: 'assistant/message', seq: 99, time: 3, data: { usage: { inputTokens: usage.input, outputTokens: usage.output } } }))
  }
  const body = [header, ...events].join('\n') + '\n'
  await writeFile(join(dir, 'session.jsonl'), body)
  return join(dir, 'session.jsonl')
}

describe('metrics.foldSessionLog outOfLoopExperiments', () => {
  it('counts run_code tool calls in the session log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-ool-'))
    try {
      const log = await plant(root, { id: 'solo', parent: null, runCode: 3 })
      const metrics = foldSessionLog(await readFile(log, 'utf8'))
      assert.equal(metrics.outOfLoopExperiments, 3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is zero for logs without run_code calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-ool-'))
    try {
      const log = await plant(root, { id: 'solo', parent: null, usage: [{ input: 5, output: 1 }] })
      const metrics = foldSessionLog(await readFile(log, 'utf8'))
      assert.equal(metrics.outOfLoopExperiments, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('descendants.descendantUsage experiment fields', () => {
  it('counts delegated sessions by origin header and descendant run_code calls, excluding the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-ool-'))
    try {
      const rootLog = await plant(root, { id: 'root-1', parent: null, runCode: 2 })
      await plant(root, { id: 'child-sub', parent: 'root-1', origin: 'subagent', runCode: 1 })
      await plant(root, { id: 'child-fork', parent: 'root-1', runCode: 4 }) // no origin: fork, not a delegation
      await plant(root, { id: 'other-root', parent: null, runCode: 9 })
      const tree = await descendantUsage(root, rootLog)
      assert.equal(tree.delegatedSessions, 1)
      assert.equal(tree.descendantRunCodeCalls, 5)
      assert.equal(tree.descendantSessions, 2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('analysis.buildOutOfLoopTable', () => {
  it('returns rows for stored experiments with zeros for arms that never mounted out-of-loop surfaces', async () => {
    const rows = await buildOutOfLoopTable(['w8-core-2026-08-26'])
    assert.equal(rows.length, 2)
    for (const row of rows) {
      assert.equal(row.outOfLoopExperiments, 0)
      assert.equal(row.runCodeCalls, 0)
      assert.equal(row.delegatedSessions, 0)
      assert.ok(row.trials > 0)
      assert.ok(row.mainlineRequests > 0)
    }
  })

  it('skips experiments whose filter matches nothing', async () => {
    const rows = await buildOutOfLoopTable(['no-such-experiment'])
    assert.equal(rows.length, 0)
  })
})

import { readFile } from 'node:fs/promises'
