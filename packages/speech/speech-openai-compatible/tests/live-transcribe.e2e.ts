// REAL-API e2e, self-skipping: exercises the shipped cloud speech path —
// local Kokoro-free audio in, OpenRouter's `microsoft/mai-transcribe-2` out —
// through the composed SpeechRuntime, the speech settings section, and the
// real credential store. Skips unless the default `OPENROUTER_API_KEY`
// credential resolves (CI has no such key) and speech synthesis (`say`) is
// available, so it never runs somewhere it cannot. The key value is never
// logged.
// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@shres-code/cordis'
import { LocalCredentialProvider, CREDENTIALS_FILENAME } from '@shres-code/shres-code-credentials-local'
import { defaultShresHome } from '@shres-code/shres-code-home-paths'
import { SettingsProvider } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import SpeechRuntime, { SPEECH_SETTINGS_NAMESPACE } from '@shres-code/shres-code-speech'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import type { Config } from '../src/config.ts'

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

/** Whether the default credential document holds a non-empty OPENROUTER_API_KEY. */
async function storedOpenRouterKey(): Promise<string | undefined> {
  if (process.env.OPENROUTER_API_KEY !== undefined && process.env.OPENROUTER_API_KEY.length > 0) {
    return process.env.OPENROUTER_API_KEY
  }
  try {
    const document = await readFile(join(defaultShresHome(), CREDENTIALS_FILENAME), 'utf8')
    const line = document.split('\n').find(row => row.startsWith('OPENROUTER_API_KEY:'))
    const value = line?.slice('OPENROUTER_API_KEY:'.length).trim()
    return value !== undefined && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** Speak `text` through macOS `say` and return mono 16 kHz PCM16 WAV bytes. */
async function spokenWav(text: string): Promise<Uint8Array> {
  const dir = tmpdir()
  const aiff = join(dir, `shres-live-${String(process.pid)}.aiff`)
  const wav = join(dir, `shres-live-${String(process.pid)}.wav`)
  execFileSync('say', ['-o', aiff, text])
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav])
  void rm(aiff).catch(() => {})
  const bytes = new Uint8Array(await readFile(wav))
  void rm(wav).catch(() => {})
  return bytes
}

describe('live cloud speech through OpenRouter (real API, self-skipping)', () => {
  it('transcribes spoken audio with microsoft/mai-transcribe-2', async () => {
    const key = await storedOpenRouterKey()
    if (key === undefined || process.platform !== 'darwin') {
      console.log('skipping: no OPENROUTER_API_KEY credential or not on macOS')
      return
    }
    const spoken = 'Shres Code transcribes audio through the cloud.'
    const ctx = new Context()
    await ctx.plugin(SpeechRuntime, { maxAudioBytes: 10 * 1024 * 1024, maxTextChars: 15_000 })
    await ctx.plugin(MemorySettings)
    await ctx.plugin(LocalCredentialProvider, { watch: false })
    const config: Config = { sttModel: 'microsoft/mai-transcribe-2' }
    await ctx.plugin({ inject: plugin.inject, apply: plugin.apply }, config)

    // Pin cloud STT in the speech section, exactly as the Models page does.
    await ctx.settings.update(SPEECH_SETTINGS_NAMESPACE, { sttProvider: 'openai-compatible-stt' })
    expect(await ctx.speech.status()).toMatchObject({
      stt: { kind: 'ready', providerId: 'openai-compatible-stt' },
    })

    const wav = await spokenWav(spoken)
    const round = await ctx.speech.transcribeRemote({
      audioBase64: Buffer.from(wav).toString('base64'),
      mediaType: 'audio/wav',
    })
    if (!round.ok) {
      throw new Error(`live transcription failed: ${round.error.code} — ${round.error.message}`)
    }
    expect(round.ok).toBe(true)
    const transcript = round.value.text
    expect(transcript.toLowerCase()).toContain('shres')
    expect(transcript.toLowerCase()).toContain('transcribe')
  }, 120_000)
})
