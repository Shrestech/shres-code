/** The `web-search-brave` settings section layered over the composition entry. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import type { Fiber } from '@shres-code/cordis'
import LocalCredentialProvider from '@shres-code/shres-code-credentials-local'
import { SettingsProvider } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import WebRuntime from '@shres-code/shres-code-web'
import * as bravePlugin from '@shres-code/shres-code-web-search-brave'
import {
  BRAVE_PROVIDER_ID,
  WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE,
} from '@shres-code/shres-code-web-search-brave'

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

/** The smallest result envelope the provider accepts — enough to observe the request. */
const ONE_RESULT = {
  web: { results: [{ url: 'https://result.test', title: 'Result' }] },
}

async function boot(): Promise<{ ctx: Context; settingsFiber: Fiber; pluginFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, {})
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const pluginFiber = ctx.plugin(bravePlugin, { apiKey: 'brave-key', baseURL: 'https://search.entry.test' })
  await pluginFiber.await()
  return { ctx, settingsFiber, pluginFiber }
}

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Run one search and answer the endpoint it reached, with the headers it sent.
 * A fresh `Response` per call because a body can only be read once, and the
 * call history is cleared because repeated `spyOn` returns the same spy.
 * @param ctx - context whose `ctx.web` serves the search.
 * @returns the URL the provider fetched and the headers it sent.
 */
async function searchRequest(ctx: Context): Promise<{ url: string; headers: Record<string, string> }> {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(jsonResponse(ONE_RESULT)))
  fetchSpy.mockClear()
  await ctx.web.search({ query: 'anything' })
  const call = fetchSpy.mock.calls.at(-1)
  return {
    url: String((call?.[0] as URL | string | undefined) ?? ''),
    headers: (call?.[1]?.headers ?? {}) as Record<string, string>,
  }
}

/**
 * The URL one search reached.
 * @param ctx - context whose `ctx.web` serves the search.
 * @returns the fetched URL.
 */
async function searchOnce(ctx: Context): Promise<string> {
  return (await searchRequest(ctx)).url
}

describe('web-search-brave settings section', () => {
  it('serves a stored endpoint to the next search without re-registering the provider', async () => {
    const bench = await boot()
    expect(await searchOnce(bench.ctx)).toContain('https://search.entry.test')

    await bench.ctx.settings.update(WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE, {
      baseURL: 'https://search.stored.test',
    })

    expect(await searchOnce(bench.ctx)).toContain('https://search.stored.test')
    await bench.ctx.fiber.dispose()
  })

  it('keeps the literal key out of every described layer', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE, { apiKey: 'brave-stored-secret' })

    const [descriptor] = bench.ctx.settings.describe({ redactSecrets: true })
      .filter(row => String(row.ns) === 'web-search-brave')

    expect(JSON.stringify(descriptor)).not.toContain('brave-stored-secret')
    expect(descriptor?.secrets).toEqual([{ path: ['apiKey'], set: true }])
    await bench.ctx.fiber.dispose()
  })

  it('falls back to the composition entry when the settings provider detaches', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE, {
      baseURL: 'https://search.stored.test',
    })
    expect(await searchOnce(bench.ctx)).toContain('https://search.stored.test')

    await bench.settingsFiber.dispose()

    expect(await searchOnce(bench.ctx)).toContain('https://search.entry.test')
    await bench.ctx.fiber.dispose()
  })

  it('releases the namespace when the plugin unloads', async () => {
    const bench = await boot()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).toContain('web-search-brave')

    await bench.pluginFiber.dispose()

    expect(bench.ctx.settings.describe().map(row => String(row.ns))).not.toContain('web-search-brave')
    await bench.ctx.fiber.dispose()
  })

  it('re-resolves the credential when a committed change renames the reference', async () => {
    const previous = process.env.BRAVE_API_KEY
    delete process.env.BRAVE_API_KEY
    const dir = await mkdtemp(join(tmpdir(), 'shres-web-search-brave-refs-'))
    const filename = join(dir, '.credentials.yaml')
    const ctx = new Context()
    try {
      await writeFile(filename, 'BRAVE_API_KEY: first-key\nALT_BRAVE_KEY: second-key\n', { mode: 0o600 })
      await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
      await ctx.plugin(LocalCredentialProvider, { path: filename, watch: false })
      const settingsFiber = ctx.plugin(MemorySettings)
      await settingsFiber.await()
      const pluginFiber = ctx.plugin(bravePlugin, {})
      await pluginFiber.await()
      expect((await searchRequest(ctx)).headers['x-subscription-token']).toBe('first-key')

      // The Settings page re-points the credential reference. `ctx.web` refuses
      // a pinned provider before a search could refresh, so the committed change
      // itself has to resolve the new reference.
      await ctx.settings.update(WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE, { apiKeyEnv: 'ALT_BRAVE_KEY' })
      await vi.waitFor(async () => {
        expect((await searchRequest(ctx)).headers['x-subscription-token']).toBe('second-key')
      })
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      if (previous === undefined) delete process.env.BRAVE_API_KEY
      else process.env.BRAVE_API_KEY = previous
    }
  })

  it('drops out of the search pool while a stored section disables it', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE, { enabled: false })

    await expect(bench.ctx.web.search({ query: 'anything' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))

    await bench.ctx.settings.update(WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE, { enabled: true })
    expect(await searchOnce(bench.ctx)).toContain('https://search.entry.test')
    await bench.ctx.fiber.dispose()
  })
})
