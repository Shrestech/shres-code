/**
 * Real-API e2e for the Brave provider. Self-skips without `BRAVE_API_KEY`.
 */
import { describe, expect, it } from 'vitest'
import { BraveSearchProvider, BRAVE_DEFAULT_BASE_URL, BRAVE_DEFAULT_COUNT } from '../src/index.ts'

describe('web-search-brave real API', () => {
  it('serves citable sources for one query', async () => {
    const key = process.env.BRAVE_API_KEY
    if (key === undefined) return
    const provider = new BraveSearchProvider(() => ({
      apiKey: key,
      baseURL: BRAVE_DEFAULT_BASE_URL,
      count: BRAVE_DEFAULT_COUNT,
    }))
    const result = await provider.search({ query: 'Anthropic Claude Fable 5', maxResults: 5 })
    expect(result.truncated).toBe(false)
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) {
      expect(source.url).toMatch(/^https?:\/\//)
    }
    expect(result.content).toBeUndefined()
  }, 60_000)
})
