import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fetchFacts, readPins, renderReport } from './check-laya-upstream.ts'

const root = resolve(import.meta.dirname, '..')
const PINS = { layaMlx: '0.2.0', checkpoints: [{ repo: 'owner/model', revision: 'a'.repeat(40) }] }

describe('check-laya-upstream', () => {
  it('reads the gateway project pins in this repository', () => {
    const gateway = resolve(root, 'python/laya-gateway')
    const pins = readPins(
      readFileSync(resolve(gateway, 'pyproject.toml'), 'utf8'),
      readdirSync(resolve(gateway, 'manifests')).map(name => readFileSync(resolve(gateway, 'manifests', name), 'utf8')),
    )
    expect(pins.layaMlx).toBe('0.2.0')
    expect(pins.checkpoints).toContainEqual({ repo: 'convaiinnovations/laya-typed-decisions', revision: 'f9ab0b228f0fc0f14d873dbc99038f135c2da1b2' })
  })

  it('refuses a laya-mlx requirement without an exact pin', () => {
    expect(() => readPins('dependencies = ["laya-mlx>=0.2"]', [])).toThrow(/does not pin laya-mlx with ==/)
  })

  it('marks drift and reports unreachable upstreams without failing', async () => {
    const responses: Record<string, unknown> = {
      'https://pypi.org/pypi/laya-mlx/json': { info: { version: '0.3.0' } },
      'https://huggingface.co/api/models/owner/model': { sha: 'b'.repeat(40), lastModified: '2026-09-23T00:00:00Z' },
      'https://api.github.com/repos/mizorewww/laya-mlx/commits?per_page=1': [{ sha: 'c'.repeat(40), commit: { committer: { date: '2026-09-22T00:00:00Z' } } }],
    }
    const facts = await fetchFacts(PINS, (url) => {
      if (url in responses) return Promise.resolve(responses[url])
      if (url.includes('NandhaKishorM')) return Promise.resolve([])
      return Promise.reject(new Error(`HTTP 503 from ${url}`))
    })
    const report = renderReport(PINS, facts).join('\n')
    expect(report).toContain('laya-mlx (PyPI): pinned 0.2.0, latest 0.3.0  DRIFT')
    expect(report).toContain('owner/model (Hugging Face): pinned aaaaaaaaaaaa, head bbbbbbbbbbbb (2026-09-23)  DRIFT')
    expect(report).toContain('mizorewww/laya-mlx (GitHub): head cccccccccccc (2026-09-22)')
    expect(report).toContain('NandhaKishorM/laya (GitHub): head unknown (no commits returned)')
  })

  it('reports a pinned repository whose head could not be fetched', () => {
    const report = renderReport(PINS, { layaMlxLatest: '0.2.0', hubHeads: { 'owner/model': 'HTTP 404' }, sourceHeads: {} }).join('\n')
    expect(report).toContain('laya-mlx (PyPI): pinned 0.2.0, latest 0.2.0\n')
    expect(report).toContain('owner/model (Hugging Face): pinned aaaaaaaaaaaa, head unknown (HTTP 404)')
    expect(report).toContain('mizorewww/laya-mlx (GitHub): head unknown (not fetched)')
  })
})
