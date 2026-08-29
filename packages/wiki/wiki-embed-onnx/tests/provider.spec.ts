import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@shres-code/cordis'
import SessionStore from '@shres-code/shres-code-session'
import WikiService from '@shres-code/shres-code-wiki'
import type { WikiFrontmatter, WikiLogSpec, WikiPage, WikiWriteSpec } from '@shres-code/shres-code-wiki'
import * as plugin from '../src/index.ts'
import {
  cacheIsWarm,
  resolveOptions,
  vectorsFrom,
  WIKI_EMBED_DEFAULT_MODEL_ID,
  WikiOnnxEmbeddings,
} from '../src/index.ts'
import * as Companion from '../src/invariant.ts'
import type { WikiEmbedLoader } from '../src/provider.ts'

class MemoryWiki extends WikiService {
  pages = new Map<string, WikiPage>()
  index = ''

  async persistPage(spec: WikiWriteSpec, nowMs: number): Promise<WikiPage> {
    const nowIso = new Date(nowMs).toISOString()
    const frontmatter: WikiFrontmatter = {
      created: nowIso,
      updated: nowIso,
      touched: nowIso,
      status: 'active',
      tags: spec.tags,
      contradicts: spec.contradicts,
    }
    const page: WikiPage = { path: spec.path, title: spec.title, body: spec.body, frontmatter }
    this.pages.set(spec.path, page)
    return page
  }

  async persistTouch(path: string, nowMs: number): Promise<WikiPage> {
    const existing = this.pages.get(path)
    if (existing === undefined) throw new Error(path)
    const page: WikiPage = {
      ...existing,
      frontmatter: { ...existing.frontmatter, touched: new Date(nowMs).toISOString() },
    }
    this.pages.set(path, page)
    return page
  }

  async persistLog(spec: WikiLogSpec, nowMs: number): Promise<string> {
    const path = `log/${new Date(nowMs).toISOString().slice(0, 10)}.md`
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

const loadOk: WikiEmbedLoader = () => Promise.resolve(async (texts) => {
  const count = typeof texts === 'string' ? 1 : texts.length
  return Array.from({ length: count }, (_, index) => [1, index])
})

describe('vectorsFrom', () => {
  it('reads nested arrays, tolist, and dims/data tensors', () => {
    expect(vectorsFrom([[1, 2], [3, 4]], 2)).toEqual([[1, 2], [3, 4]])
    expect(vectorsFrom({ tolist: () => [[5, 6]] }, 1)).toEqual([[5, 6]])
    expect(vectorsFrom({ data: [1, 0, 0, 1], dims: [2, 2] }, 2)).toEqual([[1, 0], [0, 1]])
    expect(vectorsFrom({ data: undefined }, 1)).toEqual([[]])
    expect(vectorsFrom({ data: [1], dims: [1, 0] }, 1)).toEqual([[]])
    expect(vectorsFrom('nope', 2)).toEqual([[], []])
  })
})

describe('cacheIsWarm', () => {
  it('is false for a missing path and a file, true for a non-empty directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-embed-cache-'))
    const file = join(dir, 'not-a-dir')
    try {
      expect(cacheIsWarm(join(dir, 'missing'))).toBe(false)
      await writeFile(file, 'x')
      expect(cacheIsWarm(file)).toBe(false)
      await writeFile(join(dir, 'weight.bin'), 'x')
      expect(cacheIsWarm(dir)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('WikiOnnxEmbeddings', () => {
  it('embeds through an injected loader and reuses the engine', async () => {
    const provider = new WikiOnnxEmbeddings(() => resolveOptions({
      cacheDir: '/tmp/wiki-embed-test',
    }, loadOk))
    expect(provider.available()).toBe(true)
    const once = await provider.embed(['alpha'])
    expect(once).toHaveLength(1)
    const batch = await provider.embed(['a', 'b'])
    expect(batch).toHaveLength(2)
    expect(await provider.embed([])).toEqual([])
    const again = await provider.embed(['alpha'])
    expect(again).toHaveLength(1)
  })

  it('refuses embed when disabled or when download is forbidden on a cold cache', async () => {
    const cold = new WikiOnnxEmbeddings(() => resolveOptions({
      enabled: false,
      cacheDir: join(tmpdir(), 'wiki-embed-missing'),
    }, loadOk))
    expect(cold.available()).toBe(false)
    await expect(cold.embed(['x'])).rejects.toThrow(/unavailable/)
    const noDownload = new WikiOnnxEmbeddings(() => resolveOptions({
      allowDownload: false,
      cacheDir: join(tmpdir(), 'wiki-embed-cold'),
    }, loadOk))
    expect(noDownload.available()).toBe(false)
  })

  it('shares an in-flight load between concurrent embed calls', async () => {
    let loads = 0
    const slow: WikiEmbedLoader = async () => {
      loads += 1
      await new Promise(resolve => setTimeout(resolve, 20))
      return async () => [[1, 0]]
    }
    const provider = new WikiOnnxEmbeddings(() => resolveOptions({}, slow))
    const [a, b] = await Promise.all([provider.embed(['x']), provider.embed(['y'])])
    expect(a).toEqual([[1, 0]])
    expect(b).toEqual([[1, 0]])
    expect(loads).toBe(1)
  })

  it('loads once per model and recovers after a failed load', async () => {
    let loads = 0
    const failFirst: WikiEmbedLoader = async () => {
      loads += 1
      if (loads === 1) throw new Error('boom')
      return async () => [[1, 0]]
    }
    const provider = new WikiOnnxEmbeddings(() => resolveOptions({}, failFirst))
    await expect(provider.embed(['a'])).rejects.toThrow('boom')
    expect(await provider.embed(['a'])).toEqual([[1, 0]])
    expect(loads).toBe(2)
  })
})

describe('wiki-embed-onnx apply', () => {
  it('registers on ctx.wiki and unregisters on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(MemoryWiki)
    const fiber = await ctx.plugin(plugin)
    expect(ctx.wiki.embeddingsProvider()?.available()).toBe(true)
    expect(plugin.name).toBe('wiki-embed-onnx')
    expect(plugin.inject).toEqual(['wiki'])
    expect(resolveOptions({}).modelId).toBe(WIKI_EMBED_DEFAULT_MODEL_ID)
    await fiber.dispose()
    expect(ctx.wiki.embeddingsProvider()).toBeUndefined()
  })
})

describe('wiki-embed-onnx invariant companion', () => {
  it('registers without a runtime check', async () => {
    const ctx = new Context()
    ctx.provide('invariants', {
      register: (name: string, install: () => void) => {
        expect(name).toBe('@shres-code/shres-code-wiki-embed-onnx')
        install()
        return () => {}
      },
    })
    await Companion.apply(ctx)
  })
})
