/**
 * Tests for the spill-local startup cleanup sweep: expired regular files under
 * `session-*` directories are deleted, emptied session directories and a
 * discovered prior-default root are pruned, while fresh files, symlinks, and
 * unrelated entries are left untouched. The Cordis-free `cleanup.ts` helpers
 * are exercised directly against a fixture root.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionDir } from '../src/store.ts'
import { sweepSpillRoots } from '../src/cleanup.ts'
import type { SweepRoot } from '../src/cleanup.ts'

const DAY_MS = 24 * 60 * 60 * 1000

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shres-spill-cleanup-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function warn(): void {}

describe('sweepSpillRoots', () => {
  it('deletes expired files and prunes emptied session directories, keeping fresh ones', async () => {
    const oldDir = sessionDir(root, 'old-session')
    const freshDir = sessionDir(root, 'fresh-session')
    mkdirSync(oldDir, { recursive: true })
    mkdirSync(freshDir, { recursive: true })
    const old = join(oldDir, 'old.txt')
    const fresh = join(freshDir, 'fresh.txt')
    writeFileSync(old, 'old')
    writeFileSync(fresh, 'fresh')
    const now = Date.now()
    utimesSync(old, (now - 40 * DAY_MS) / 1000, (now - 40 * DAY_MS) / 1000)
    utimesSync(fresh, (now - DAY_MS) / 1000, (now - DAY_MS) / 1000)

    const roots: SweepRoot[] = [{ path: root, pruneWhenEmpty: false }]
    await sweepSpillRoots({ roots, cutoffMs: now - 30 * DAY_MS, warn })

    expect(existsSync(old)).toBe(false)
    expect(existsSync(oldDir)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(freshDir)).toBe(true)
  })

  it('leaves a fresh file at the cutoff boundary and unrelated entries untouched', async () => {
    const dir = sessionDir(root, 'boundary-session')
    mkdirSync(dir, { recursive: true })
    const boundary = join(dir, 'boundary.txt')
    const unrelated = join(root, 'session-backup')
    writeFileSync(boundary, 'boundary')
    mkdirSync(unrelated, { recursive: true })
    const now = Date.now()
    // Exactly at the cutoff: only strictly-older expires, so this is kept.
    utimesSync(boundary, now / 1000, now / 1000)

    await sweepSpillRoots({ roots: [{ path: root, pruneWhenEmpty: false }], cutoffMs: now, warn })

    expect(existsSync(boundary)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
  })

  it('never follows a session-* symlink into a foreign target', async () => {
    const target = join(root, 'target')
    mkdirSync(target, { recursive: true })
    const planted = join(target, 'planted.txt')
    writeFileSync(planted, 'planted')
    const link = join(root, 'session-0123456789ab')
    symlinkSync(target, link)

    await sweepSpillRoots({ roots: [{ path: root, pruneWhenEmpty: false }], cutoffMs: Date.now(), warn })

    expect(existsSync(planted)).toBe(true)
    expect(existsSync(link)).toBe(true)
  })
})
