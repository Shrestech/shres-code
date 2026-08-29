import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePage, parseProjectConfig, serializePage, WikiMarkdownStore } from '../src/store.ts'

const NOW = Date.parse('2026-08-29T12:00:00.000Z')

describe('parsePage / serializePage', () => {
  it('round-trips frontmatter including optional fields', () => {
    const page = parsePage('n.md', serializePage({
      path: 'n.md',
      title: 'N',
      body: 'hello',
      frontmatter: {
        created: 'a',
        updated: 'b',
        touched: 'c',
        status: 'active',
        superseded_by: 'old.md',
        contradicts: ['x.md'],
        tags: ['t'],
      },
    }))
    expect(page.frontmatter).toMatchObject({
      status: 'active',
      superseded_by: 'old.md',
      contradicts: ['x.md'],
      tags: ['t'],
    })
    expect(page.body.trim()).toBe('hello')
  })

  it('treats missing or non-yaml frontmatter as empty freshness', () => {
    expect(parsePage('a.md', 'just body').frontmatter.created).toBe('')
    expect(parsePage('a.md', '---').frontmatter.created).toBe('')
    expect(parsePage('a.md', '---\n[]\n---\nbody').body).toContain('body')
    expect(parsePage('a.md', '---\nstatus: archived\n---\n').frontmatter.status).toBe('archived')
    expect(parsePage('a.md', '---\r\ncreated: x\r\n---\r\nbody').frontmatter.created).toBe('x')
    expect(parsePage('a.md', '---\ntags: []\ncontradicts: [1]\n---\n').frontmatter.tags).toBeUndefined()
    expect(parsePage('a.md', '---\ncreated: x').frontmatter.created).toBe('')
    expect(parsePage('a.md', '---\ncreated: x\n---').frontmatter.created).toBe('x')
    expect(parseProjectConfig('roles:\n  librarian:\n    model: 1\n')).toEqual({})
    expect(parseProjectConfig('roles:\n  librarian:\n    model: only\n')).toEqual({
      roles: { librarian: { model: 'only' } },
    })
    expect(serializePage({
      path: 'n.md',
      title: 'N',
      body: '\nhello',
      frontmatter: { created: 'a', updated: 'b', touched: 'c', status: 'active' },
    })).toMatch(/^---\n/)
  })
})

describe('parseProjectConfig', () => {
  it('reads known fields and ignores junk', () => {
    expect(parseProjectConfig('[]')).toEqual({})
    expect(parseProjectConfig('enabled: true\nhotDays: 2\nroles:\n  librarian:\n    provider: p\n    model: m\n'))
      .toEqual({
        enabled: true,
        hotDays: 2,
        roles: { librarian: { provider: 'p', model: 'm' } },
      })
    expect(parseProjectConfig('roles: []')).toEqual({})
    expect(parseProjectConfig('roles:\n  librarian: []\n')).toEqual({})
    expect(parseProjectConfig('warmDays: 4\ndemoteDays: 9\nroles:\n  librarian:\n    provider: p\n'))
      .toEqual({ warmDays: 4, demoteDays: 9, roles: { librarian: { provider: 'p' } } })
  })
})

describe('WikiMarkdownStore', () => {
  it('does not create a directory until the first write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-store-'))
    const root = join(dir, '.shres', 'wiki')
    const store = new WikiMarkdownStore(root)
    await store.load()
    expect(store.materialized()).toBe(false)
    expect(store.list(true)).toEqual([])
    expect(store.index()).toBe('')
    await store.writePage({
      path: 'notes.md',
      title: 'Notes',
      body: '# Notes\n',
      tags: ['t'],
      contradicts: [],
    }, {
      created: new Date(NOW).toISOString(),
      updated: new Date(NOW).toISOString(),
      touched: new Date(NOW).toISOString(),
      status: 'active',
      tags: ['t'],
      contradicts: [],
    })
    expect(store.materialized()).toBe(true)
    expect(store.has('notes.md')).toBe(true)
    const raw = await readFile(join(root, 'notes.md'), 'utf8')
    expect(raw).toMatch(/status: active/)
    await store.touch('notes.md', NOW + 1000)
    await store.appendLog({ body: 'hello' }, NOW)
    expect(store.has('log/2026-08-29.md')).toBe(true)
    await store.appendLog({ body: 'again' }, NOW)
    await store.writeIndex('# Wiki index\n')
    await store.writeProjectConfig({ enabled: true, hotDays: 3 })
    expect(store.projectConfig().hotDays).toBe(3)
    await store.demote('notes.md', NOW)
    expect(store.has('notes.md')).toBe(false)
    expect(store.has('archive/notes.md')).toBe(true)
    store.invalidate()
    await store.load()
    expect(store.has('archive/notes.md')).toBe(true)
    await expect(store.touch('missing.md', NOW)).rejects.toThrow(/not found/)
    await rm(dir, { recursive: true, force: true })
  })

  it('loads an existing tree including archive, logs, and config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-store-load-'))
    const root = join(dir, 'wiki')
    await mkdir(join(root, 'archive'), { recursive: true })
    await mkdir(join(root, 'log'), { recursive: true })
    await writeFile(join(root, 'index.md'), '# Wiki index\n- [a](a.md)\n')
    await writeFile(join(root, 'config.yaml'), 'warmDays: 11\n')
    await writeFile(join(root, 'a.md'), '---\ncreated: x\nupdated: x\ntouched: x\nstatus: active\n---\n\n# A\n')
    await writeFile(join(root, 'archive', 'old.md'), '---\ncreated: x\nupdated: x\ntouched: x\nstatus: archived\n---\n\nold\n')
    await writeFile(join(root, 'log', '2026-08-29.md'), 'log body\n')
    await writeFile(join(root, 'skip.txt'), 'not markdown')
    await writeFile(join(root, '_skip.md'), 'not a wiki path')
    await mkdir(join(root, 'empty'), { recursive: true })
    const store = new WikiMarkdownStore(root)
    await store.load()
    expect(store.index()).toMatch(/a\.md/)
    expect(store.projectConfig().warmDays).toBe(11)
    expect(store.list(false).map(page => page.path)).toEqual(['a.md'])
    expect(store.list(true).some(page => page.path === 'archive/old.md')).toBe(true)
    await store.load()
    await store.demote('missing.md', NOW)
    await store.demote('archive/old.md', NOW)
    expect(store.has('archive/old.md')).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  it('rethrows a non-absent load error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-store-file-'))
    const root = join(dir, 'not-a-dir')
    await writeFile(root, 'x')
    const store = new WikiMarkdownStore(root)
    await expect(store.load()).rejects.toMatchObject({ code: 'ENOTDIR' })
    await rm(dir, { recursive: true, force: true })
  })
})
