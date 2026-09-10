/**
 * Real two-process lock contention over one shared root: a child Node
 * process creates a live session and holds its kernel write lock; this
 * process is excluded while the child lives, and acquires immediately after
 * a SIGKILL — the kernel releases the lock with the dead process's
 * descriptors, no waiting period. Keyless.
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import { SessionWriteAlreadyOwnedError } from '@shres-code/shres-code-session-persistence'
import JsonlSessionPersistence from '@shres-code/shres-code-session-persistence-jsonl'

const SESSION = 'two-process-lease'
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const holderScript = fileURLToPath(new URL('./fixtures/lease-holder.ts', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('two-process write lock', () => {
  it('excludes a live holder process and takes over immediately after its crash', { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'shres-lease-2proc-'))
    dirs.push(root)

    const holder = spawn(process.execPath, ['--import', tsxLoader, holderScript, root, SESSION], {
      cwd: repoRoot,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.json') },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const exited = new Promise<void>((resolve) => { holder.once('exit', () => { resolve() }) })
    try {
      await once(holder.stdout, 'data')

      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SessionStore)
      await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
      const mine = ctx.sessionPersistence

      await expect(mine.append(SessionId(SESSION), [
        { type: 'turn/start', seq: 2, time: 3, data: { turn: 2 } },
      ])).rejects.toBeInstanceOf(SessionWriteAlreadyOwnedError)
      const reader = await mine.load(SessionId(SESSION))
      expect(reader.events.map(event => event.seq)).toEqual([0, 1])

      holder.kill('SIGKILL')
      await exited
      await mine.append(SessionId(SESSION), [
        { type: 'turn/start', seq: 2, time: 3, data: { turn: 2 } },
        { type: 'turn/end', seq: 3, time: 4, data: { turn: 2, reason: { kind: 'completed' } } },
      ])
      const taken = await mine.load(SessionId(SESSION))
      expect(taken.events.map(event => event.seq)).toEqual([0, 1, 2, 3])
    } finally {
      if (holder.exitCode === null) holder.kill('SIGKILL')
    }
  })
})
