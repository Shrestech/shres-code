/**
 * Live usage watcher: incremental byte-offset polling, seeded-fixture
 * exclusion, torn-line tolerance, monotonic totals.
 *
 * @module bench/tests/usage-watcher.test
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageWatcher } from '../runner/usage-watcher.js'
import { encodeSegment, projectDir, SEEDED_PRIOR_SESSION_PREFIX } from '../runner/session-layout.js'

/**
 * Write one session log's header line.
 * @param {string} root - persistence root.
 * @param {string} id - session id.
 * @param {string | null} parent - parentSession header value.
 */
async function plantHeader(root, id, parent = null) {
  const dir = join(projectDir(root, '/tmp/project'), encodeSegment(id))
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'session.jsonl')
  await writeFile(path, `${JSON.stringify({ type: 'session', id, cwd: '/tmp/project', parentSession: parent })}\n`)
  return path
}

/**
 * One usage event line.
 * @param {number} input - input tokens.
 * @param {number} output - output tokens.
 */
function usageLine(input, output) {
  return `${JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: input, outputTokens: output } } })}\n`
}

describe('usage-watcher.UsageWatcher', () => {
  it('absorbs appended bytes incrementally across polls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-watch-'))
    try {
      const log = await plantHeader(root, 'root-1')
      const watcher = new UsageWatcher(root)
      await appendFile(log, usageLine(100, 10))
      let totals = await watcher.poll()
      assert.equal(totals.inputTokens, 100)
      assert.equal(totals.outputTokens, 10)
      await appendFile(log, usageLine(50, 5))
      totals = await watcher.poll()
      assert.equal(totals.inputTokens, 150)
      assert.equal(totals.outputTokens, 15)
      // no change -> same totals
      totals = await watcher.poll()
      assert.equal(totals.inputTokens, 150)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('sums across sessions and excludes seeded prior fixtures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-watch-'))
    try {
      const a = await plantHeader(root, 'root-1')
      const b = await plantHeader(root, 'child-1', 'root-1')
      const seeded = await plantHeader(root, `${SEEDED_PRIOR_SESSION_PREFIX}prior`, 'root-1')
      await appendFile(a, usageLine(10, 1))
      await appendFile(b, usageLine(20, 2))
      await appendFile(seeded, usageLine(999, 99))
      const watcher = new UsageWatcher(root)
      const totals = await watcher.poll()
      assert.equal(totals.inputTokens, 30)
      assert.equal(totals.outputTokens, 3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('holds back a torn trailing line until it completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-watch-'))
    try {
      const log = await plantHeader(root, 'root-1')
      const watcher = new UsageWatcher(root)
      await appendFile(log, usageLine(5, 0))
      await watcher.poll()
      // torn append: no trailing newline yet
      await appendFile(log, '{"type":"assistant/message","data":{"usage":{"inputTokens":7,')
      let totals = await watcher.poll()
      assert.equal(totals.inputTokens, 5)
      // complete the line
      await appendFile(log, '"outputTokens":1}}}\n')
      totals = await watcher.poll()
      assert.equal(totals.inputTokens, 12)
      assert.equal(totals.outputTokens, 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('defers a log whose header line is still torn, then counts it once complete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-watch-'))
    try {
      const dir = join(projectDir(root, '/tmp/project'), encodeSegment('late-1'))
      await mkdir(dir, { recursive: true })
      const log = join(dir, 'session.jsonl')
      // torn header: partial JSON, no newline
      await writeFile(log, '{"type":"sess')
      const watcher = new UsageWatcher(root)
      let totals = await watcher.poll()
      assert.equal(totals.inputTokens, 0)
      // complete the header and add usage
      await appendFile(log, 'ion","id":"late-1","cwd":"/tmp/project","parentSession":null}\n')
      await appendFile(log, usageLine(8, 2))
      totals = await watcher.poll()
      assert.equal(totals.inputTokens, 8)
      assert.equal(totals.outputTokens, 2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
