import { describe, expect, it } from 'vitest'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@shres-code/cordis'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import { FsTargetKey } from '@shres-code/shres-code-fs'
import type { FsTarget } from '@shres-code/shres-code-fs'
import { logPathOf } from '@shres-code/shres-code-wiki'
import FileWikiService, { findProjectRoot } from '../src/index.ts'
import * as Companion from '../src/invariant.ts'

const NOW = Date.parse('2026-08-29T00:00:00.000Z')

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('findProjectRoot', () => {
  it('returns the .git ancestor or cwd when none exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-root-'))
    const nested = join(dir, 'src', 'pkg')
    await mkdir(nested, { recursive: true })
    expect(await findProjectRoot(nested)).toBe(nested)
    await mkdir(join(dir, '.git'))
    expect(await findProjectRoot(nested)).toBe(dir)
    expect(await FileWikiService.resolveRoot('/abs/wiki', nested)).toBe('/abs/wiki')
    expect(await FileWikiService.resolveRoot('.shres/wiki', nested)).toBe(join(dir, '.shres/wiki'))
    await rm(dir, { recursive: true, force: true })
  })
})

describe('FileWikiService', () => {
  it('does not materialize the wiki dir until the first write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-fs-'))
    const root = join(dir, '.shres', 'wiki')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(FileWikiService, { root, watch: false })
    const session = ctx.sessions.create()
    expect(await exists(root)).toBe(false)
    expect(await ctx.wiki.list(session, {})).toEqual([])
    const result = await ctx.wiki.writePage(session, { path: 'p.md', body: '# P\n\nhello' }, NOW)
    expect(result.kind).toBe('written')
    expect(await exists(join(root, 'p.md'))).toBe(true)
    expect(await exists(join(root, 'index.md'))).toBe(true)
    await ctx.wiki.appendLog(session, { body: 'logged' }, NOW)
    expect(await exists(join(root, ...logPathOf(NOW).split('/')))).toBe(true)
    await ctx.wiki.touch(session, 'p.md', NOW + 10)
    const cold = new Date(NOW - 100 * 86_400_000).toISOString()
    await ctx.wiki.writePage(session, { path: 'old.md', body: '# Old\n' }, NOW - 100 * 86_400_000)
    const page = await ctx.wiki.read(session, 'old.md')
    expect(page?.frontmatter.touched).toBe(cold)
    await ctx.wiki.reindex(session, NOW)
    expect(ctx.wiki.hasPage('archive/old.md')).toBe(true)
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('fails loud on an empty root and relocates a relative root under .git', async () => {
    expect(() => new FileWikiService(new Context(), { root: '   ' })).toThrow(/non-empty/)
    expect(new FileWikiService(new Context(), {}).constructor).toBe(FileWikiService)
    const dir = await mkdtemp(join(tmpdir(), 'wiki-rel-'))
    await mkdir(join(dir, '.git'))
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(FileWikiService, { root: '.shres/wiki', cwd: join(dir, 'src'), watch: false })
    const session = ctx.sessions.create()
    await ctx.wiki.writePage(session, { path: 'n.md', body: 'n' }, NOW)
    expect(await exists(join(dir, '.shres', 'wiki', 'n.md'))).toBe(true)
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
    const bare = await mkdtemp(join(tmpdir(), 'wiki-bare-'))
    const nested = join(bare, 'src')
    await mkdir(nested, { recursive: true })
    const ctxBare = new Context()
    await ctxBare.plugin(SessionStore)
    await ctxBare.plugin(FileWikiService, { root: '.shres/wiki', cwd: nested, watch: false })
    await ctxBare.wiki.writePage(ctxBare.sessions.create(), { path: 'b.md', body: 'b' }, NOW)
    expect(await exists(join(nested, '.shres', 'wiki', 'b.md'))).toBe(true)
    await ctxBare.fiber.dispose()
    await rm(bare, { recursive: true, force: true })
  })

  it('invalidates on fs/observed under the wiki root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-obs-'))
    const root = join(dir, 'wiki')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(FileWikiService, { root, watch: false })
    const session = ctx.sessions.create()
    await ctx.wiki.writePage(session, { path: 'a.md', body: 'a' }, NOW)
    await writeFile(join(root, 'b.md'), '---\ncreated: x\nupdated: x\ntouched: x\nstatus: active\n---\n\n# B\n')
    const observed = (path: string): FsTarget => ({ targetKey: FsTargetKey(path), displayPath: path })
    ctx.emit('fs/observed', observed(join(root, 'b.md')), { kind: 'absent' }, { name: 'write' })
    const listed = await ctx.wiki.list(session, {}, NOW)
    expect(listed.some(page => page.path === 'b.md')).toBe(true)
    ctx.emit('fs/observed', observed('/unrelated'), { kind: 'absent' }, { name: 'write' })
    ctx.emit('fs/observed', observed('not-an-object'), { kind: 'absent' }, undefined)
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('roots each session in its own repository wiki', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-per-repo-'))
    const repoA = join(dir, 'a')
    const repoB = join(dir, 'b')
    await mkdir(join(repoA, '.git'), { recursive: true })
    await mkdir(join(repoA, 'pkg'), { recursive: true })
    await mkdir(join(repoB, '.git'), { recursive: true })
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(FileWikiService, { watch: false })
    const sessionA = ctx.sessions.create(SessionId('per-repo-a'), { meta: { cwd: join(repoA, 'pkg') } })
    const sessionB = ctx.sessions.create(SessionId('per-repo-b'), { meta: { cwd: repoB } })
    await ctx.wiki.writePage(sessionA, { path: 'a.md', body: '# A' }, NOW)
    await ctx.wiki.writePage(sessionB, { path: 'b.md', body: '# B' }, NOW)
    expect(await exists(join(repoA, '.shres', 'wiki', 'a.md'))).toBe(true)
    expect(await exists(join(repoB, '.shres', 'wiki', 'b.md'))).toBe(true)
    expect(await exists(join(repoB, '.shres', 'wiki', 'a.md'))).toBe(false)
    const listedB = await ctx.wiki.list(sessionB, {})
    expect(listedB.map(page => page.path)).toEqual(['b.md'])
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('appends timestamped JSONL lines to the local day shard', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-jsonl-'))
    const root = join(dir, '.shres', 'wiki')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(FileWikiService, { root, watch: false })
    const session = ctx.sessions.create()
    await ctx.wiki.appendLog(session, { body: 'first' }, NOW)
    await ctx.wiki.appendLog(session, { body: 'second' }, NOW + 1)
    const shardRaw = await readFile(join(root, ...logPathOf(NOW).split('/')), 'utf8')
    const entries = shardRaw.trimEnd().split('\n').map(line => JSON.parse(line) as { ts: string; session?: string; body: string })
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ ts: new Date(NOW).toISOString(), body: 'first' })
    expect(typeof entries[0]?.session).toBe('string')
    expect(entries[1]?.body).toBe('second')
    expect(Date.parse(entries[1]?.ts ?? '')).toBe(NOW + 1)
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('starts a watcher after the first write and disposes it with the fiber', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-watch-'))
    const root = join(dir, 'wiki')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(FileWikiService, { root, watch: true })
    const session = ctx.sessions.create()
    await ctx.wiki.writePage(session, { path: 'topics/nested.md', body: '# Nested' }, NOW)
    expect(await exists(join(root, 'topics', 'nested.md'))).toBe(true)
    await writeFile(join(root, 'extra.md'), '---\ncreated: x\nupdated: x\ntouched: x\nstatus: active\n---\n\n# Extra\n')
    await new Promise(resolve => setTimeout(resolve, 400))
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('wiki-filesystem invariant companion', () => {
  it('registers without a runtime check', async () => {
    const ctx = new Context()
    const invariants = { register: (name: string, install: () => void) => {
      expect(name).toBe('@shres-code/shres-code-wiki-filesystem')
      install()
      return () => {}
    } }
    ctx.provide('invariants', invariants)
    await Companion.apply(ctx)
  })
})
