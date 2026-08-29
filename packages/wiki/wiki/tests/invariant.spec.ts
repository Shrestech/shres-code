import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import SessionStore from '@shres-code/shres-code-session'
import InvariantRegistry, { InvariantError } from '@shres-code/shres-code-invariants'
import * as WikiInvariantCompanion from '../src/invariant.ts'
import WikiService from '../src/index.ts'
import { logPathOf, WikiError } from '../src/index.ts'
import type { WikiFrontmatter, WikiLogSpec, WikiPage, WikiWriteSpec } from '../src/index.ts'

class MemoryWiki extends WikiService {
  pages = new Map<string, WikiPage>()
  index = ''

  async persistPage(spec: WikiWriteSpec, nowMs: number): Promise<WikiPage> {
    const nowIso = new Date(nowMs).toISOString()
    const page: WikiPage = {
      path: spec.path,
      title: spec.title,
      body: spec.body,
      frontmatter: {
        created: nowIso,
        updated: nowIso,
        touched: nowIso,
        status: 'active',
        tags: spec.tags,
        contradicts: spec.contradicts,
      },
    }
    this.pages.set(spec.path, page)
    return page
  }

  async persistTouch(path: string, nowMs: number): Promise<WikiPage> {
    const existing = this.pages.get(path)
    if (existing === undefined) throw new WikiError(`missing ${path}`, 'not-found')
    const page: WikiPage = {
      ...existing,
      frontmatter: { ...existing.frontmatter, touched: new Date(nowMs).toISOString() } satisfies WikiFrontmatter,
    }
    this.pages.set(path, page)
    return page
  }

  async persistLog(spec: WikiLogSpec, nowMs: number): Promise<string> {
    const path = logPathOf(nowMs)
    this.pages.set(path, {
      path,
      title: path,
      body: spec.body,
      frontmatter: {
        created: new Date(nowMs).toISOString(),
        updated: new Date(nowMs).toISOString(),
        touched: new Date(nowMs).toISOString(),
        status: 'active',
      },
    })
    return path
  }

  async persistDemote(): Promise<void> {}
  async persistIndex(markdown: string): Promise<void> { this.index = markdown }
  async loadPages(): Promise<WikiPage[]> { return [...this.pages.values()] }
  async loadIndex(): Promise<string> { return this.index }
  hasPage(path: string): boolean { return this.pages.has(path) }
}

describe('wiki store invariant', () => {
  it('accepts a wiki/page event whose path is present in the store', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(MemoryWiki)
    await ctx.plugin(WikiInvariantCompanion)
    const session = ctx.sessions.create()
    await expect(ctx.wiki.writePage(session, { path: 'ok.md', body: '# Ok' })).resolves.toMatchObject({ kind: 'written' })
  })

  it('rejects a wiki/page event whose path is not in the store', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(MemoryWiki)
    await ctx.plugin(WikiInvariantCompanion)
    const session = ctx.sessions.create()
    expect(() => session.append('wiki/page', { path: 'ghost.md', op: 'create' }, { ignorable: true }))
      .toThrow(InvariantError)
  })

  it('ignores unrelated session events', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(MemoryWiki)
    await ctx.plugin(WikiInvariantCompanion)
    const session = ctx.sessions.create()
    expect(() => session.append('turn/start', { turn: 1 })).not.toThrow()
  })
})
