import { describe, expect, it } from 'vitest'
import {
  ageDays,
  archivePathOf,
  bm25Scores,
  combinedScore,
  cosineSimilarity,
  excerptOf,
  generateIndex,
  indexListedPaths,
  isArchivedPath,
  lintPages,
  logPathOf,
  outboundLinks,
  rankHits,
  shouldDemote,
  temperatureOf,
  localDateStamp,
  tokenize,
} from '../src/engine.ts'
import type { WikiEngineConfig } from '../src/resolve.ts'
import type { WikiPage, WikiSearchHit } from '../src/types.ts'

const ENGINE: WikiEngineConfig = {
  hotDays: 7,
  warmDays: 30,
  demoteDays: 90,
  indexMaxLines: 200,
}

const NOW = Date.parse('2026-08-29T00:00:00.000Z')

function page(path: string, body: string, touched: string, extras: Partial<WikiPage['frontmatter']> = {}): WikiPage {
  return {
    path,
    title: path.replace(/\.md$/u, ''),
    body,
    frontmatter: {
      created: touched,
      updated: touched,
      touched,
      status: path.startsWith('archive/') ? 'archived' : 'active',
      ...extras,
    },
  }
}

describe('temperatureOf / shouldDemote', () => {
  it('ranks HOT, WARM, and COLD from touched age', () => {
    expect(temperatureOf(new Date(NOW).toISOString(), NOW, ENGINE)).toBe('HOT')
    expect(temperatureOf(new Date(NOW - 7 * 86_400_000).toISOString(), NOW, ENGINE)).toBe('HOT')
    expect(temperatureOf(new Date(NOW - 8 * 86_400_000).toISOString(), NOW, ENGINE)).toBe('WARM')
    expect(temperatureOf(new Date(NOW - 30 * 86_400_000).toISOString(), NOW, ENGINE)).toBe('WARM')
    expect(temperatureOf(new Date(NOW - 31 * 86_400_000).toISOString(), NOW, ENGINE)).toBe('COLD')
  })

  it('demotes only past demoteDays', () => {
    expect(shouldDemote(new Date(NOW - 90 * 86_400_000).toISOString(), NOW, ENGINE)).toBe(false)
    expect(shouldDemote(new Date(NOW - 91 * 86_400_000).toISOString(), NOW, ENGINE)).toBe(true)
  })

  it('treats an unparseable timestamp as infinitely old', () => {
    expect(ageDays('not-a-date', NOW)).toBe(Number.POSITIVE_INFINITY)
    expect(temperatureOf('not-a-date', NOW, ENGINE)).toBe('COLD')
    expect(shouldDemote('not-a-date', NOW, ENGINE)).toBe(true)
  })
})

describe('archive paths', () => {
  it('prefixes archive/ once', () => {
    expect(isArchivedPath('notes.md')).toBe(false)
    expect(isArchivedPath('archive/notes.md')).toBe(true)
    expect(archivePathOf('notes.md')).toBe('archive/notes.md')
    expect(archivePathOf('archive/notes.md')).toBe('archive/notes.md')
  })
})

describe('rankHits', () => {
  it('orders HOT above COLD then by descending score', () => {
    const hits: WikiSearchHit[] = [
      { path: 'cold.md', title: 'c', temperature: 'COLD', score: 9, excerpt: '' },
      { path: 'hot-low.md', title: 'h', temperature: 'HOT', score: 1, excerpt: '' },
      { path: 'hot-high.md', title: 'h', temperature: 'HOT', score: 5, excerpt: '' },
      { path: 'warm.md', title: 'w', temperature: 'WARM', score: 8, excerpt: '' },
    ]
    expect(rankHits(hits).map(hit => hit.path)).toEqual([
      'hot-high.md',
      'hot-low.md',
      'warm.md',
      'cold.md',
    ])
  })
})

describe('tokenize / bm25 / excerpt', () => {
  it('tokenizes lowercase alphanumerics', () => {
    expect(tokenize('Hello, Wiki-2!')).toEqual(['hello', 'wiki', '2'])
    expect(tokenize('')).toEqual([])
  })

  it('scores a matching page above an unrelated one and ignores empty queries', () => {
    const pages = [
      page('alpha.md', 'gradient descent for language models', '2026-08-01T00:00:00.000Z'),
      page('beta.md', 'gardening tomatoes in clay soil', '2026-08-01T00:00:00.000Z'),
    ]
    const scores = bm25Scores(pages, 'language models')
    expect(scores.get('alpha.md') ?? 0).toBeGreaterThan(scores.get('beta.md') ?? 0)
    expect(bm25Scores(pages, '').size).toBe(0)
    expect(bm25Scores([], 'query').size).toBe(0)
    expect((bm25Scores(pages, 'language language').get('alpha.md') ?? 0)).toBeGreaterThan(0)
  })

  it('excerpts around the first query token', () => {
    const body = 'aaa '.repeat(20) + 'needle in haystack ' + 'bbb '.repeat(20)
    expect(excerptOf(body, 'needle')).toMatch(/needle/)
    expect(excerptOf('short body', 'absent')).toBe('short body')
  })
})

describe('cosineSimilarity / combinedScore', () => {
  it('returns 1 for identical vectors and 0 for zeros or mismatches', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosineSimilarity([], [1])).toBe(0)
    expect(cosineSimilarity([1], [1, 2])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })

  it('falls back to BM25 when cosine is absent and mixes when present', () => {
    expect(combinedScore(3, undefined)).toBe(3)
    const mixed = combinedScore(0, 1)
    expect(mixed).toBeGreaterThan(0.5)
    expect(mixed).toBeLessThan(1)
  })
})

describe('outboundLinks / lintPages / index', () => {
  it('collects markdown and wiki links, skipping URLs and hashes', () => {
    expect(outboundLinks('see [a](other.md#x) and [[Topic]] and [[Topic.md]] and [web](https://ex.test/a.md) and [hash](#) and [txt](n.txt)')).toEqual([
      'other.md',
      'Topic.md',
    ])
  })

  it('reports missing freshness, dead links, orphans, and index drift', () => {
    const pages = [
      page('live.md', 'see [gone](missing.md)', '2026-08-01T00:00:00.000Z'),
      page('archive/old.md', 'old', '2026-01-01T00:00:00.000Z'),
      {
        path: 'gone.md',
        title: 'gone',
        body: 'x',
        frontmatter: { created: 'x', updated: 'x', touched: 'x', status: 'archived' as const },
      },
      {
        path: 'blank.md',
        title: 'blank',
        body: 'n',
        frontmatter: { created: '', updated: '', touched: '', status: 'active' as const },
      },
    ]
    const issues = lintPages(pages, '- [gone](missing.md)\n- [old](archive/old.md)\n')
    const codes = issues.map(issue => issue.code).sort()
    expect(codes).toContain('missing-created')
    expect(codes).toContain('missing-updated')
    expect(codes).toContain('missing-touched')
    expect(codes).toContain('dead-link')
    expect(codes).toContain('orphan')
    expect(codes).toContain('index-missing')
    expect(codes).toContain('index-stale')
    expect(codes).toContain('archived-in-index')
  })

  it('accepts a generated index that lists every active page', () => {
    const pages = [
      page('a.md', 'see [b](b.md)', '2026-08-01T00:00:00.000Z'),
      page('b.md', 'see [a](a.md)', '2026-08-01T00:00:00.000Z'),
    ]
    const index = generateIndex(pages, NOW, ENGINE)
    expect(lintPages(pages, index)).toEqual([])
    expect(index).toMatch(/# Wiki index/)
    expect(indexListedPaths(index)).toEqual(new Set(['a.md', 'b.md']))
  })

  it('elides a truncated index and lists empty temperature groups', () => {
    const pages = [
      page('a.md', 'a', new Date(NOW).toISOString()),
      page('archive/z.md', 'z', '2020-01-01T00:00:00.000Z'),
    ]
    const tiny = generateIndex(pages, NOW, { ...ENGINE, indexMaxLines: 8 })
    expect(tiny).toMatch(/truncated/)
    const empty = generateIndex([], NOW, ENGINE)
    expect(empty).toMatch(/_None\._/)
  })
})

describe('log shards', () => {
  it('names the local day shard', () => {
    process.env.TZ = 'UTC'
    expect(localDateStamp(NOW)).toBe('29-08-26')
    expect(logPathOf(NOW)).toBe('log/29-08-26.jsonl')
  })
})
