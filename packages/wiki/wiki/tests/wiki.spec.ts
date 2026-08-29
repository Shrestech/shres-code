import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import SessionStore from '@shres-code/shres-code-session'
import type { Session } from '@shres-code/shres-code-session'
import WikiService from '../src/index.ts'
import { archivePathOf, logPathOf, WikiError } from '../src/index.ts'
import type {
  WikiEmbeddings,
  WikiFrontmatter,
  WikiLogSpec,
  WikiPage,
  WikiProjectConfig,
  WikiWriteSpec,
} from '../src/index.ts'

const NOW = Date.parse('2026-08-29T00:00:00.000Z')
const HOT = new Date(NOW).toISOString()
const COLD = new Date(NOW - 100 * 86_400_000).toISOString()

class MemoryWiki extends WikiService {
  pages = new Map<string, WikiPage>()
  index = ''
  project: WikiProjectConfig = {}

  override projectConfig(): WikiProjectConfig {
    return this.project
  }

  async persistPage(spec: WikiWriteSpec, nowMs: number): Promise<WikiPage> {
    const existing = this.pages.get(spec.path)
    const archived = spec.path.startsWith('archive/')
    const nowIso = new Date(nowMs).toISOString()
    const frontmatter: WikiFrontmatter = {
      ...this.freshness(nowIso, existing?.frontmatter, archived),
      tags: spec.tags,
      contradicts: spec.contradicts,
      ...spec.superseded_by === undefined ? {} : { superseded_by: spec.superseded_by },
    }
    const page: WikiPage = { path: spec.path, title: spec.title, body: spec.body, frontmatter }
    this.pages.set(spec.path, page)
    return page
  }

  async persistTouch(path: string, nowMs: number): Promise<WikiPage> {
    const existing = this.pages.get(path)
    if (existing === undefined) throw new WikiError(`missing ${path}`, 'not-found')
    const page: WikiPage = {
      ...existing,
      frontmatter: { ...existing.frontmatter, touched: new Date(nowMs).toISOString() },
    }
    this.pages.set(path, page)
    return page
  }

  async persistLog(spec: WikiLogSpec, nowMs: number): Promise<string> {
    const path = logPathOf(nowMs)
    const existing = this.pages.get(path)
    const body = existing === undefined ? spec.body : `${existing.body}\n${spec.body}`
    this.pages.set(path, {
      path,
      title: path,
      body,
      frontmatter: this.freshness(new Date(nowMs).toISOString(), existing?.frontmatter, false),
    })
    return path
  }

  async persistDemote(path: string, nowMs: number): Promise<void> {
    const existing = this.pages.get(path)
    if (existing === undefined) return
    this.pages.delete(path)
    const dest = archivePathOf(path)
    this.pages.set(dest, {
      ...existing,
      path: dest,
      frontmatter: {
        ...existing.frontmatter,
        status: 'archived',
        updated: new Date(nowMs).toISOString(),
      },
    })
  }

  async persistIndex(markdown: string): Promise<void> {
    this.index = markdown
  }

  async loadPages(includeArchive: boolean): Promise<WikiPage[]> {
    return [...this.pages.values()].filter(page => includeArchive || !page.path.startsWith('archive/'))
  }

  async loadIndex(): Promise<string> {
    return this.index
  }

  hasPage(path: string): boolean {
    return this.pages.has(path)
  }
}

async function mount(config: ConstructorParameters<typeof WikiService>[1] = {}): Promise<{
  ctx: Context
  wiki: MemoryWiki
  session: Session
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(MemoryWiki, config)
  const session = ctx.sessions.create()
  return { ctx, wiki: ctx.wiki as MemoryWiki, session }
}

describe('WikiService settings overlay', () => {
  it('remounts from a live settings section', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const watchers: Array<() => void> = []
    ctx.provide('settings', {
      register: () => ({
        get: () => ({ enabled: false }),
        watch: (fn: () => void) => {
          watchers.push(fn)
          return () => {}
        },
      }),
    })
    await ctx.plugin(MemoryWiki, { enabled: true })
    expect(ctx.wiki.status.active).toBe(false)
    expect(ctx.wiki.settings).toEqual({ enabled: false })
    const stop = ctx.wiki.watch(() => {})
    watchers[0]?.()
    expect(ctx.wiki.status.active).toBe(false)
    stop()
  })
})

describe('WikiService write/read/list/touch/log', () => {
  it('writes a page, logs wiki/page create, and regenerates the index', async () => {
    const { wiki, session } = await mount()
    const result = await wiki.writePage(session, { path: 'notes.md', body: '# Notes\n\nsee [other](other.md)' }, NOW)
    expect(result.kind).toBe('written')
    if (result.kind !== 'written') throw new Error('expected written')
    expect(result.page.title).toBe('Notes')
    expect(wiki.hasPage('notes.md')).toBe(true)
    expect(session.events.some(event => event.type === 'wiki/page' && event.data.op === 'create')).toBe(true)
    expect(wiki.index).toMatch(/notes\.md/)
    const again = await wiki.writePage(session, { path: 'notes.md', body: '# Notes\n\nupdated' }, NOW + 1)
    expect(again.kind).toBe('written')
    expect(session.events.filter(event => event.type === 'wiki/page' && event.data.op === 'update')).toHaveLength(1)
  })

  it('rejects illegal writes and disabled writes without persisting', async () => {
    const { wiki, session } = await mount({ enabled: false })
    expect(wiki.status).toEqual({ active: false, reason: 'disabled' })
    const disabled = await wiki.writePage(session, { path: 'a.md', body: 'x' }, NOW)
    expect(disabled).toMatchObject({ kind: 'failed', reason: 'disabled' })
    expect(wiki.settingsLibrarian()).toBeUndefined()
    const { wiki: open, session: live } = await mount()
    const bad = await open.writePage(live, { path: '../x.md', body: 'x' }, NOW)
    expect(bad).toMatchObject({ kind: 'failed', reason: 'invalid-path' })
    const blank = await open.writePage(live, { path: '', body: 'x' }, NOW)
    expect(blank).toMatchObject({ kind: 'failed', reason: 'required-field' })
  })

  it('appends a log shard and refuses a blank body', async () => {
    const { wiki, session } = await mount()
    const result = await wiki.appendLog(session, { body: 'shipped card' }, NOW)
    expect(result).toEqual({ kind: 'appended', path: 'log/2026-08-29.md' })
    expect(session.events.some(event => event.type === 'wiki/page' && event.data.op === 'log')).toBe(true)
    const second = await wiki.appendLog(session, { body: 'again' }, NOW)
    expect(second.kind).toBe('appended')
    const blank = await wiki.appendLog(session, { body: ' ' }, NOW)
    expect(blank).toMatchObject({ kind: 'failed', reason: 'required-field' })
    const { wiki: off, session: dead } = await mount({ enabled: false })
    expect(await off.appendLog(dead, { body: 'x' }, NOW)).toMatchObject({ kind: 'failed', reason: 'disabled' })
  })

  it('touches on the read path and fails for missing pages', async () => {
    const { wiki, session } = await mount()
    await wiki.writePage(session, { path: 'a.md', body: 'alpha language' }, NOW)
    const touched = await wiki.touch(session, 'a.md', NOW + 5_000)
    expect(touched.kind).toBe('written')
    if (touched.kind !== 'written') throw new Error('expected written')
    expect(Date.parse(touched.page.frontmatter.touched)).toBe(NOW + 5_000)
    expect(session.events.some(event => event.type === 'wiki/page' && event.data.op === 'touch')).toBe(true)
    expect(await wiki.touch(session, 'missing.md', NOW)).toMatchObject({ kind: 'failed', reason: 'not-found' })
    const { wiki: off, session: dead } = await mount({ enabled: false })
    expect(await off.touch(dead, 'a.md', NOW)).toMatchObject({ kind: 'failed', reason: 'disabled' })
  })

  it('lists by temperature and substring, hiding archive by default', async () => {
    const { wiki, session } = await mount()
    await wiki.writePage(session, { path: 'hot.md', body: '# Hot page' }, NOW)
    wiki.pages.set('cold.md', {
      path: 'cold.md',
      title: 'Cold',
      body: 'old',
      frontmatter: { created: COLD, updated: COLD, touched: COLD, status: 'active' },
    })
    wiki.pages.set('archive/old.md', {
      path: 'archive/old.md',
      title: 'Old',
      body: 'archived',
      frontmatter: { created: COLD, updated: COLD, touched: COLD, status: 'archived' },
    })
    const listed = await wiki.list({}, NOW)
    wiki.pages.set('hot-b.md', {
      path: 'hot-b.md',
      title: 'Hot B',
      body: 'b',
      frontmatter: { created: HOT, updated: HOT, touched: HOT, status: 'active' },
    })
    wiki.pages.set('ghost.md', {
      path: 'ghost.md',
      title: 'Ghost',
      body: 'g',
      frontmatter: { created: HOT, updated: HOT, touched: HOT, status: 'archived' },
    })
    expect(listed.map(page => page.path)).toEqual(['hot.md', 'cold.md'])
    expect((await wiki.list({}, NOW)).map(page => page.path)).toEqual(['hot-b.md', 'hot.md', 'cold.md'])
    expect((await wiki.list({ temperature: 'HOT' }, NOW)).map(page => page.path)).toEqual(['hot-b.md', 'hot.md'])
    expect((await wiki.list({ substring: 'zzzz' }, NOW))).toEqual([])
    expect((await wiki.list({ includeArchive: true, substring: 'archive/old' }, NOW)).map(page => page.path))
      .toEqual(['archive/old.md'])
    expect(await wiki.read('hot.md')).toMatchObject({ path: 'hot.md' })
    expect(await wiki.read('nope.md')).toBeUndefined()
  })
})

describe('WikiService search / similar / embeddings', () => {
  it('ranks HOT above COLD for the same query and omits archive', async () => {
    const { wiki, session } = await mount()
    await wiki.writePage(session, { path: 'hot.md', body: 'gradient descent language' }, NOW)
    wiki.pages.set('cold.md', {
      path: 'cold.md',
      title: 'cold',
      body: 'gradient descent language extra extra extra',
      frontmatter: { created: COLD, updated: COLD, touched: COLD, status: 'active' },
    })
    wiki.pages.set('archive/x.md', {
      path: 'archive/x.md',
      title: 'x',
      body: 'gradient descent language',
      frontmatter: { created: COLD, updated: COLD, touched: COLD, status: 'archived' },
    })
    const hits = await wiki.search('language', { limit: 10 }, NOW)
    expect(hits[0]?.path).toBe('hot.md')
    expect(hits.some(hit => hit.path.startsWith('archive/'))).toBe(false)
    const archived = await wiki.search('language', { includeArchive: true }, NOW)
    expect(archived.some(hit => hit.path === 'archive/x.md')).toBe(true)
  })

  it('mixes cosine scores when embeddings are registered and falls back after dispose', async () => {
    const { wiki, session } = await mount()
    await wiki.writePage(session, { path: 'a.md', body: 'alpha' }, NOW)
    await wiki.writePage(session, { path: 'b.md', body: 'beta' }, NOW)
    const provider: WikiEmbeddings = {
      available: () => true,
      async embed(texts) {
        return texts.map((text) => {
          if (text.startsWith('alpha')) return [1, 0]
          if (text.includes('alpha')) return [1, 0]
          if (text.includes('beta')) return [0, 1]
          return [0, 0]
        })
      },
    }
    const stop = wiki.registerEmbeddings(provider)
    expect(wiki.embeddingsProvider()).toBe(provider)
    const hits = await wiki.search('alpha', {}, NOW)
    expect(hits[0]?.path).toBe('a.md')
    const similar = await wiki.similar('a.md', 5, NOW)
    expect(similar.every(hit => hit.path !== 'a.md')).toBe(true)
    expect(await wiki.similar('missing.md', 5, NOW)).toEqual([])
    const replacement: WikiEmbeddings = {
      available: () => true,
      embed: async texts => texts.map(() => [0, 1]),
    }
    wiki.registerEmbeddings(replacement)
    expect(wiki.embeddingsProvider()).toBe(replacement)
    stop()
    expect(wiki.embeddingsProvider()).toBe(replacement)
    wiki.registerEmbeddings(replacement)()
    expect(wiki.embeddingsProvider()).toBeUndefined()
    const lexical = await wiki.search('alpha', {}, NOW)
    expect(lexical[0]?.path).toBe('a.md')
  })

  it('skips embeddings that report unavailable', async () => {
    const { wiki, session } = await mount()
    await wiki.writePage(session, { path: 'a.md', body: 'alpha' }, NOW)
    wiki.registerEmbeddings({
      available: () => false,
      embed: async () => {
        throw new Error('must not load')
      },
    })
    await expect(wiki.search('alpha', {}, NOW)).resolves.toMatchObject([{ path: 'a.md' }])
  })

  it('skips a cosine mix-in when the query vector is missing', async () => {
    const { wiki, session } = await mount()
    await wiki.writePage(session, { path: 'a.md', body: 'alpha' }, NOW)
    wiki.registerEmbeddings({
      available: () => true,
      embed: async () => [],
    })
    const hits = await wiki.search('alpha', {}, NOW)
    expect(hits[0]?.path).toBe('a.md')
    expect((await wiki.search(' ', {}, NOW)).some(hit => hit.path === 'a.md')).toBe(true)
  })
})

describe('WikiService lint / reindex / demotion / settings', () => {
  it('lints missing index coverage then reindex clears it and demotes COLD pages', async () => {
    const { wiki, session } = await mount()
    await wiki.writePage(session, { path: 'live.md', body: 'see [live](live.md)' }, NOW)
    wiki.pages.set('stale.md', {
      path: 'stale.md',
      title: 'stale',
      body: 'see [live](live.md)',
      frontmatter: { created: COLD, updated: COLD, touched: COLD, status: 'active' },
    })
    const before = await wiki.lint()
    expect(before.some(issue => issue.code === 'index-missing' && issue.path === 'stale.md')).toBe(true)
    await wiki.reindex(session, NOW)
    expect(wiki.hasPage('stale.md')).toBe(false)
    expect(wiki.hasPage('archive/stale.md')).toBe(true)
    expect(session.events.some(event => event.type === 'wiki/page' && event.data.op === 'archive')).toBe(true)
    const after = await wiki.lint()
    expect(after.some(issue => issue.path === 'stale.md')).toBe(false)
  })

  it('watches status and reports an unbound librarian by default', async () => {
    const { wiki } = await mount()
    const seen: string[] = []
    const stop = wiki.watch((status) => { seen.push(status.reason) })
    expect(seen).toEqual(['active'])
    expect(wiki.settingsLibrarian()).toBeUndefined()
    expect(wiki.engineConfig.hotDays).toBe(7)
    wiki.project = { hotDays: 3, warmDays: 10, demoteDays: 20 }
    expect(wiki.engineConfig.hotDays).toBe(3)
    stop()
    wiki.watch(() => {})()
  })

  it('reports a bound librarian and rejects a half-specified pair at mount', async () => {
    const { wiki } = await mount({ roles: { librarian: { provider: 'ollama-local', model: 'qwen' } } })
    expect(wiki.settingsLibrarian()).toEqual({ provider: 'ollama-local', model: 'qwen' })
    expect(() => new MemoryWiki(new Context(), { roles: { librarian: { provider: 'p' } } }))
      .toThrow(/together/)
  })

  it('ranks WARM between HOT and COLD and demotes without a session log', async () => {
    const { wiki } = await mount()
    const warm = new Date(NOW - 8 * 86_400_000).toISOString()
    wiki.pages.set('warm.md', {
      path: 'warm.md',
      title: 'Warm',
      body: 'see [warm](warm.md)',
      frontmatter: { created: warm, updated: warm, touched: warm, status: 'active' },
    })
    wiki.pages.set('archive/gone.md', {
      path: 'archive/gone.md',
      title: 'Gone',
      body: 'x',
      frontmatter: { created: COLD, updated: COLD, touched: COLD, status: 'archived' },
    })
    wiki.pages.set('stale.md', {
      path: 'stale.md',
      title: 'stale',
      body: 'see [warm](warm.md)',
      frontmatter: { created: COLD, updated: COLD, touched: COLD, status: 'active' },
    })
    expect((await wiki.list({}, NOW)).map(page => page.path)).toEqual(['warm.md', 'stale.md'])
    await wiki.reindex(undefined, NOW)
    expect(wiki.hasPage('archive/stale.md')).toBe(true)
    expect(wiki.hasPage('stale.md')).toBe(false)
  })

  it('copies optional frontmatter through freshness', async () => {
    const { wiki } = await mount()
    expect(wiki.freshness('now', {
      created: 'a', updated: 'b', touched: 'c', status: 'active',
      superseded_by: 'x.md', contradicts: ['y.md'], tags: ['t'],
    }, true)).toMatchObject({
      created: 'a',
      status: 'archived',
      superseded_by: 'x.md',
      contradicts: ['y.md'],
      tags: ['t'],
    })
  })

  it('throws non-WikiError from resolve through writePage', async () => {
    const { wiki, session } = await mount()
    await expect(wiki.writePage(session, { path: 'p.md', body: 'b', title: 1 as unknown as string }, NOW))
      .rejects.toBeInstanceOf(TypeError)
  })
})
