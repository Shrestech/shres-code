/** The `web-search-perplexity` settings section layered over the composition entry. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import type { Fiber } from '@shres-code/cordis'
import { SettingsProvider } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import WebRuntime from '@shres-code/shres-code-web'
import * as perplexityPlugin from '@shres-code/shres-code-web-search-perplexity'
import { WEB_SEARCH_PERPLEXITY_SETTINGS_NAMESPACE } from '@shres-code/shres-code-web-search-perplexity'

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** The smallest chat-completions answer the provider accepts — enough to observe the request. */
const ONE_RESULT = {
  choices: [{ message: { content: 'ok' } }],
  citations: [],
}

async function boot(): Promise<{ ctx: Context; settingsFiber: Fiber; pluginFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, {})
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const pluginFiber = ctx.plugin(perplexityPlugin, { apiKey: 'pplx-key', baseURL: 'https://search.entry.test' })
  await pluginFiber.await()
  return { ctx, settingsFiber, pluginFiber }
}

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Run one search and answer the endpoint it reached. A fresh `Response` per
 * call because a body can only be read once, and the call history is cleared
 * because repeated `spyOn` returns the same spy.
 * @param ctx - context whose `ctx.web` serves the search.
 * @returns the URL the provider fetched.
 */
async function searchOnce(ctx: Context): Promise<string> {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(jsonResponse(ONE_RESULT)))
  fetchSpy.mockClear()
  await ctx.web.search({ query: 'anything' })
  return String((fetchSpy.mock.calls.at(-1)?.[0] as URL | string | undefined) ?? '')
}

describe('web-search-perplexity settings section', () => {
  it('serves a stored endpoint to the next search without re-registering the provider', async () => {
    const bench = await boot()
    expect(await searchOnce(bench.ctx)).toContain('https://search.entry.test')

    await bench.ctx.settings.update(WEB_SEARCH_PERPLEXITY_SETTINGS_NAMESPACE, {
      baseURL: 'https://search.stored.test',
    })

    expect(await searchOnce(bench.ctx)).toContain('https://search.stored.test')
    await bench.ctx.fiber.dispose()
  })

  it('keeps the literal key out of every described layer', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(WEB_SEARCH_PERPLEXITY_SETTINGS_NAMESPACE, { apiKey: 'pplx-stored-secret' })

    const [descriptor] = bench.ctx.settings.describe({ redactSecrets: true })
      .filter(row => String(row.ns) === 'web-search-perplexity')

    expect(JSON.stringify(descriptor)).not.toContain('pplx-stored-secret')
    expect(descriptor?.secrets).toEqual([{ path: ['apiKey'], set: true }])
    await bench.ctx.fiber.dispose()
  })

  it('falls back to the composition entry when the settings provider detaches', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(WEB_SEARCH_PERPLEXITY_SETTINGS_NAMESPACE, {
      baseURL: 'https://search.stored.test',
    })
    expect(await searchOnce(bench.ctx)).toContain('https://search.stored.test')

    await bench.settingsFiber.dispose()

    expect(await searchOnce(bench.ctx)).toContain('https://search.entry.test')
    await bench.ctx.fiber.dispose()
  })

  it('releases the namespace when the plugin unloads', async () => {
    const bench = await boot()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).toContain('web-search-perplexity')

    await bench.pluginFiber.dispose()

    expect(bench.ctx.settings.describe().map(row => String(row.ns))).not.toContain('web-search-perplexity')
    await bench.ctx.fiber.dispose()
  })

  it('drops out of the search pool while a stored section disables it', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(WEB_SEARCH_PERPLEXITY_SETTINGS_NAMESPACE, { enabled: false })

    await expect(bench.ctx.web.search({ query: 'anything' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))

    await bench.ctx.settings.update(WEB_SEARCH_PERPLEXITY_SETTINGS_NAMESPACE, { enabled: true })
    expect(await searchOnce(bench.ctx)).toContain('https://search.entry.test')
    await bench.ctx.fiber.dispose()
  })
})
