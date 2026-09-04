import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { CredentialProvider } from '@shres-code/shres-code-credentials'
import type { CredentialRef, ResolvedCredential } from '@shres-code/shres-code-credentials'
import { SettingsProvider } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import SpeechRuntime from '@shres-code/shres-code-speech'
import { SPEECH_SETTINGS_NAMESPACE } from '@shres-code/shres-code-speech'
import { Config, OPENAI_COMPATIBLE_DEFAULT_BASE_URL } from '../src/config.ts'
import { registerCloudProviders } from '../src/index.ts'
import * as plugin from '../src/index.ts'
import type { FetchFn } from '../src/provider.ts'

/** The smallest real settings provider: one in-memory document, always writable. */
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

/** An in-memory credential provider over the real seam. */
class MemoryCredentials extends CredentialProvider {
  values: Record<string, string> = {}

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values[ref]
    return Promise.resolve(value === undefined ? undefined : { value, source: 'test' })
  }

  describe(ref: CredentialRef) {
    const configured = this.values[ref] !== undefined
    return Promise.resolve({ configured, writable: true, ...(configured ? { source: 'test' } : {}) })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    this.values[ref] = value
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    this.values = Object.fromEntries(Object.entries(this.values).filter(([name]) => name !== ref))
    return Promise.resolve()
  }
}

const wav = new Uint8Array([1, 2, 3, 4])

/** A fake transport recording the calls it sees. */
function fetchReply(reply: () => Response): { fetchFn: FetchFn; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = []
  return {
    calls,
    fetchFn: ((url: string, init: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve(reply())
    }) as unknown as FetchFn,
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('speech-openai-compatible Config', () => {
  it('fills the OpenRouter-facing defaults', () => {
    expect(Config({})).toMatchObject({
      baseURL: OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
      sttMode: 'chat-audio',
      ttsMode: 'chat-audio',
      enabled: true,
    })
  })

  it('rejects an unknown wire mode at load', () => {
    expect(() => Config({ sttMode: 'smoke-signals' as never })).toThrow()
    expect(() => Config({ ttsMode: 'smoke-signals' as never })).toThrow()
  })
})

describe('speech-openai-compatible plugin', () => {
  it('registers both providers and resolves key and section per call', async () => {
    const ctx = new Context()
    await ctx.plugin(SpeechRuntime, { maxAudioBytes: 1024, maxTextChars: 64 })
    await ctx.plugin(MemorySettings)
    await ctx.plugin(MemoryCredentials)
    const { fetchFn, calls } = fetchReply(() => jsonResponse({ choices: [{ message: { content: ' hi ' } }] }))
    registerCloudProviders(ctx, {}, fetchFn)

    // No key, no pin: the single registered STT provider is auto-selected and
    // the request goes out unauthenticated to the composed base URL.
    await expect(ctx.speech.transcribe({ audio: wav, mediaType: 'audio/wav' })).resolves.toEqual({ text: 'hi' })
    expect(calls[0]?.url).toBe(`${OPENAI_COMPATIBLE_DEFAULT_BASE_URL}/chat/completions`)
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBeUndefined()

    // A stored key reaches the next operation without any restart.
    await ctx.credentials.set(plugin.Config({}).apiKeyEnv as never, 'k-9')
    // A section edit re-points the endpoint and pins the provider.
    await ctx.settings.update(SPEECH_SETTINGS_NAMESPACE, {
      sttProvider: 'openai-compatible-stt',
      cloud: { baseURL: 'https://gw.example/v1', sttModel: 'other-stt' },
    })
    await expect(ctx.speech.transcribe({ audio: wav, mediaType: 'audio/wav' })).resolves.toEqual({ text: 'hi' })
    expect(calls[1]?.url).toBe('https://gw.example/v1/chat/completions')
    const body = JSON.parse(typeof calls[1]?.init.body === 'string' ? calls[1].init.body : '{}') as { model: string }
    expect(body.model).toBe('other-stt')
    expect((calls[1]?.init.headers as Record<string, string>).authorization).toBe('Bearer k-9')
  })

  it('unregisters with the contributing fiber (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SpeechRuntime, { maxAudioBytes: 1024, maxTextChars: 64 })
    await ctx.plugin(MemorySettings)
    await ctx.plugin(MemoryCredentials)
    const fiber = await ctx.plugin({
      inject: plugin.inject,
      apply: plugin.apply,
    })
    expect((await ctx.speech.status()).tts).toEqual({ kind: 'ready', providerId: 'openai-compatible-tts' })
    await fiber.dispose()
    expect((await ctx.speech.status()).tts.kind).toBe('unavailable')
  })
})
