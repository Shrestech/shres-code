import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import WebRuntime from '@shres-code/shres-code-web'
import { credentialRef } from '@shres-code/shres-code-credentials'
import LocalCredentialProvider from '@shres-code/shres-code-credentials-local'
import {
  PerplexitySearchProvider,
  PERPLEXITY_PROVIDER_ID,
} from '@shres-code/shres-code-web-search-perplexity'
import type { PerplexitySearchProviderOptions } from '@shres-code/shres-code-web-search-perplexity'
import * as perplexityPlugin from '@shres-code/shres-code-web-search-perplexity'
import { mapPerplexityResponse } from '../src/provider.ts'

const options = { apiKey: 'pplx-key', baseURL: 'https://api.perplexity.test', model: 'sonar', maxTokens: 1024 }

/** The shared options with no key, as a search sees them before one is stored. */
const { apiKey: _droppedKey, ...keylessOptions } = options

/** The provider over a static options snapshot, as its thunk constructor expects. */
function searchProvider(value: PerplexitySearchProviderOptions): PerplexitySearchProvider {
  return new PerplexitySearchProvider(() => value)
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Perplexity response mapping', () => {
  it('maps the answer and prefers structured search_results', () => {
    const result = mapPerplexityResponse({
      choices: [{ message: { content: 'the answer' } }],
      search_results: [
        { url: 'https://a.test', title: 'A', snippet: 'snip', date: '2026-02-02' },
        { url: 'https://b.test' },
      ],
      citations: ['https://ignored.test'],
    })
    expect(result).toEqual({
      content: 'the answer',
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'snip', publishedAt: '2026-02-02' },
        { url: 'https://b.test' },
      ],
      truncated: false,
    })
  })

  it('falls back to URL-only citations when search_results is absent', () => {
    const result = mapPerplexityResponse({
      choices: [{ message: { content: 'answer' } }],
      citations: ['https://a.test', 'https://b.test'],
    })
    expect(result.sources).toEqual([{ url: 'https://a.test' }, { url: 'https://b.test' }])
  })

  it('omits content when the answer is empty or missing', () => {
    expect(mapPerplexityResponse({ citations: [] }).content).toBeUndefined()
    expect(mapPerplexityResponse({ choices: [{ message: { content: '' } }] }).content).toBeUndefined()
    expect(mapPerplexityResponse({ choices: [{ message: { content: null } }] }).content).toBeUndefined()
  })

  it('omits null/empty optional source fields', () => {
    const result = mapPerplexityResponse({
      search_results: [{ url: 'https://a.test', title: null, snippet: '', date: null }],
    })
    expect(result.sources).toEqual([{ url: 'https://a.test' }])
  })

  it('yields no sources when neither search_results nor citations are present', () => {
    expect(mapPerplexityResponse({ choices: [{ message: { content: 'a' } }] }).sources).toEqual([])
  })
})

describe('PerplexitySearchProvider availability', () => {
  it('is unavailable without a key', () => {
    expect(searchProvider({ ...options, apiKey: '' }).available()).toBe(false)
    expect(searchProvider(keylessOptions).available()).toBe(false)
  })

  it('is available with a key', () => {
    expect(searchProvider(options).available()).toBe(true)
  })

  it('is unavailable when disabled, however complete the rest', () => {
    expect(searchProvider({ ...options, enabled: false }).available()).toBe(false)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(searchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when maxTokens is not a positive integer', () => {
    expect(searchProvider({ ...options, maxTokens: 0 }).available()).toBe(false)
    expect(searchProvider({ ...options, maxTokens: 1.5 }).available()).toBe(false)
  })
})

describe('PerplexitySearchProvider request mapping', () => {
  it('sends a chat-completions request with the query, model and max_tokens', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider(options).search({ query: 'hello' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.perplexity.test/chat/completions')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer pplx-key')
    expect(JSON.parse(init.body as string)).toEqual({ model: 'sonar', max_tokens: 1024, messages: [{ role: 'user', content: 'hello' }] })
  })

  it('sends search_recency_filter when configured, and omits it otherwise', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ ...options, searchRecency: 'week' }).search({ query: 'q' })
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ search_recency_filter: 'week' })

    await searchProvider(options).search({ query: 'q' })
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).not.toHaveProperty('search_recency_filter')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ citations: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await searchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('PerplexitySearchProvider credential refresh', () => {
  it('serves the key the refresh resolves, so a stored key needs no restart', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] }))
    vi.stubGlobal('fetch', fetchMock)
    let current: PerplexitySearchProviderOptions = keylessOptions
    const provider = new PerplexitySearchProvider(() => current)
    expect(provider.available()).toBe(false)

    current = {
      ...current,
      refreshKey: () => {
        current = { ...current, apiKey: 'refreshed-key' }
        return Promise.resolve()
      },
    }
    await provider.search({ query: 'q' })

    expect(provider.available()).toBe(true)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer refreshed-key')
  })

  it('throws an actionable WEB_PROVIDER_CREDENTIAL_MISSING when no key exists', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    let caught: unknown
    try {
      await searchProvider(keylessOptions).search({ query: 'q' })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    if (!(caught instanceof Error)) throw new Error('search did not throw an Error')
    expect(caught.message).toMatch(/store it through the credentials service.*Settings page/s)
    expect(caught.message).toContain('PERPLEXITY_API_KEY')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a refresh rejection to WEB_PROVIDER_ERROR, never a missing key', async () => {
    await expect(searchProvider({
      ...keylessOptions,
      refreshKey: () => Promise.reject(new Error('credential backend failed')),
    }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: expect.stringContaining('credential resolution failed') as unknown as string,
      }))
  })

  it('maps a refresh rejection under an aborted signal to WEB_ABORTED', async () => {
    const controller = new AbortController()
    controller.abort(new Error('deadline'))
    await expect(searchProvider({
      ...options,
      refreshKey: () => Promise.reject(new Error('backend failed mid-abort')),
    }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an abort-shaped refresh rejection to WEB_ABORTED', async () => {
    await expect(searchProvider({
      ...options,
      refreshKey: () => Promise.reject(new DOMException('aborted', 'AbortError')),
    }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces a pre-aborted signal after the refresh without fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort(new Error('deadline'))
    await expect(searchProvider({
      ...options,
      refreshKey: () => Promise.resolve(),
    }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('PerplexitySearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'rate limited' } }, { status: 429 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'rate limited' }))
  })

  it('handles a string-form error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad request' }, { status: 400 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'bad request' }))
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ search_results: null }, { status: 200 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 503 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Perplexity API error (HTTP 503)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Perplexity API error (HTTP 500)' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('web-search-perplexity plugin registration', () => {
  it('applies directly with a raw config that bypasses the schema defaults', async () => {
    const prev = process.env.PERPLEXITY_API_KEY
    process.env.PERPLEXITY_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
      await perplexityPlugin.apply(ctx, {})
      await ctx.web.search({ query: 'q' })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.perplexity.ai/chat/completions')
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer env-key')
      expect(JSON.parse(init.body as string)).toMatchObject({ model: 'sonar', max_tokens: 1024 })
      // The raw config names no reference: the commit-event listener resolves
      // the provider default here.
      ctx.emit('credentials/updated', credentialRef('PERPLEXITY_API_KEY'))
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      await ctx.fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.PERPLEXITY_API_KEY
      else process.env.PERPLEXITY_API_KEY = prev
    }
  })

  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
    const fiber = await ctx.plugin(perplexityPlugin, { apiKey: 'pplx-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ content: 'a', sources: [] })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in perplexityPlugin).toBe(false)
  })

  it('threads maxTokens and searchRecency config into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
    const fiber = await ctx.plugin(perplexityPlugin, { apiKey: 'pplx-key', maxTokens: 256, searchRecency: 'month' })
    await ctx.web.search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ max_tokens: 256, search_recency_filter: 'month' })
    await fiber.dispose()
  })

  it('falls back to env key and defaults for base URL and model when config omits them', async () => {
    const prev = process.env.PERPLEXITY_API_KEY
    process.env.PERPLEXITY_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
      const fiber = await ctx.plugin(perplexityPlugin, {})
      await ctx.web.search({ query: 'q' })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.perplexity.ai/chat/completions')
      expect(JSON.parse(init.body as string)).toMatchObject({ model: 'sonar' })
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.PERPLEXITY_API_KEY
      else process.env.PERPLEXITY_API_KEY = prev
    }
  })

  it('is unavailable when neither config nor env supplies a key', async () => {
    const prev = process.env.PERPLEXITY_API_KEY
    delete process.env.PERPLEXITY_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
      await ctx.plugin(perplexityPlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
    } finally {
      if (prev !== undefined) process.env.PERPLEXITY_API_KEY = prev
    }
  })

  it('reports a failed refresh outside a search instead of dropping it', async () => {
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const calls = () => warn.mock.calls as unknown as unknown[][]
    const reports = () => calls().filter(call => String(call[0]).includes('resolving credential'))
    ctx.provide('credentials', {
      resolve: () => Promise.reject(new Error('credential backend down')),
    } as never)
    await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
    const fiber = await ctx.plugin(perplexityPlugin, {})
    // A backend failure is not a missing key: the provider stays keyless until a
    // later refresh succeeds, and it is reported. Each report names the reference
    // — never a value — and carries the cause on the line after it.
    await vi.waitFor(() => { expect(reports().length).toBeGreaterThan(0) })
    for (const [index, call] of calls().entries()) {
      if (!String(call[0]).includes('resolving credential')) continue
      expect(call[1]).toBe('PERPLEXITY_API_KEY')
      expect(String(calls()[index + 1]?.[0])).toContain('credential backend down')
    }
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
    // The commit-event refresh reports its failure the same way.
    const before = reports().length
    ctx.emit('credentials/updated', credentialRef('PERPLEXITY_API_KEY'))
    await vi.waitFor(() => { expect(reports().length).toBeGreaterThan(before) })
    await fiber.dispose()
  })

  it('reports a failed refresh when the credentials service activates late', async () => {
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
    // No seam at apply time, so the boot resolution reads the launch environment
    // and has nothing to report: only the activation-time refresh can fail here.
    const fiber = await ctx.plugin(perplexityPlugin, {})
    expect(warn).not.toHaveBeenCalled()
    ctx.provide('credentials', {
      resolve: () => Promise.reject(new Error('credential backend down')),
    } as never)
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('resolving credential'), 'PERPLEXITY_API_KEY')
    })
    await fiber.dispose()
  })

  it('activates when the credentials service registers after the plugin applied', async () => {
    const previous = process.env.PERPLEXITY_API_KEY
    delete process.env.PERPLEXITY_API_KEY
    const dir = await mkdtemp(join(tmpdir(), 'shres-web-search-perplexity-late-'))
    const filename = join(dir, '.credentials.yaml')
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      // The key is already on disk, but not through a seam this launch can read.
      await writeFile(filename, 'PERPLEXITY_API_KEY: late-key\n', { mode: 0o600 })
      await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
      // This plugin applies first: the launch environment is the only
      // credential source and a GUI launch leaves it without provider keys.
      await ctx.plugin(perplexityPlugin, {})
      await expect(ctx.web.search({ query: 'early' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))

      // The seam arrives after this plugin; the provider converges onto it
      // without a restart.
      await ctx.plugin(LocalCredentialProvider, { path: filename, watch: false })
      await vi.waitFor(async () => {
        await expect(ctx.web.search({ query: 'late' })).resolves.toMatchObject({ truncated: false })
      })
      const [, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer late-key')
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      if (previous === undefined) delete process.env.PERPLEXITY_API_KEY
      else process.env.PERPLEXITY_API_KEY = previous
    }
  })

  it('resolves from the launching environment when no credentials seam is composed', async () => {
    const previous = process.env.PERPLEXITY_API_KEY
    process.env.PERPLEXITY_API_KEY = 'env-key'
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
      const fiber = await ctx.plugin(perplexityPlugin, {})
      // No seam ever activates, so the boot resolution stands and nothing is
      // reported as a credential failure.
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      expect(warn).not.toHaveBeenCalled()
      await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer env-key')
      await fiber.dispose()
    } finally {
      if (previous === undefined) delete process.env.PERPLEXITY_API_KEY
      else process.env.PERPLEXITY_API_KEY = previous
    }
  })

  it('activates on a key stored after boot and picks up rotation per search', async () => {
    const previous = process.env.PERPLEXITY_API_KEY
    delete process.env.PERPLEXITY_API_KEY
    const dir = await mkdtemp(join(tmpdir(), 'shres-web-search-perplexity-'))
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(perplexityPlugin, {})

      // Keyless at boot: the pinned provider is out of the chain.
      await expect(ctx.web.search({ query: 'missing' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))

      // A write under another reference is not this provider's business.
      await ctx.credentials.set(credentialRef('OTHER_KEY'), 'other')
      await expect(ctx.web.search({ query: 'missing' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))

      // The Settings-page flow: the commit event refreshes availability without a restart.
      await ctx.credentials.set(credentialRef('PERPLEXITY_API_KEY'), 'stored-key')
      await vi.waitFor(async () => {
        await expect(ctx.web.search({ query: 'stored' })).resolves.toMatchObject({ truncated: false })
      })

      // Rotation is re-resolved at the next search even without waiting on the event.
      await ctx.credentials.set(credentialRef('PERPLEXITY_API_KEY'), 'rotated-key')
      fetchMock.mockClear()
      await ctx.web.search({ query: 'rotated' })
      const [, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer rotated-key')
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      if (previous === undefined) delete process.env.PERPLEXITY_API_KEY
      else process.env.PERPLEXITY_API_KEY = previous
    }
  })
})
