import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import { CredentialProvider } from '@shres-code/shres-code-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@shres-code/shres-code-credentials'
import { SettingsProvider } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import WebRuntime from '@shres-code/shres-code-web'
import * as attachedCliPlugin from '@shres-code/shres-code-web-search-attached-cli'
import { enabledBackends } from '@shres-code/shres-code-web-search-attached-cli'
import {
  ATTACHED_CLI_PROVIDER_ID,
  AttachedCliSearchProvider,
  BACKEND_DEFAULT_BASE_URL,
  backendUsable,
  buildRequest,
  isBackendId,
  mapVendorSearchPayload,
  selectBackend,
  type AttachedCliBackend,
  type AttachedCliBackendId,
  type AttachedCliSearchOptions,
} from '@shres-code/shres-code-web-search-attached-cli'

function backend(id: AttachedCliBackendId, apiKey?: string): AttachedCliBackend {
  return {
    id,
    ...apiKey !== undefined ? { apiKey } : {},
    hasResolver: false,
    baseURL: BACKEND_DEFAULT_BASE_URL[id],
  }
}

function options(partial: Partial<AttachedCliSearchOptions> & {
  grok?: string | undefined
  claude?: string | undefined
  codex?: string | undefined
  kimi?: string | undefined
  ollama?: string | undefined
}): AttachedCliSearchOptions {
  return {
    preference: partial.preference ?? ['grok-cli', 'claude-cli', 'codex-cli', 'kimi-cli', 'ollama-cloud'],
    ...partial.currentProvider !== undefined ? { currentProvider: partial.currentProvider } : {},
    backends: {
      'grok-cli': backend('grok-cli', partial.grok),
      'claude-cli': backend('claude-cli', partial.claude),
      'codex-cli': backend('codex-cli', partial.codex),
      'kimi-cli': backend('kimi-cli', partial.kimi),
      'ollama-cloud': backend('ollama-cloud', partial.ollama),
    },
    ...partial.fetch !== undefined ? { fetch: partial.fetch } : {},
    ...partial.refreshKeys !== undefined ? { refreshKeys: partial.refreshKeys } : {},
  }
}

describe('selectBackend', () => {
  it('prefers the current conversation CLI when that backend has a key', () => {
    expect(selectBackend(options({ currentProvider: 'kimi-cli', grok: 'g', kimi: 'k' }))).toBe('kimi-cli')
  })

  it('skips the current model when that backend has no key and no resolver', () => {
    expect(selectBackend(options({ currentProvider: 'kimi-cli', grok: 'g' }))).toBe('grok-cli')
  })

  it('keeps the current conversation CLI when it is attached without a cached key', () => {
    const backends = options({ grok: 'g' }).backends
    expect(selectBackend({
      preference: ['grok-cli', 'claude-cli', 'codex-cli', 'kimi-cli', 'ollama-cloud'],
      currentProvider: 'kimi-cli',
      backends: {
        ...backends,
        'kimi-cli': { ...backends['kimi-cli'], hasResolver: true },
      },
    })).toBe('kimi-cli')
  })

  it('walks preference when no current CLI model is usable', () => {
    expect(selectBackend(options({ claude: 'c', kimi: 'k' }))).toBe('claude-cli')
  })

  it('returns undefined when no backend has a key', () => {
    expect(selectBackend(options({}))).toBeUndefined()
  })

  it('prefers the current Ollama Cloud model when that backend has a key', () => {
    expect(selectBackend(options({
      currentProvider: 'ollama-cloud',
      grok: 'g',
      ollama: 'ollama-key',
    }))).toBe('ollama-cloud')
  })
})

describe('mapVendorSearchPayload', () => {
  it('collects Grok-style url citations and output text', () => {
    const result = mapVendorSearchPayload({
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'Grok found two docs.',
              annotations: [
                { type: 'url_citation', url: 'https://x.ai/docs', title: 'xAI docs' },
              ],
            },
          ],
        },
      ],
      citations: ['https://docs.x.ai/build'],
    })
    expect(result.content).toBe('Grok found two docs.')
    expect(result.sources.map(source => source.url)).toEqual([
      'https://x.ai/docs',
      'https://docs.x.ai/build',
    ])
    expect(result.sources[0]?.title).toBe('xAI docs')
  })

  it('deduplicates URLs and keeps the first title', () => {
    const result = mapVendorSearchPayload({
      sources: [
        { url: 'https://example.com', title: 'One' },
        { url: 'https://example.com', title: 'Two' },
      ],
    })
    expect(result.sources).toEqual([{ url: 'https://example.com', title: 'One' }])
  })

  it('maps Ollama Cloud title, url, and content onto a source snippet', () => {
    expect(mapVendorSearchPayload({
      results: [{ title: 'Ollama', url: 'https://ollama.com/', content: 'Cloud models' }],
    })).toEqual({
      sources: [{ title: 'Ollama', url: 'https://ollama.com/', snippet: 'Cloud models' }],
      truncated: false,
    })
  })

  it('keeps title and snippet from the first source object', () => {
    expect(mapVendorSearchPayload({
      url: 'https://only.example/doc',
      title: 'Only title',
      snippet: 'Only snippet',
    })).toEqual({
      sources: [{
        url: 'https://only.example/doc',
        title: 'Only title',
        snippet: 'Only snippet',
      }],
      truncated: false,
    })
  })

  it('keeps a first-seen title and later-only snippet', () => {
    const result = mapVendorSearchPayload({
      sources: [
        { url: 'https://example.com', title: 'First' },
        { url: 'https://example.com', snippet: 'Added later' },
      ],
    })
    expect(result.sources).toEqual([
      { url: 'https://example.com', title: 'First', snippet: 'Added later' },
    ])
  })

  it('fills missing title and snippet on a later duplicate and skips empty fields', () => {
    const result = mapVendorSearchPayload({
      sources: [
        { url: 'https://example.com', title: '', snippet: '' },
        { link: 'https://example.com', name: 'Named', description: 'Later snippet' },
        { uri: 'http://plain.example/page' },
        { role: 'assistant', content: '  assistant answer  ' },
        { output_text: 'top-level answer' },
        { type: 'output_text' },
        null,
        12,
        { url: 'not-a-url' },
      ],
    })
    expect(result.content).toBe('assistant answer')
    expect(result.sources).toEqual([
      { url: 'https://example.com', title: 'Named', snippet: 'Later snippet' },
      { url: 'http://plain.example/page' },
    ])
  })
})

describe('buildRequest', () => {
  it('targets the xAI responses web_search tool for grok-cli', () => {
    const request = buildRequest('grok-cli', 'https://api.x.ai/v1', 'xai-key', 'latest grok')
    expect(request.url).toBe('https://api.x.ai/v1/responses')
    expect(request.body).toMatchObject({
      model: 'grok-4.6',
      tools: [{ type: 'web_search' }],
    })
  })

  it('targets Anthropic messages web_search for claude-cli', () => {
    const request = buildRequest('claude-cli', 'https://api.anthropic.com/v1', 'ant-key', 'q')
    expect(request.url).toBe('https://api.anthropic.com/v1/messages')
    expect(request.body).toMatchObject({
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    })
  })

  it('targets OpenAI responses web_search for codex-cli', () => {
    const request = buildRequest('codex-cli', 'https://api.openai.com/v1', 'oa-key', 'q')
    expect(request.url).toBe('https://api.openai.com/v1/responses')
    expect(request.body).toMatchObject({ tools: [{ type: 'web_search' }] })
  })

  it('targets Moonshot builtin $web_search for kimi-cli', () => {
    const request = buildRequest('kimi-cli', 'https://api.moonshot.ai/v1', 'ms-key', 'q')
    expect(request.url).toBe('https://api.moonshot.ai/v1/chat/completions')
    expect(request.body).toMatchObject({
      tools: [{ type: 'builtin_function', function: { name: '$web_search' } }],
    })
  })

  it('targets Ollama Cloud /api/web_search for ollama-cloud', () => {
    const request = buildRequest('ollama-cloud', 'https://ollama.com', 'ollama-key', 'cloudflare tunnel')
    expect(request.url).toBe('https://ollama.com/api/web_search')
    expect(request.body).toEqual({ query: 'cloudflare tunnel' })
    expect(request.headers.authorization).toBe('Bearer ollama-key')
  })

  it('strips a trailing slash from the vendor base', () => {
    expect(buildRequest('grok-cli', 'https://api.x.ai/v1/', 'k', 'q').url)
      .toBe('https://api.x.ai/v1/responses')
  })

  it('rejects an unknown backend id', () => {
    expect(() => buildRequest('nope' as AttachedCliBackendId, 'https://example.com', 'k', 'q'))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('enabledBackends', () => {
  it('defaults every vendor on and drops a vendor the user turns off', () => {
    expect(enabledBackends({})).toEqual([
      'grok-cli', 'claude-cli', 'codex-cli', 'kimi-cli', 'ollama-cloud',
    ])
    expect(enabledBackends({ grok: false, claude: true, codex: false, kimi: false, ollama: false }))
      .toEqual(['claude-cli'])
    expect(enabledBackends({
      grok: false, claude: false, codex: false, kimi: false, ollama: false,
    })).toEqual([])
  })
})

describe('backendUsable and isBackendId', () => {
  it('treats an empty key as unusable unless a resolver is wired', () => {
    expect(backendUsable(backend('grok-cli', ''))).toBe(false)
    expect(backendUsable({ ...backend('grok-cli'), hasResolver: true })).toBe(true)
    expect(isBackendId('grok-cli')).toBe(true)
    expect(isBackendId('ollama-cloud')).toBe(true)
    expect(isBackendId('deepseek-official')).toBe(false)
  })
})

describe('AttachedCliSearchProvider', () => {
  it('is unavailable without credentials', () => {
    const provider = new AttachedCliSearchProvider(() => options({}))
    expect(provider.available()).toBe(false)
  })

  it('posts to the selected vendor and maps the body', async () => {
    const seen: { url: string; body: unknown }[] = []
    const provider = new AttachedCliSearchProvider(() => options({
      grok: 'xai-key',
      fetch: async (input, init) => {
        const href = input instanceof Request ? input.url : input instanceof URL ? input.href : input
        const raw = init?.body
        seen.push({
          url: href,
          body: JSON.parse(typeof raw === 'string' ? raw : '{}'),
        })
        return new Response(JSON.stringify({
          citations: ['https://x.ai/news'],
          output: [{ type: 'output_text', text: 'ok' }],
        }), { status: 200 })
      },
    }))
    expect(provider.available()).toBe(true)
    const result = await provider.search({ query: 'grok build' })
    expect(seen[0]?.url).toBe('https://api.x.ai/v1/responses')
    expect(result.sources).toEqual([{ url: 'https://x.ai/news' }])
    expect(result.content).toBe('ok')
  })

  it('registers on ctx.web as attached-cli', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime)
    const provider = new AttachedCliSearchProvider(() => options({
      claude: 'ant-key',
      fetch: async () => new Response(JSON.stringify({
        content: [{ type: 'web_search_tool_result', url: 'https://docs.anthropic.com', title: 'Docs' }],
      }), { status: 200 }),
    }))
    ctx.web.registerSearchProvider(provider)
    const result = await ctx.web.search({ query: 'claude tools' })
    expect(provider.id).toBe(ATTACHED_CLI_PROVIDER_ID)
    expect(result.sources[0]?.url).toBe('https://docs.anthropic.com')
  })

  it('uses the key refreshKeys just stored, not the empty pre-refresh snapshot', async () => {
    let ollama: string | undefined
    const seen: string[] = []
    const provider = new AttachedCliSearchProvider(() => options({
      currentProvider: 'ollama-cloud',
      ollama,
      refreshKeys: async () => {
        ollama = 'ollama-from-credentials'
      },
      fetch: async (input) => {
        const href = input instanceof Request ? input.url : input instanceof URL ? input.href : input
        seen.push(href)
        return new Response(JSON.stringify({
          results: [{ title: 'BTC', url: 'https://example.com/btc', content: 'price' }],
        }), { status: 200 })
      },
    }))
    await expect(provider.search({ query: 'bitcoin' })).resolves.toMatchObject({
      sources: [{ title: 'BTC', url: 'https://example.com/btc', snippet: 'price' }],
    })
    expect(seen).toEqual(['https://ollama.com/api/web_search'])
  })

  it('throws WEB_PROVIDER_UNAVAILABLE after refresh leaves no backend', async () => {
    let grok: string | undefined = 'xai-key'
    const provider = new AttachedCliSearchProvider(() => options({
      grok,
      refreshKeys: async () => {
        grok = undefined
      },
    }))
    await expect(provider.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))
  })

  it('throws WEB_PROVIDER_CREDENTIAL_MISSING when the attached CLI has no key', async () => {
    const backends = options({}).backends
    const provider = new AttachedCliSearchProvider(() => ({
      preference: ['kimi-cli'],
      currentProvider: 'kimi-cli',
      backends: {
        ...backends,
        'kimi-cli': { ...backends['kimi-cli'], hasResolver: true },
      },
    }))
    await expect(provider.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
  })

  it('maps an aborted fetch to WEB_ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    const provider = new AttachedCliSearchProvider(() => options({
      grok: 'xai-key',
      fetch: async () => {
        throw new Error('aborted')
      },
    }))
    await expect(provider.search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a transport failure to WEB_PROVIDER_ERROR', async () => {
    const provider = new AttachedCliSearchProvider(() => options({
      grok: 'xai-key',
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      },
    }))
    await expect(provider.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a non-2xx response to WEB_PROVIDER_ERROR', async () => {
    const provider = new AttachedCliSearchProvider(() => options({
      grok: 'xai-key',
      fetch: async () => new Response('nope', { status: 503 }),
    }))
    await expect(provider.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an unprocessable body to WEB_PROVIDER_ERROR', async () => {
    const provider = new AttachedCliSearchProvider(() => options({
      grok: 'xai-key',
      fetch: async () => new Response('not-json', { status: 200 }),
    }))
    await expect(provider.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

class MemoryCredentials extends CredentialProvider {
  constructor(ctx: Context, private readonly values: Record<string, string>) {
    super(ctx)
  }

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values[ref]
    return Promise.resolve(value !== undefined && value.length > 0 ? { value, source: 'test' } : undefined)
  }

  describe(): Promise<CredentialInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  set(): Promise<void> {
    return Promise.resolve()
  }

  unset(): Promise<void> {
    return Promise.resolve()
  }
}

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

describe('web-search-attached-cli plugin registration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('registers attached-cli and searches through the env-backed vendor', async () => {
    const previous = process.env.XAI_API_KEY
    process.env.XAI_API_KEY = 'xai-key'
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const href = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      expect(href).toBe('https://api.x.ai/v1/responses')
      return new Response(JSON.stringify({ citations: ['https://x.ai/docs'] }), { status: 200 })
    }))
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProviders: ['attached-cli', 'deepseek-official'] })
      const fiber = await ctx.plugin(attachedCliPlugin, {})
      await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({
        sources: [{ url: 'https://x.ai/docs' }],
      })
      await fiber.dispose()
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))
    } finally {
      if (previous === undefined) delete process.env.XAI_API_KEY
      else process.env.XAI_API_KEY = previous
    }
  })

  it('resolves a stored credential when the launch environment has no key', async () => {
    const previous = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const href = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      expect(href).toBe('https://api.anthropic.com/v1/messages')
      return new Response(JSON.stringify({
        content: [{ type: 'web_search_tool_result', url: 'https://docs.anthropic.com' }],
      }), { status: 200 })
    }))
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime)
      await ctx.plugin(class extends MemoryCredentials {
        constructor(inner: Context) {
          super(inner, { ANTHROPIC_API_KEY: 'ant-stored' })
        }
      })
      await ctx.plugin(attachedCliPlugin, {})
      await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({
        sources: [{ url: 'https://docs.anthropic.com' }],
      })
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previous
    }
  })

  it('drops a cached key when credentials resolve empty and no env is set', async () => {
    const previous = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    const ctx = new Context()
    await ctx.plugin(WebRuntime)
    await ctx.plugin(class extends MemoryCredentials {
      constructor(inner: Context) {
        super(inner, { OPENAI_API_KEY: '' })
      }
    })
    await ctx.plugin(attachedCliPlugin, {
      grok: false, claude: false, codex: true, kimi: false, ollama: false,
    })
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))
    if (previous === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previous
  })

  it('treats the current conversation CLI as attached before the cache fills', async () => {
    const previous = process.env.MOONSHOT_API_KEY
    delete process.env.MOONSHOT_API_KEY
    const ctx = new Context()
    await ctx.plugin(WebRuntime)
    await ctx.plugin(class extends Service {
      constructor(inner: Context) {
        super(inner, 'agentDefaultModel')
      }

      currentSelection(): { provider: string; model: string } {
        return { provider: 'kimi-cli', model: 'k2' }
      }
    })
    await ctx.plugin(attachedCliPlugin, {})
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
    if (previous === undefined) delete process.env.MOONSHOT_API_KEY
    else process.env.MOONSHOT_API_KEY = previous
  })

  it('projects a settings write onto the next search preference', async () => {
    const previous = process.env.XAI_API_KEY
    process.env.XAI_API_KEY = 'xai-key'
    process.env.MOONSHOT_API_KEY = 'ms-key'
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const href = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      seen.push(href)
      return new Response(JSON.stringify({ citations: ['https://example.com'] }), { status: 200 })
    }))
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime)
      await ctx.plugin(MemorySettings)
      await ctx.plugin(attachedCliPlugin, {})
      await ctx.settings.update(attachedCliPlugin.WEB_SEARCH_ATTACHED_CLI_SETTINGS_NAMESPACE, {
        grok: false, claude: false, codex: false, kimi: true, ollama: false,
      })
      await ctx.web.search({ query: 'q' })
      expect(seen.at(-1)).toBe('https://api.moonshot.ai/v1/chat/completions')
    } finally {
      if (previous === undefined) delete process.env.XAI_API_KEY
      else process.env.XAI_API_KEY = previous
      delete process.env.MOONSHOT_API_KEY
    }
  })

  it('searches Ollama Cloud with the stored OLLAMA_API_KEY', async () => {
    const previous = process.env.OLLAMA_API_KEY
    delete process.env.OLLAMA_API_KEY
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const href = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      expect(href).toBe('https://ollama.com/api/web_search')
      return new Response(JSON.stringify({
        results: [{ title: 'Ollama', url: 'https://ollama.com/', content: 'Cloud models' }],
      }), { status: 200 })
    }))
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProviders: ['attached-cli', 'deepseek-official'] })
      await ctx.plugin(class extends MemoryCredentials {
        constructor(inner: Context) {
          super(inner, { OLLAMA_API_KEY: 'ollama-stored' })
        }
      })
      await ctx.plugin(class extends Service {
        constructor(inner: Context) {
          super(inner, 'agentDefaultModel')
        }

        currentSelection(): { provider: string; model: string } {
          return { provider: 'ollama-cloud', model: 'deepseek-v4-flash:cloud' }
        }
      })
      await ctx.plugin(attachedCliPlugin, {})
      await expect(ctx.web.search({ query: 'Cloudflare Tunnel GitOps' })).resolves.toMatchObject({
        sources: [{ title: 'Ollama', url: 'https://ollama.com/', snippet: 'Cloud models' }],
      })
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_API_KEY
      else process.env.OLLAMA_API_KEY = previous
    }
  })

  it('stays unavailable when neither env nor credentials can supply a key', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime)
    await ctx.plugin(attachedCliPlugin, {})
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in attachedCliPlugin).toBe(false)
  })

  it('applies with an omitted preference and uses the shipped order', async () => {
    const previous = process.env.XAI_API_KEY
    process.env.XAI_API_KEY = 'xai-key'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      citations: ['https://x.ai/docs'],
    }), { status: 200 })))
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime)
      await attachedCliPlugin.apply(ctx, {})
      await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({
        sources: [{ url: 'https://x.ai/docs' }],
      })
    } finally {
      if (previous === undefined) delete process.env.XAI_API_KEY
      else process.env.XAI_API_KEY = previous
    }
  })
})
