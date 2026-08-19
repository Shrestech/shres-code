/**
 * Mic, speaker, playback, and settings-row gestures.
 */
// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate, stubSettingsScope } from '@shres-code/shres-code-client-test-runtime'
import { createSnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import {
  DEFAULT_SPEECH_USER_SETTINGS,
  type SpeechUserSettings,
} from '@shres-code/shres-code-speech/settings'
import { MicButton } from '../src/client/MicButton.tsx'
import { SpeakButton, decodeBase64 } from '../src/client/SpeakButton.tsx'
import { AutoSubmitRow, VoiceRow } from '../src/client/SpeechSettingsRows.tsx'
import { createSpeechPlayback } from '../src/client/playback.ts'
import { INITIAL_SPEECH_CLIENT_STATUS } from '../src/client/status.ts'
import type { SpeechClientStatus } from '../src/client/status.ts'
import type { SpeechRemote } from '../src/client/remote.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(en)

function hookOf<T>(source: { getSnapshot(): T; subscribe(fn: () => void): () => void }) {
  return <S,>(select: (value: T) => S): S =>
    useSyncExternalStore(source.subscribe, () => select(source.getSnapshot()))
}

function audioResult(base64 = btoa('wav')) {
  return {
    ok: true as const,
    value: {
      ok: true as const,
      value: { kind: 'audio' as const, audioBase64: base64, mediaType: 'audio/wav' as const, voiceId: 'af_heart' },
    },
  }
}

describe('decodeBase64', () => {
  it('round-trips ASCII bytes', () => {
    expect([...decodeBase64(btoa('Hi'))]).toEqual([72, 105])
  })
})

describe('createSpeechPlayback', () => {
  it('clears the owner on natural end, takeover, and play rejection', async () => {
    const ended: Array<(() => void) | null> = []
    const plays: Array<() => Promise<void>> = []
    const created: FakeAudio[] = []
    class FakeAudio {
      src = ''
      onended: (() => void) | null = null
      onerror: (() => void) | null = null
      pause = vi.fn()
      removeAttribute = vi.fn()
      play = vi.fn(() => {
        ended.push(this.onended)
        const play = plays.shift() ?? (() => Promise.resolve())
        return play()
      })
      constructor() { created.push(this) }
    }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:speech',
      revokeObjectURL: vi.fn(),
    })
    const playback = createSpeechPlayback()
    const owners: Array<symbol | null> = []
    playback.subscribe((owner) => { owners.push(owner) })
    const a = Symbol('a')
    const b = Symbol('b')
    await playback.play(a, new Uint8Array([1]), 'audio/wav')
    expect(playback.currentOwner()).toBe(a)
    ended.at(-1)?.()
    expect(playback.currentOwner()).toBeNull()

    plays.push(() => Promise.resolve())
    await playback.play(a, new Uint8Array([1]), 'audio/wav')
    plays.push(() => Promise.resolve())
    await playback.play(b, new Uint8Array([2]), 'audio/wav')
    expect(playback.currentOwner()).toBe(b)
    expect(owners).toContain(null)

    plays.push(() => Promise.reject(new Error('autoplay')))
    await expect(playback.play(a, new Uint8Array([3]), 'audio/wav')).rejects.toThrow(/rejected/u)
    expect(playback.currentOwner()).toBeNull()

    plays.push(() => Promise.resolve())
    await playback.play(a, new Uint8Array([4]), 'audio/wav')
    created.at(-1)?.onerror?.()
    expect(playback.currentOwner()).toBeNull()
    playback.dispose()
    vi.unstubAllGlobals()
  })
})

describe('SpeakButton', () => {
  function mount(options: {
    text?: string
    ttsReady?: boolean
    voiceId?: string
    synthesize?: SpeechRemote['synthesize']
  } = {}) {
    const host = stubSettingsScope<SpeechUserSettings>()
    const voice = options.voiceId === undefined
      ? { voiceId: undefined as unknown as string }
      : { voiceId: options.voiceId }
    host.publish({
      status: 'ready',
      value: { ...DEFAULT_SPEECH_USER_SETTINGS, ...voice },
      writable: true,
    })
    const status = createSnapshotStore<SpeechClientStatus>({
      ...INITIAL_SPEECH_CLIENT_STATUS,
      ttsReady: options.ttsReady ?? true,
    })
    const playback = createSpeechPlayback()
    const synthesize = options.synthesize ?? vi.fn(() => Promise.resolve(audioResult()))
    const speech = { status: vi.fn(), synthesize, transcribe: vi.fn() } as unknown as SpeechRemote
    const ui = render(
      <SpeakButton
        {...({
          messageId: 'm1',
          text: options.text ?? 'Hello',
          useSpeechSettings: hookOf(host.scope),
          useSpeechStatus: hookOf(status),
          speech,
          playback,
          t,
        } as never)}
      />,
    )
    return { ...ui, synthesize, playback, status }
  }

  it('stays disabled when TTS is unavailable or the message is empty', () => {
    const empty = mount({ text: '  ' })
    expect(empty.getByLabelText(en['speak.play']).hasAttribute('disabled')).toBe(true)
    cleanup()
    const cold = mount({ ttsReady: false })
    expect(cold.getByLabelText(en['speak.play']).hasAttribute('disabled')).toBe(true)
  })

  it('plays audio, then a second click stops before another synthesize', async () => {
    class FakeAudio {
      onended: (() => void) | null = null
      onerror: (() => void) | null = null
      pause = vi.fn()
      removeAttribute = vi.fn()
      play = vi.fn(() => Promise.resolve())
    }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: vi.fn() })
    const ui = mount({ voiceId: 'am_michael' })
    fireEvent.click(ui.getByLabelText(en['speak.play']))
    await waitFor(() => { expect(ui.getByLabelText(en['speak.stop'])).toBeTruthy() })
    fireEvent.click(ui.getByLabelText(en['speak.stop']))
    expect(ui.getByLabelText(en['speak.play'])).toBeTruthy()
    expect(ui.synthesize).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('cancels an in-flight synthesize instead of starting a second one', async () => {
    let release!: (value: ReturnType<typeof audioResult>) => void
    const synthesize = vi.fn(() => new Promise<ReturnType<typeof audioResult>>((resolve) => { release = resolve }))
    const ui = mount({ synthesize })
    fireEvent.click(ui.getByLabelText(en['speak.play']))
    await waitFor(() => { expect(ui.getByLabelText(en['speak.loading'])).toBeTruthy() })
    fireEvent.click(ui.getByLabelText(en['speak.loading']))
    await act(async () => { release(audioResult()) })
    expect(ui.getByLabelText(en['speak.play'])).toBeTruthy()
    expect(ui.synthesize).toHaveBeenCalledTimes(1)
  })

  it('ignores a late synthesize rejection after cancel', async () => {
    let reject!: (error: Error) => void
    const synthesize = vi.fn(() => new Promise<ReturnType<typeof audioResult>>((_, rej) => { reject = rej }))
    const ui = mount({ synthesize })
    fireEvent.click(ui.getByLabelText(en['speak.play']))
    await waitFor(() => { expect(ui.getByLabelText(en['speak.loading'])).toBeTruthy() })
    fireEvent.click(ui.getByLabelText(en['speak.loading']))
    await act(async () => { reject(new Error('late')) })
    expect(ui.getByLabelText(en['speak.play'])).toBeTruthy()
  })

  it('surfaces a failed synthesize', async () => {
    const synthesize = vi.fn(() => Promise.resolve({
      ok: false as const,
      error: { code: 'unavailable', message: 'down', details: {} },
    }))
    const ui = mount({ synthesize })
    fireEvent.click(ui.getByLabelText(en['speak.play']))
    await waitFor(() => { expect(ui.getByLabelText(en['speak.play'])).toBeTruthy() })
  })

  it('marks a business-failure synthesize as failed', async () => {
    const ui = mount({
      synthesize: vi.fn(() => Promise.resolve({
        ok: true as const,
        value: { ok: false as const, error: { code: 'SPEECH_PROVIDER_ERROR', message: 'onnx' } },
      })),
    })
    fireEvent.click(ui.getByLabelText(en['speak.play']))
    await waitFor(() => { expect(ui.getByLabelText(en['speak.play'])).toBeTruthy() })
  })

  it('ignores an empty synthesize payload and a thrown synthesize', async () => {
    const empty = mount({
      synthesize: vi.fn(() => Promise.resolve({
        ok: true as const,
        value: { ok: true as const, value: { kind: 'empty' as const } },
      })),
    })
    fireEvent.click(empty.getByLabelText(en['speak.play']))
    await waitFor(() => { expect(empty.getByLabelText(en['speak.play'])).toBeTruthy() })
    cleanup()
    const thrown = mount({ synthesize: vi.fn(() => Promise.reject(new Error('boom'))) })
    fireEvent.click(thrown.getByLabelText(en['speak.play']))
    await waitFor(() => { expect(thrown.getByLabelText(en['speak.play'])).toBeTruthy() })
  })

  it('stops playback when the button unmounts while it owns the element', async () => {
    class FakeAudio {
      onended: (() => void) | null = null
      onerror: (() => void) | null = null
      pause = vi.fn()
      removeAttribute = vi.fn()
      play = vi.fn(() => Promise.resolve())
    }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: vi.fn() })
    const ui = mount()
    fireEvent.click(ui.getByLabelText(en['speak.play']))
    await waitFor(() => { expect(ui.getByLabelText(en['speak.stop'])).toBeTruthy() })
    ui.unmount()
    expect(ui.playback.currentOwner()).toBeNull()
    vi.unstubAllGlobals()
  })
})

describe('MicButton', () => {
  function mount(options: { sttReady?: boolean; autoSubmit?: boolean } = {}) {
    const host = stubSettingsScope<SpeechUserSettings>()
    host.publish({
      status: 'ready',
      value: { ...DEFAULT_SPEECH_USER_SETTINGS, autoSubmitVoice: options.autoSubmit === true },
      writable: true,
    })
    const status = createSnapshotStore<SpeechClientStatus>({
      ...INITIAL_SPEECH_CLIENT_STATUS,
      sttReady: options.sttReady ?? true,
    })
    const transcribe = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: { ok: true as const, value: { text: 'hello from mic' } },
    }))
    const speech = { status: vi.fn(), synthesize: vi.fn(), transcribe } as unknown as SpeechRemote
    const inputActions = { setDraft: vi.fn(), submit: vi.fn() }
    const ui = render(
      <MicButton
        {...({
          session: {},
          input: {},
          inputActions,
          useSpeechSettings: hookOf(host.scope),
          useSpeechStatus: hookOf(status),
          speech,
          t,
        } as never)}
      />,
    )
    return { ...ui, transcribe, inputActions }
  }

  it('stays disabled when STT is unavailable', () => {
    const ui = mount({ sttReady: false })
    expect(ui.getByLabelText(en['mic.idle']).hasAttribute('disabled')).toBe(true)
  })

  it('records, transcribes, and fills the draft', async () => {
    const stopTrack = vi.fn()
    const recorders: FakeRecorder[] = []
    class FakeRecorder {
      mimeType = 'audio/webm'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      start = vi.fn()
      stop = vi.fn(() => {
        this.ondataavailable?.({ data: new Blob([]) })
        this.ondataavailable?.({ data: new Blob(['x']) })
        this.onstop?.()
      })
      constructor() { recorders.push(this) }
    }
    class FakeAudioContext {
      decodeAudioData = vi.fn(async () => ({
        numberOfChannels: 1,
        length: 2,
        sampleRate: 16_000,
        getChannelData: () => new Float32Array([0, 0]),
      }))
      close = vi.fn(async () => undefined)
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    vi.stubGlobal('AudioContext', FakeAudioContext)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) },
    })
    const ui = mount()
    fireEvent.click(ui.getByLabelText(en['mic.idle']))
    await waitFor(() => { expect(ui.getByLabelText(en['mic.recording'])).toBeTruthy() })
    fireEvent.click(ui.getByLabelText(en['mic.recording']))
    await waitFor(() => { expect(ui.inputActions.setDraft).toHaveBeenCalledWith('hello from mic') })
    expect(ui.inputActions.submit).not.toHaveBeenCalled()
    expect(stopTrack).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('submits the draft when auto-submit is on', async () => {
    const recorders: FakeRecorder[] = []
    class FakeRecorder {
      mimeType = 'audio/webm'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      start = vi.fn()
      stop = vi.fn(() => { this.onstop?.() })
      constructor() { recorders.push(this) }
    }
    class FakeAudioContext {
      decodeAudioData = vi.fn(async () => ({
        numberOfChannels: 1,
        length: 1,
        sampleRate: 16_000,
        getChannelData: () => new Float32Array([0]),
      }))
      close = vi.fn(async () => undefined)
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    vi.stubGlobal('AudioContext', FakeAudioContext)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    })
    const ui = mount({ autoSubmit: true })
    fireEvent.click(ui.getByLabelText(en['mic.idle']))
    await waitFor(() => { expect(recorders).toHaveLength(1) })
    fireEvent.click(ui.getByLabelText(en['mic.recording']))
    await waitFor(() => { expect(ui.inputActions.submit).toHaveBeenCalled() })
    vi.unstubAllGlobals()
  })

  it('surfaces a denied microphone as permission', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => { throw new Error('denied') }) },
    })
    const ui = mount()
    fireEvent.click(ui.getByLabelText(en['mic.idle']))
    await waitFor(() => { expect(ui.getByLabelText(en['mic.idle'])).toBeTruthy() })
    vi.unstubAllGlobals()
  })

  it('fails when AudioContext cannot be constructed', async () => {
    class FakeRecorder {
      mimeType = 'audio/webm'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      start = vi.fn()
      stop = vi.fn(() => { this.onstop?.() })
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    vi.stubGlobal('AudioContext', function ThrowingAudioContext() {
      throw new Error('no audio')
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    })
    const ui = mount()
    fireEvent.click(ui.getByLabelText(en['mic.idle']))
    await waitFor(() => { expect(ui.getByLabelText(en['mic.recording'])).toBeTruthy() })
    fireEvent.click(ui.getByLabelText(en['mic.recording']))
    await waitFor(() => { expect(ui.getByLabelText(en['mic.idle'])).toBeTruthy() })
    vi.unstubAllGlobals()
  })

  it('fails when MediaRecorder or getUserMedia is missing', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
    const missing = mount()
    fireEvent.click(missing.getByLabelText(en['mic.idle']))
    await waitFor(() => { expect(missing.getByLabelText(en['mic.idle'])).toBeTruthy() })
    cleanup()
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    })
    vi.stubGlobal('MediaRecorder', function ThrowingRecorder() {
      throw new Error('no recorder')
    })
    const failed = mount()
    fireEvent.click(failed.getByLabelText(en['mic.idle']))
    await waitFor(() => { expect(failed.getByLabelText(en['mic.idle'])).toBeTruthy() })
    vi.unstubAllGlobals()
  })

  it('fails when start throws and when decode fails', async () => {
    class StartFailRecorder {
      mimeType = ''
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      start = vi.fn(() => { throw new Error('start') })
      stop = vi.fn()
    }
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    })
    vi.stubGlobal('MediaRecorder', StartFailRecorder)
    const startFail = mount()
    fireEvent.click(startFail.getByLabelText(en['mic.idle']))
    await waitFor(() => { expect(startFail.getByLabelText(en['mic.idle'])).toBeTruthy() })
    cleanup()

    class FakeRecorder {
      mimeType = ''
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      start = vi.fn()
      stop = vi.fn(() => {
        this.ondataavailable?.({ data: new Blob(['x']) })
        this.onstop?.()
      })
    }
    class FakeAudioContext {
      decodeAudioData = vi.fn(async () => { throw new Error('bad wav') })
      close = vi.fn(async () => { throw new Error('already closed') })
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const decodeFail = mount()
    fireEvent.click(decodeFail.getByLabelText(en['mic.idle']))
    await waitFor(() => { expect(decodeFail.getByLabelText(en['mic.recording'])).toBeTruthy() })
    fireEvent.click(decodeFail.getByLabelText(en['mic.recording']))
    await waitFor(() => { expect(decodeFail.getByLabelText(en['mic.idle'])).toBeTruthy() })
    vi.unstubAllGlobals()
  })

  it('surfaces a failed transcribe and ignores clicks while transcribing', async () => {
    let release!: (value: { ok: false; error: { code: string; message: string; details: object } }) => void
    const transcribe = vi.fn(() => new Promise<{
      ok: false
      error: { code: string; message: string; details: object }
    }>((resolve) => { release = resolve }))
    const host = stubSettingsScope<SpeechUserSettings>()
    host.publish({ status: 'ready', value: DEFAULT_SPEECH_USER_SETTINGS, writable: true })
    const status = createSnapshotStore<SpeechClientStatus>({
      ...INITIAL_SPEECH_CLIENT_STATUS,
      sttReady: true,
    })
    const speech = { status: vi.fn(), synthesize: vi.fn(), transcribe } as unknown as SpeechRemote
    const inputActions = { setDraft: vi.fn(), submit: vi.fn() }
    class FakeRecorder {
      mimeType = 'audio/webm'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      start = vi.fn()
      stop = vi.fn(() => { this.onstop?.() })
    }
    class FakeAudioContext {
      decodeAudioData = vi.fn(async () => ({
        numberOfChannels: 1,
        length: 1,
        sampleRate: 16_000,
        getChannelData: () => new Float32Array([undefined as unknown as number]),
      }))
      close = vi.fn(async () => undefined)
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    vi.stubGlobal('AudioContext', FakeAudioContext)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    })
    const ui = render(
      <MicButton
        {...({
          session: {},
          input: {},
          inputActions,
          useSpeechSettings: hookOf(host.scope),
          useSpeechStatus: hookOf(status),
          speech,
          t,
        } as never)}
      />,
    )
    fireEvent.click(ui.getByLabelText(en['mic.idle']))
    await waitFor(() => { expect(ui.getByLabelText(en['mic.recording'])).toBeTruthy() })
    fireEvent.click(ui.getByLabelText(en['mic.recording']))
    await waitFor(() => { expect(ui.getByLabelText(en['mic.transcribing'])).toBeTruthy() })
    fireEvent.click(ui.getByLabelText(en['mic.transcribing']))
    await act(async () => {
      release({ ok: false, error: { code: 'unavailable', message: 'down', details: {} } })
    })
    await waitFor(() => { expect(ui.getByLabelText(en['mic.idle'])).toBeTruthy() })
    expect(inputActions.setDraft).not.toHaveBeenCalled()
    ui.unmount()
    vi.unstubAllGlobals()
  })

  it('surfaces an inner transcribe failure', async () => {
    class FakeRecorder {
      mimeType = 'audio/webm'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      start = vi.fn()
      stop = vi.fn(() => { this.onstop?.() })
    }
    class FakeAudioContext {
      decodeAudioData = vi.fn(async () => ({
        numberOfChannels: 1,
        length: 1,
        sampleRate: 16_000,
        getChannelData: () => new Float32Array([0]),
      }))
      close = vi.fn(async () => undefined)
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    vi.stubGlobal('AudioContext', FakeAudioContext)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    })
    const host = stubSettingsScope<SpeechUserSettings>()
    host.publish({ status: 'ready', value: DEFAULT_SPEECH_USER_SETTINGS, writable: true })
    const status = createSnapshotStore<SpeechClientStatus>({
      ...INITIAL_SPEECH_CLIENT_STATUS,
      sttReady: true,
    })
    const transcribe = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: { ok: false as const, error: { code: 'SPEECH_UNSUPPORTED_MEDIA', message: 'bad' } },
    }))
    const speech = { status: vi.fn(), synthesize: vi.fn(), transcribe } as unknown as SpeechRemote
    const ui = render(
      <MicButton
        {...({
          session: {},
          input: {},
          inputActions: { setDraft: vi.fn(), submit: vi.fn() },
          useSpeechSettings: hookOf(host.scope),
          useSpeechStatus: hookOf(status),
          speech,
          t,
        } as never)}
      />,
    )
    fireEvent.click(ui.getByLabelText(en['mic.idle']))
    await waitFor(() => { expect(ui.getByLabelText(en['mic.recording'])).toBeTruthy() })
    fireEvent.click(ui.getByLabelText(en['mic.recording']))
    await waitFor(() => { expect(ui.getByLabelText(en['mic.idle'])).toBeTruthy() })
    vi.unstubAllGlobals()
  })

  it('stops an open recorder on unmount', async () => {
    class FakeRecorder {
      state = 'recording'
      mimeType = 'audio/webm'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      start = vi.fn()
      stop = vi.fn(() => {
        this.state = 'inactive'
        this.onstop?.()
      })
    }
    class FakeAudioContext {
      decodeAudioData = vi.fn(async () => ({
        numberOfChannels: 1,
        length: 1,
        sampleRate: 16_000,
        getChannelData: () => new Float32Array([0]),
      }))
      close = vi.fn(async () => undefined)
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    vi.stubGlobal('AudioContext', FakeAudioContext)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    })
    const ui = mount()
    fireEvent.click(ui.getByLabelText(en['mic.idle']))
    await waitFor(() => { expect(ui.getByLabelText(en['mic.recording'])).toBeTruthy() })
    ui.unmount()
    vi.unstubAllGlobals()
  })
})

describe('settings rows', () => {
  it('picks a voice from the live catalog and toggles auto-submit', () => {
    const host = stubSettingsScope<SpeechUserSettings>()
    host.publish({ status: 'ready', value: DEFAULT_SPEECH_USER_SETTINGS, writable: true })
    const status = createSnapshotStore<SpeechClientStatus>({
      ttsReady: true,
      sttReady: true,
      voices: [{ id: 'af_heart', name: 'Heart' }, { id: 'am_michael', name: 'Michael' }],
    })
    const setField = vi.fn()
    const rowProps = {
      useSpeechSettings: hookOf(host.scope),
      useSpeechStatus: hookOf(status),
      setField,
      t,
    }
    const voice = render(<VoiceRow {...(rowProps as never)} />)
    fireEvent.click(voice.getByRole('button', { name: 'Heart' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(voice.getByRole('button', { name: 'Heart' }))
    fireEvent.click(voice.getByRole('menuitem', { name: 'Michael (am_michael)' }))
    expect(setField).toHaveBeenCalledWith('voiceId', 'am_michael')
    cleanup()
    const auto = render(<AutoSubmitRow {...(rowProps as never)} />)
    fireEvent.click(auto.getByRole('button', { name: en['settings.autoSubmit.off'] }))
    expect(setField).toHaveBeenCalledWith('autoSubmitVoice', true)
    cleanup()
    host.publish({
      status: 'loading',
      value: undefined,
      writable: true,
    })
    cleanup()
    const unset = render(<VoiceRow {...(rowProps as never)} />)
    expect(unset.getByRole('button', { name: 'Heart' })).toBeTruthy()
    cleanup()
    host.publish({
      status: 'ready',
      value: { ...DEFAULT_SPEECH_USER_SETTINGS, voiceId: 'unknown', autoSubmitVoice: true },
      writable: true,
    })
    const unknown = render(<VoiceRow {...(rowProps as never)} />)
    const picker = unknown.getByRole('button', { name: 'unknown' })
    fireEvent.click(picker)
    fireEvent.click(picker)
    cleanup()
    const on = render(<AutoSubmitRow {...(rowProps as never)} />)
    expect(on.getByRole('button', { name: en['settings.autoSubmit.on'] })).toBeTruthy()
  })
})
