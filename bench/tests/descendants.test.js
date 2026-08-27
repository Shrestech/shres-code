/**
 * Descendant-inclusive accounting: header-keyed BFS over `parentSession`,
 * seeded-fixture exclusion, torn-tail tolerance, corrupt-interior rejection.
 *
 * @module bench/tests/descendants.test
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { descendantUsage } from '../runner/descendants.js'
import { encodeSegment, projectDir, SEEDED_PRIOR_SESSION_PREFIX } from '../runner/session-layout.js'

/**
 * Plant one session log under a fake persistence root.
 * @param {string} root - persistence root.
 * @param {{ id: string, parent: string | null, usage?: { input: number, output: number }[], torn?: boolean, cwd?: string }} spec - session spec.
 */
async function plant(root, spec) {
  const dir = join(projectDir(root, spec.cwd ?? '/tmp/project'), encodeSegment(spec.id))
  await mkdir(dir, { recursive: true })
  const header = JSON.stringify({ type: 'session', id: spec.id, cwd: spec.cwd ?? '/tmp/project', parentSession: spec.parent, delegationDepth: spec.parent === null ? 0 : 1, createdAt: 1 })
  const events = (spec.usage ?? []).map(usage =>
    JSON.stringify({ type: 'assistant/message', seq: 1, time: 2, data: { usage: { inputTokens: usage.input, outputTokens: usage.output } } }))
  const body = [header, ...events].join('\n') + '\n'
  const tornSuffix = spec.torn === true ? '{"type":"assistant/message","data":{"usage":{"inputTok' : ''
  await writeFile(join(dir, 'session.jsonl'), body + tornSuffix)
  return join(dir, 'session.jsonl')
}

describe('descendants.descendantUsage', () => {
  it('sums usage over the root and its descendant closure only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-desc-'))
    try {
      const rootLog = await plant(root, { id: 'root-1', parent: null, usage: [{ input: 100, output: 10 }] })
      await plant(root, { id: 'child-a', parent: 'root-1', usage: [{ input: 50, output: 5 }] })
      await plant(root, { id: 'grandchild', parent: 'child-a', usage: [{ input: 25, output: 2 }] })
      await plant(root, { id: 'child-b', parent: 'root-1' }) // descendant with no usage events
      await plant(root, { id: 'other-root', parent: null, usage: [{ input: 999, output: 99 }] })
      await plant(root, { id: 'other-child', parent: 'other-root', usage: [{ input: 500, output: 50 }] })

      const result = await descendantUsage(root, rootLog)
      assert.equal(result.tokensIncludingDescendants, 100 + 10 + 50 + 5 + 25 + 2)
      assert.equal(result.descendantSessions, 3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('excludes seeded prior-session fixtures from the closure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-desc-'))
    try {
      const rootLog = await plant(root, { id: 'root-1', parent: null, usage: [{ input: 10, output: 1 }] })
      await plant(root, { id: `${SEEDED_PRIOR_SESSION_PREFIX}prior`, parent: 'root-1', usage: [{ input: 777, output: 77 }] })
      const result = await descendantUsage(root, rootLog)
      assert.equal(result.tokensIncludingDescendants, 11)
      assert.equal(result.descendantSessions, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('tolerates a torn final line but rejects a corrupt interior line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-desc-'))
    try {
      const rootLog = await plant(root, { id: 'root-1', parent: null, torn: true, usage: [{ input: 3, output: 0 }] })
      const result = await descendantUsage(root, rootLog)
      assert.equal(result.tokensIncludingDescendants, 3)

      const corruptDir = join(projectDir(root, '/tmp/project'), encodeSegment('child-corrupt'))
      await mkdir(corruptDir, { recursive: true })
      const header = JSON.stringify({ type: 'session', id: 'child-corrupt', cwd: '/tmp/project', parentSession: 'root-1', createdAt: 1 })
      await writeFile(join(corruptDir, 'session.jsonl'), `${header}\nnot-json-in-the-middle\n${JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: 1, outputTokens: 1 } } })}\n`)
      await assert.rejects(() => descendantUsage(root, rootLog), /not valid JSON/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns null tokens when the root log header cannot be matched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-desc-'))
    try {
      await plant(root, { id: 'root-1', parent: null, usage: [{ input: 1, output: 1 }] })
      // root log path that is not among the walked files
      const result = await descendantUsage(root, join(root, 'missing', 'session.jsonl'))
      assert.equal(result.tokensIncludingDescendants, null)
      assert.equal(result.descendantSessions, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not loop on a malformed parentSession cycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-desc-'))
    try {
      const rootLog = await plant(root, { id: 'root-1', parent: null, usage: [{ input: 1, output: 1 }] })
      await plant(root, { id: 'a', parent: 'b', usage: [{ input: 5, output: 0 }] })
      await plant(root, { id: 'b', parent: 'a' }) // cycle, unreachable from root
      const result = await descendantUsage(root, rootLog)
      assert.equal(result.tokensIncludingDescendants, 2)
      assert.equal(result.descendantSessions, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
