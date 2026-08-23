/**
 * Talk mode switch, language catalog, and spoken confirm-before-send.
 */
// @vitest-environment jsdom
import { createElement, useSyncExternalStore, type ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate, stubSettingsScope } from '@shres-code/shres-code-client-test-runtime'
import { createSnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import {
  DEFAULT_SPEECH_LANGUAGE,
  DEFAULT_SPEECH_USER_SETTINGS,
  DEFAULT_SPEECH_VOICE_ID,
  SPEECH_LANGUAGES as HOST_LANGUAGES,
  type SpeechUserSettings,
} from '@shres-code/shres-code-speech'
import {
  DEFAULT_SPEECH_LANGUAGE as CLIENT_DEFAULT_LANGUAGE,
  DEFAULT_SPEECH_VOICE_ID as CLIENT_DEFAULT_VOICE_ID,
} from '../src/client/settings.ts'
import { SPEECH_LANGUAGES, spokenConfirmEnabled } from '../src/client/languages.ts'
import { classifyConfirmUtterance } from '../src/client/confirm-intent.ts'
import { selectTalkComposer, TalkDeck } from '../src/client/TalkDeck.tsx'
import { MicButton } from '../src/client/MicButton.tsx'
import { LanguageRow } from '../src/client/SpeechSettingsRows.tsx'
import { createSpeechPlayback } from '../src/client/playback.ts'
import { INITIAL_SPEECH_CLIENT_STATUS } from '../src/client/status.ts'
import type { SpeechClientStatus } from '../src/client/status.ts'
import type { SpeechRemote } from '../src/client/remote.ts'
import { en } from '../src/client/locales.ts'
import type { ComposerChainProps } from '@shres-code/shres-code-client-ui-conversation/client'

afterEach(cleanup)

const t = makeTranslate(en)

function renderLoose(component: ComponentType<never>, props: object) {
  return render(createElement(component, props as never))
}

function hookOf<T>(source: { getSnapshot(): T; subscribe(fn: () => void): () => void }) {
  return <S,>(select: (value: T) => S): S =>
    useSyncExternalStore(source.subscribe, () => select(source.getSnapshot()))
}

function transcriptResult(text: string) {
  return {
    ok: true as const,
    value: { ok: true as const, value: { text } },
  }
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

const recorders: FakeRecorder[] = []

class FakeRecorder {
  mimeType = 'audio/webm'
  state = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  start = vi.fn(() => { this.state = 'recording' })
  stop = vi.fn(() => {
    if (this.state === 'inactive') return
    this.state = 'inactive'
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
    getChannelData: () => new Float32Array([0, 0.5]),
  }))
  close = vi.fn(async () => undefined)
}

function stubMic(): void {
  recorders.length = 0
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
  })
}

async function speakInstruction(ui: ReturnType<typeof renderLoose>): Promise<void> {
  await waitFor(() => { expect(recorders.length).toBeGreaterThan(0) })
  recorders[0]?.stop()
  await waitFor(() => { expect(ui.getByText(en['talk.confirm.title'])).toBeTruthy() })
}

async function finishConfirmListen(count: number): Promise<void> {
  await waitFor(() => { expect(recorders).toHaveLength(count) })
  recorders[count - 1]?.stop()
}

describe('client-spelled language catalog', () => {
  it('matches the Host speech section defaults and language ids', () => {
    expect(CLIENT_DEFAULT_VOICE_ID).toBe(DEFAULT_SPEECH_VOICE_ID)
    expect(CLIENT_DEFAULT_LANGUAGE).toBe(DEFAULT_SPEECH_LANGUAGE)
    expect(SPEECH_LANGUAGES.map(row => row.id)).toEqual(HOST_LANGUAGES.map(row => row.id))
    expect(spokenConfirmEnabled('en')).toBe(true)
    expect(spokenConfirmEnabled('en-US')).toBe(true)
    expect(spokenConfirmEnabled('es')).toBe(false)
  })
})

describe('classifyConfirmUtterance', () => {
  it('sends on yes and fail-closes on no, mixed, or empty', () => {
    expect(classifyConfirmUtterance('Yes, send it', 'en')).toBe('confirm')
    expect(classifyConfirmUtterance("don't", 'en')).toBe('deny')
    expect(classifyConfirmUtterance('yes no', 'en')).toBe('deny')
    expect(classifyConfirmUtterance('  ', 'en')).toBe('unknown')
    expect(classifyConfirmUtterance('maybe later', 'en')).toBe('unknown')
    expect(classifyConfirmUtterance('know', 'en')).toBe('unknown')
  })

  it('classifies native-script confirm and deny phrases', () => {
    expect(classifyConfirmUtterance('sí', 'es')).toBe('confirm')
    expect(classifyConfirmUtterance('cancelar', 'es')).toBe('deny')
    expect(classifyConfirmUtterance('确认发送', 'zh')).toBe('confirm')
    expect(classifyConfirmUtterance('不要', 'zh')).toBe('deny')
    expect(classifyConfirmUtterance('はい', 'ja')).toBe('confirm')
    expect(classifyConfirmUtterance('да', 'ru')).toBe('confirm')
  })
})

describe('selectTalkComposer', () => {
  const session = undefined
  it('elects only when talk mode is on and no interaction takeover is pending', () => {
    const idle: ComposerChainProps = { interactions: [], session, talkMode: true }
    expect(selectTalkComposer(idle)).toEqual({})
    expect(selectTalkComposer({ interactions: [], session, talkMode: false })).toBeNull()
    expect(selectTalkComposer({
      interactions: [{ kind: 'approval' } as ComposerChainProps['interactions'][number]],
      session,
      talkMode: true,
    })).toBeNull()
  })
})

describe('MicButton hands-free offer', () => {
  it('explains Talk mode, then Enable writes talkMode', () => {
    const setTalkMode = vi.fn()
    const host = stubSettingsScope<SpeechUserSettings>()
    host.publish({ status: 'ready', value: DEFAULT_SPEECH_USER_SETTINGS, writable: true })
    const ui = renderLoose(MicButton, {
      session: {},
      input: {},
      inputActions: { setDraft: vi.fn(), submit: vi.fn() },
      useSpeechSettings: hookOf(host.scope),
      useSpeechStatus: hookOf(createSnapshotStore({ ...INITIAL_SPEECH_CLIENT_STATUS, sttReady: true })),
      speech: { status: vi.fn(), synthesize: vi.fn(), transcribe: vi.fn() },
      setTalkMode,
      t,
    })
    fireEvent.click(ui.getByLabelText(en['mic.idle']))
    expect(ui.getByRole('dialog', { name: en['talk.offer.title'] })).toBeTruthy()
    expect(ui.getByText(en['talk.offer.body'])).toBeTruthy()
    fireEvent.click(ui.getByRole('button', { name: en['talk.offer.enable'] }))
    expect(setTalkMode).toHaveBeenCalledWith(true)
  })
})

describe('LanguageRow', () => {
  it('writes the chosen language tag', () => {
    const host = stubSettingsScope<SpeechUserSettings>()
    host.publish({ status: 'ready', value: DEFAULT_SPEECH_USER_SETTINGS, writable: true })
    const setField = vi.fn()
    const ui = renderLoose(LanguageRow, {
      useSpeechSettings: hookOf(host.scope),
      useSpeechStatus: hookOf(createSnapshotStore(INITIAL_SPEECH_CLIENT_STATUS)),
      setField,
      t,
    })
    fireEvent.click(ui.getByRole('button', { name: 'English' }))
    fireEvent.click(ui.getByRole('menuitem', { name: 'Español' }))
    expect(setField).toHaveBeenCalledWith('language', 'es')
  })
})

describe('TalkDeck exit', () => {
  it('returns to typing through Type instead', () => {
    const setTalkMode = vi.fn()
    const host = stubSettingsScope<SpeechUserSettings>()
    host.publish({
      status: 'ready',
      value: { ...DEFAULT_SPEECH_USER_SETTINGS, talkMode: true },
      writable: true,
    })
    const ui = renderLoose(TalkDeck, {
      matched: {},
      inputActions: { setDraft: vi.fn(), submit: vi.fn() },
      useSpeechSettings: hookOf(host.scope),
      useSpeechStatus: hookOf(createSnapshotStore({ ...INITIAL_SPEECH_CLIENT_STATUS, sttReady: true })),
      speech: { status: vi.fn(), synthesize: vi.fn(), transcribe: vi.fn() },
      playback: createSpeechPlayback(),
      setLanguage: vi.fn(),
      setTalkMode,
      t,
    })
    fireEvent.click(ui.getByRole('button', { name: en['talk.exit'] }))
    expect(setTalkMode).toHaveBeenCalledWith(false)
  })
})

describe('TalkDeck', () => {
  function mount(options: {
    language?: string
    sttReady?: boolean
    ttsReady?: boolean
    answers?: string[]
    synthesize?: SpeechRemote['synthesize']
  } = {}) {
    const host = stubSettingsScope<SpeechUserSettings>()
    host.publish({
      status: 'ready',
      value: {
        ...DEFAULT_SPEECH_USER_SETTINGS,
        talkMode: true,
        language: options.language ?? 'en',
      },
      writable: true,
    })
    const status = createSnapshotStore<SpeechClientStatus>({
      ...INITIAL_SPEECH_CLIENT_STATUS,
      sttReady: options.sttReady ?? true,
      ttsReady: options.ttsReady ?? false,
    })
    const answers = options.answers ?? ['refactor the parser', 'yes']
    const transcribe = vi.fn(async () => transcriptResult(answers.shift() ?? ''))
    const synthesize = options.synthesize ?? vi.fn(() => Promise.resolve(audioResult()))
    const speech = { status: vi.fn(), synthesize, transcribe } as unknown as SpeechRemote
    const playback = createSpeechPlayback()
    const inputActions = { setDraft: vi.fn(), submit: vi.fn() }
    const setLanguage = vi.fn()
    const setTalkMode = vi.fn()
    const ui = renderLoose(TalkDeck, {
      matched: {},
      inputActions,
      useSpeechSettings: hookOf(host.scope),
      useSpeechStatus: hookOf(status),
      speech,
      playback,
      setLanguage,
      setTalkMode,
      t,
    })
    return { ...ui, transcribe, synthesize, inputActions, setLanguage, setTalkMode, playback }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    recorders.length = 0
  })

  it('sends only after a spoken yes, never on the instruction listen', async () => {
    stubMic()
    const ui = mount()
    await speakInstruction(ui)
    expect(ui.inputActions.setDraft).not.toHaveBeenCalled()
    expect(ui.inputActions.submit).not.toHaveBeenCalled()
    expect(ui.getByRole('button', { name: en['talk.exit'] })).toBeTruthy()
    expect(ui.transcribe).toHaveBeenCalledWith(expect.objectContaining({ language: 'en' }))
    await finishConfirmListen(2)
    await waitFor(() => { expect(ui.inputActions.submit).toHaveBeenCalledTimes(1) })
    expect(ui.inputActions.setDraft).toHaveBeenCalledWith('refactor the parser')
  })

  it('discards on a spoken no without submitting', async () => {
    stubMic()
    const ui = mount({ answers: ['refactor the parser', 'no'] })
    await speakInstruction(ui)
    await finishConfirmListen(2)
    await waitFor(() => { expect(ui.getByText(en['talk.listening'])).toBeTruthy() })
    expect(ui.inputActions.submit).not.toHaveBeenCalled()
  })

  it('retries an unknown answer, then fail-closes without sending', async () => {
    stubMic()
    const ui = mount({ answers: ['refactor the parser', 'hmm', 'uh'] })
    await speakInstruction(ui)
    await finishConfirmListen(2)
    await waitFor(() => { expect(ui.getByText(en['talk.confirm.unknown'])).toBeTruthy() })
    expect(ui.inputActions.submit).not.toHaveBeenCalled()
    await finishConfirmListen(3)
    await waitFor(() => { expect(ui.getByText(en['talk.listening'])).toBeTruthy() })
    expect(ui.inputActions.submit).not.toHaveBeenCalled()
  })

  it('does not speak the confirm prompt for a non-English language', async () => {
    stubMic()
    const ui = mount({ language: 'es', ttsReady: true, answers: ['arregla el parser', 'sí'] })
    class FakeAudio {
      onended: (() => void) | null = null
      onerror: (() => void) | null = null
      pause = vi.fn()
      removeAttribute = vi.fn()
      play = vi.fn(() => Promise.resolve())
    }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:talk', revokeObjectURL: vi.fn() })
    await speakInstruction(ui)
    expect(ui.transcribe).toHaveBeenCalledWith(expect.objectContaining({ language: 'es' }))
    expect(ui.synthesize).not.toHaveBeenCalled()
    await finishConfirmListen(2)
    await waitFor(() => { expect(ui.inputActions.submit).toHaveBeenCalledTimes(1) })
  })

  it('writes the language picker through setLanguage', () => {
    const ui = mount({ sttReady: false })
    fireEvent.change(ui.getByLabelText(en['settings.language.title']), { target: { value: 'ja' } })
    expect(ui.setLanguage).toHaveBeenCalledWith('ja')
  })

  it('shows unavailable copy when STT is cold', () => {
    const ui = mount({ sttReady: false })
    expect(ui.getByText(en['talk.unavailable'])).toBeTruthy()
  })

  it('surfaces a blank instruction without sending', async () => {
    stubMic()
    const ui = mount({ answers: ['   '] })
    await waitFor(() => { expect(recorders.length).toBeGreaterThan(0) })
    recorders[0]?.stop()
    await waitFor(() => { expect(ui.getByRole('status').textContent).toBe(en['mic.blank']) })
    expect(ui.inputActions.submit).not.toHaveBeenCalled()
  })

  it('surfaces a denied microphone without sending', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => { throw new Error('denied') }) },
    })
    const ui = mount()
    await waitFor(() => { expect(ui.getByRole('status').textContent).toBe(en['mic.permission']) })
    expect(ui.inputActions.submit).not.toHaveBeenCalled()
  })

  it('surfaces a missing mediaDevices API without sending', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: undefined,
    })
    const ui = mount()
    await waitFor(() => { expect(ui.getByRole('status').textContent).toBe(en['mic.failed']) })
    expect(ui.inputActions.submit).not.toHaveBeenCalled()
  })
})
