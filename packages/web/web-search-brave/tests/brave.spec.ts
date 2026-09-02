/**
 * Brave provider behavior: result mapping, the wire request shape, the error
 * and cancellation taxonomy, credential resolution through the seam, and the
 * plugin's registration into `ctx.web`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import WebRuntime from '@shres-code/shres-code-web'
import LocalCredentialProvider from '@shres-code/shres-code-credentials-local'
import { credentialRef } from '@shres-code/shres-code-credentials'
import {
  BRAVE_PROVIDER_ID,
  BraveSearchProvider,
  mapBraveResponse,
} from '@shres-code/shres-code-web-search-brave'
import * as bravePlugin from '@shres-code/shres-code-web-search-brave'
import type { BraveSearchProviderOptions } from '@shres-code/shres-code-web-search-brave'

const options: BraveSearchProviderOptions = {
  apiKey: 'brave-key',
  baseURL: 'https://api.search.brave.test/res/v1',
  count: 8,
}

/** The shared options with no key, as a search sees them before one is stored. */
const { apiKey: _droppedKey, ...keylessOptions } = options

/** The provider over a static options snapshot, as its thunk constructor expects. */
function searchProvider(value: BraveSearchProviderOptions): BraveSearchProvider {
  return new BraveSearchProvider(() => value)
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Brave response mapping', () => {
  it('maps result rows to sources, dropping a row without a URL', () => {
    const result = mapBraveResponse({
      web: {
        results: [
          { url: 'https://a.test', title: 'A', description: 'snip', page_age: '2026-08-30' },
          { url: 'https://b.test', age: '2 hours ago' },
          { title: 'no url row' },
        ],
      },
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'snip', publishedAt: '2026-08-30' },
        { url: 'https://b.test', publishedAt: '2 hours ago' },
      ],
      truncated: false,
    })
  })

  it('serves an empty result set as zero sources, not an error', () => {
    expect(mapBraveResponse({ web: { results: [] } })).toEqual({ sources: [], truncated: false })
  })
})

describe('BraveSearchProvider', () => {
  it('requests the web search operation with the subscription token header', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      web: { results: [{ url: 'https://a.test', title: 'A', description: 'snip' }] },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await searchProvider(options).search({ query: 'node lts' })
    expect(result.sources).toEqual([{ url: 'https://a.test', title: 'A', snippet: 'snip' }])
    expect(result.content).toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(url)).toBe('https://api.search.brave.test/res/v1/web/search?q=node+lts&count=8')
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>)['x-subscription-token']).toBe('brave-key')
  })

  it('reports its own id and availability from key, endpoint, and count', () => {
    const provider = searchProvider(options)
    expect(provider.id).toBe(BRAVE_PROVIDER_ID)
    expect(provider.available()).toBe(true)
    expect(searchProvider(keylessOptions).available()).toBe(false)
    expect(searchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
    expect(searchProvider({ ...options, count: 0 }).available()).toBe(false)
    expect(searchProvider({ ...options, enabled: false }).available()).toBe(false)
  })

  it('fails loud with the credential code naming the reference when no key resolves', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(searchProvider(keylessOptions).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING', message: /BRAVE_API_KEY/ })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a non-2xx status, preferring the body message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'quota exceeded' }, { status: 429 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'quota exceeded' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway', { status: 502 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: /HTTP 502/ })
  })

  it('rejects a 200 body without a web results array and a non-JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: /unprocessable/ })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: /unprocessable/ })
  })

  it('maps an abort-shaped transport failure to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })
})

describe('web-search-brave plugin', () => {
  it('registers into ctx.web and resolves the key through the credentials seam', async () => {
    const home = await mkdtemp(join(tmpdir(), 'brave-provider-'))
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, {})
      await ctx.plugin(LocalCredentialProvider, { shresHome: home, watch: false })
      await ctx.plugin(bravePlugin, {})
      const credentials = ctx.credentials
      await credentials.set(credentialRef('BRAVE_API_KEY'), 'seam-key')
      // The commit event refreshes the provider's cache; the search itself
      // also refreshes, so either path activates the stored key.
      const fetchMock = vi.fn(async () => jsonResponse({
        web: { results: [{ url: 'https://seam.test', title: 'Seam' }] },
      }))
      vi.stubGlobal('fetch', fetchMock)
      const result = await ctx.web.search({ query: 'through the seam', provider: 'brave', maxResults: 5 })
      expect(result.sources).toEqual([{ url: 'https://seam.test', title: 'Seam' }])
      const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
      expect(String(url)).toBe('https://api.search.brave.com/res/v1/web/search?q=through+the+seam&count=8')
      expect((init.headers as Record<string, string>)['x-subscription-token']).toBe('seam-key')
      await ctx.fiber.dispose()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
