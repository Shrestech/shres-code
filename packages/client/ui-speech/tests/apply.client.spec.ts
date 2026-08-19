/**
 * ui-speech browser half on a real SlotRegistry.
 */
// @vitest-environment jsdom
import { Context } from '@shres-code/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@shres-code/shres-code-client-runtime/client'
import { LocaleRuntime } from '@shres-code/shres-code-client-locale/client'
import { stubSettingsScope } from '@shres-code/shres-code-client-test-runtime'
import { apply, inject, projectSpeechStatus } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import { audioBufferToWav, bytesToBase64 } from '../src/client/pcm.ts'
import type { SpeechRemote } from '../src/client/remote.ts'
import type { MicButtonInjected } from '../src/client/MicButton.tsx'
import type { SpeakButtonInjected } from '../src/client/SpeakButton.tsx'
import type { SpeechSettingsInjected } from '../src/client/SpeechSettingsRows.tsx'
import type { SpeechUserSettings } from '@shres-code/shres-code-speech/settings'

function speechRemote(overrides: Partial<SpeechRemote> = {}): SpeechRemote {
  return {
    status: () => Promise.resolve({
      ok: true as const,
      value: {
        tts: { kind: 'ready' as const, providerId: 'kokoro-tts' },
        stt: { kind: 'ready' as const, providerId: 'whisper-tiny-en' },
        voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US' }],
      },
    }),
    synthesize: () => Promise.resolve({
      ok: false as const,
      error: { code: 'unavailable', message: 'unused', details: {} },
    }),
    transcribe: () => Promise.resolve({
      ok: false as const,
      error: { code: 'unavailable', message: 'unused', details: {} },
    }),
    ...overrides,
  }
}

async function bench(remote: SpeechRemote = speechRemote()) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'conversation.input.right': { kind: 'list', scope: 'session' },
      'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
      'settings.general.item': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  ctx.provide('remote', { speech: remote })
  ctx.provide('remote.speech', remote)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const host = stubSettingsScope<SpeechUserSettings>()
  ctx.provide('settingsScope', { bind: vi.fn(() => host.scope) })
  return { ctx, slots, host, remote }
}

function settingsInject(slots: SlotRegistry): SpeechSettingsInjected {
  const entry = slots.entries('settings.general.item').find(item => item.options.id === 'speech-voice')
  const injectFace = (entry as { inject?: () => SpeechSettingsInjected } | undefined)?.inject
  if (injectFace === undefined) throw new Error('missing speech-voice inject')
  return injectFace()
}

describe('ui-speech browser apply', () => {
  it('declares every service it binds', () => {
    expect(inject).toEqual(['slots', 'remote', 'remote.speech', 'locale', 'settingsScope'])
  })

  it('node-half apply is an intentional no-op', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('registers mic, speaker, and settings rows, then unregisters on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('conversation.input.right').map(entry => entry.options.id)).toEqual(['mic'])
    expect(b.slots.entries('conversation.chat.assistant-actions').map(entry => entry.options.id)).toEqual(['speak'])
    expect(b.slots.entries('settings.general.item').map(entry => entry.options.id)).toEqual([
      'speech-voice',
      'auto-submit-voice',
    ])
    await fiber.dispose()
    expect(b.slots.entries('conversation.input.right')).toHaveLength(0)
    expect(b.slots.entries('conversation.chat.assistant-actions')).toHaveLength(0)
    expect(b.slots.entries('settings.general.item')).toHaveLength(0)
  })

  it('publishes status() onto the settings inject store', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const face = settingsInject(b.slots)
    await vi.waitFor(() => {
      expect(face.hooks.speechStatus.getSnapshot()).toEqual({
        ttsReady: true,
        sttReady: true,
        voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US' }],
      })
    })
    await fiber.dispose()
  })

  it('keeps the initial snapshot when status() is a business failure', async () => {
    const remote = speechRemote({
      status: () => Promise.resolve({
        ok: false as const,
        error: { code: 'unavailable', message: 'down', details: {} },
      }),
    })
    const b = await bench(remote)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await Promise.resolve()
    expect(settingsInject(b.slots).hooks.speechStatus.getSnapshot().voices).toEqual([])
    await fiber.dispose()
  })

  it('keeps the initial snapshot when status() rejects', async () => {
    const remote = speechRemote({
      status: () => Promise.reject(new Error('transport')),
    })
    const b = await bench(remote)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await Promise.resolve()
    expect(settingsInject(b.slots).hooks.speechStatus.getSnapshot().ttsReady).toBe(false)
    await fiber.dispose()
  })

  it('writes settings fields through the bound scope', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    settingsInject(b.slots).setField('voiceId', 'am_michael')
    expect(b.host.set).toHaveBeenCalledWith('voiceId', 'am_michael')
    await fiber.dispose()
  })

  it('injects the shared remote and status store into mic and speaker', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const mic = (b.slots.entries('conversation.input.right')[0] as unknown as { inject: () => MicButtonInjected }).inject()
    const speak = (b.slots.entries('conversation.chat.assistant-actions')[0] as unknown as { inject: () => SpeakButtonInjected }).inject()
    expect(mic.speech).toBe(b.remote)
    expect(speak.speech).toBe(b.remote)
    expect(speak.playback.currentOwner()).toBeNull()
    await fiber.dispose()
  })
})

describe('projectSpeechStatus', () => {
  it('marks capabilities ready only on kind ready', () => {
    expect(projectSpeechStatus({
      tts: { kind: 'unavailable' },
      stt: { kind: 'ready' },
      voices: [],
    })).toEqual({ ttsReady: false, sttReady: true, voices: [] })
  })
})

describe('pcm helpers', () => {
  it('encodes an AudioBuffer to a WAV header', () => {
    const buffer = {
      numberOfChannels: 1,
      length: 4,
      sampleRate: 16_000,
      getChannelData: () => new Float32Array([0, 0.5, -0.5, 0]),
    } as unknown as AudioBuffer
    const wav = audioBufferToWav(buffer)
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(bytesToBase64(wav).length).toBeGreaterThan(0)
  })

  it('mixes stereo channels to mono', () => {
    const left = new Float32Array([1, 0])
    const right = new Float32Array([-1, 0])
    const buffer = {
      numberOfChannels: 2,
      length: 2,
      sampleRate: 8_000,
      getChannelData: (channel: number) => channel === 0 ? left : right,
    } as unknown as AudioBuffer
    const wav = audioBufferToWav(buffer)
    expect(wav.byteLength).toBe(44 + 4)
  })
})
