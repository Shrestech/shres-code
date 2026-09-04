// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse, SettingsNamespaceView } from '@shres-code/shres-code-api-remotes/client'
import type { SpeechStatus } from '@shres-code/shres-code-speech/types'
import { ModelListEditor } from '../src/client/ModelListEditor.tsx'
import type { ModelDraft } from '../src/client/ModelListEditor.tsx'
import { SpeechAudioCard } from '../src/client/SpeechAudioCard.tsx'
import type { SpeechStatusFace } from '../src/client/SpeechAudioCard.tsx'
import type { ModelsSectionInjected } from '../src/client/ModelsSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: ModelsSectionInjected['t'] = key => en[key]

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}

function speechNamespace(value: unknown, revision = 3): SettingsNamespaceView {
  return {
    ns: 'speech',
    schema: {},
    value,
    applies: 'live',
    secrets: [],
    revision,
  }
}

const READY_STATUS: SpeechStatus = {
  tts: { kind: 'ready', providerId: 'kokoro-tts' },
  stt: { kind: 'ready', providerId: 'whisper-tiny-en' },
  voices: [],
}

function speechFace(status: SpeechStatus = READY_STATUS): SpeechStatusFace {
  return {
    status: vi.fn((): Promise<{ ok: true; value: SpeechStatus }> => Promise.resolve({ ok: true, value: status })),
  }
}

function cardApi(overrides: {
  mutate?: ReturnType<typeof vi.fn>
  set?: ReturnType<typeof vi.fn>
  describe?: ReturnType<typeof vi.fn>
  discoverModels?: ReturnType<typeof vi.fn>
}): Pick<ModelsSectionInjected['api'], 'settings' | 'credentials' | 'llm'> {
  return {
    settings: { mutate: overrides.mutate ?? vi.fn(() => Promise.resolve(ok({}))) } as never,
    credentials: {
      set: overrides.set ?? vi.fn(() => Promise.resolve(ok({}))),
      describe: overrides.describe ?? vi.fn(() => Promise.resolve(ok({ credentials: {} }))),
    } as never,
    llm: { discoverModels: overrides.discoverModels ?? vi.fn() } as never,
  }
}

describe('SpeechAudioCard', () => {
  it('renders nothing without a speech namespace', () => {
    const { container } = render(
      <SpeechAudioCard
        api={cardApi({})} speech={speechFace()} namespace={undefined} t={t} readOnly={false}
        onChanged={() => {}} onSaved={() => {}}
      />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('shows the resolved local engines and the cloud option', async () => {
    render(
      <SpeechAudioCard
        api={cardApi({})} speech={speechFace()} namespace={speechNamespace({})} t={t} readOnly={false}
        onChanged={() => {}} onSaved={() => {}}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('Currently resolved to whisper-tiny-en.')).toBeDefined()
    })
    const stt = screen.getByLabelText<HTMLSelectElement>('Speech-to-text engine')
    const values = [...stt.options].map(option => option.value)
    expect(values).toEqual(['', 'whisper-tiny-en', 'openai-compatible-stt'])
    const tts = screen.getByLabelText<HTMLSelectElement>('Read-aloud engine')
    expect([...tts.options].map(option => option.value)).toEqual(['', 'kokoro-tts', 'openai-compatible-tts'])
  })

  it('applies the pins and the cloud profile with the captured revision', async () => {
    const mutate = vi.fn(() => Promise.resolve(ok({})))
    const onChanged = vi.fn()
    render(
      <SpeechAudioCard
        api={cardApi({ mutate })}
        speech={speechFace()}
        namespace={speechNamespace({ sttProvider: '', ttsProvider: '', cloud: { baseURL: '' } }, 7)}
        t={t}
        readOnly={false}
        onChanged={onChanged}
        onSaved={() => {}}
      />,
    )
    fireEvent.change(screen.getByLabelText('Speech-to-text engine'), { target: { value: 'openai-compatible-stt' } })
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://gw.example/v1' } })
    await waitFor(() => {
      expect(screen.getByText('Currently resolved to whisper-tiny-en.')).toBeDefined()
    })
    fireEvent.click(screen.getByText('Apply audio settings'))
    await waitFor(() => {
      expect(mutate).toHaveBeenCalled()
    })
    expect(mutate).toHaveBeenCalledWith({
      ns: 'speech',
      ops: [
        { op: 'set', path: ['sttProvider'], value: 'openai-compatible-stt' },
        { op: 'set', path: ['ttsProvider'], value: '' },
        {
          op: 'set',
          path: ['cloud'],
          value: {
            baseURL: 'https://gw.example/v1', sttModel: '', sttMode: '',
            ttsModel: '', ttsMode: '', ttsVoice: '', apiKeyEnv: '',
          },
        },
      ],
      expectedRevision: 7,
    })
    expect(onChanged).toHaveBeenCalled()
  })

  it('stores a typed key under the composed default reference', async () => {
    const set = vi.fn(() => Promise.resolve(ok({})))
    render(
      <SpeechAudioCard
        api={cardApi({ set })} speech={speechFace()} namespace={speechNamespace({})} t={t} readOnly={false}
        onChanged={() => {}} onSaved={() => {}}
      />,
    )
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: ' sk-test ' } })
    fireEvent.click(screen.getByText('Apply audio settings'))
    await waitFor(() => {
      expect(set).toHaveBeenCalledWith({ ref: 'SPEECH_OPENAI_COMPATIBLE_API_KEY', value: 'sk-test' })
    })
  })

  it('fetches audio models and assigns them to the matching fields only', async () => {
    const discoverModels = vi.fn(() => Promise.resolve(ok({
      models: [
        { id: 'stt-model', audioInput: true },
        { id: 'speak-model', audioOutput: true },
        { id: 'chat-only' },
      ],
    })))
    render(
      <SpeechAudioCard
        api={cardApi({ discoverModels })} speech={speechFace()} namespace={speechNamespace({})} t={t}
        readOnly={false} onChanged={() => {}} onSaved={() => {}}
      />,
    )
    fireEvent.click(screen.getByText('Fetch audio models'))
    await waitFor(() => {
      expect(discoverModels).toHaveBeenCalledWith({
        settingsNs: 'llm-pi-ai',
        baseURL: 'https://openrouter.ai/api/v1',
      })
    })
    const dialog = await screen.findByText('Audio models on this endpoint')
    expect(dialog).toBeDefined()
    // The picker lists only the models the endpoint declared with an audio
    // direction; the chat-only row is absent, and each row assigns to its
    // declared direction only.
    expect(screen.queryByText('chat-only')).toBeNull()
    const sttButtons = screen.getAllByRole<HTMLButtonElement>('button', { name: 'STT' })
    const ttsButtons = screen.getAllByRole<HTMLButtonElement>('button', { name: 'TTS' })
    expect(sttButtons).toHaveLength(2)
    expect(ttsButtons).toHaveLength(2)
    expect(sttButtons[0]?.disabled).toBe(false)
    expect(ttsButtons[0]?.disabled).toBe(true)
    expect(sttButtons[1]?.disabled).toBe(true)
    expect(ttsButtons[1]?.disabled).toBe(false)
    fireEvent.click(sttButtons[0]!)
    await waitFor(() => {
      expect(screen.queryByText('Audio models on this endpoint')).toBeNull()
    })
    expect(screen.getByLabelText<HTMLInputElement>('STT model ID').value).toBe('stt-model')
  })

  it('reports an endpoint that disclosed no audio models', async () => {
    const discoverModels = vi.fn(() => Promise.resolve(ok({ models: [{ id: 'chat-only' }] })))
    render(
      <SpeechAudioCard
        api={cardApi({ discoverModels })} speech={speechFace()} namespace={speechNamespace({})} t={t}
        readOnly={false} onChanged={() => {}} onSaved={() => {}}
      />,
    )
    fireEvent.click(screen.getByText('Fetch audio models'))
    await waitFor(() => {
      expect(screen.getByText('The endpoint disclosed no audio models.')).toBeDefined()
    })
  })
})

describe('ModelListEditor audio badges', () => {
  function editor(models: readonly ModelDraft[], onChange: (models: ModelDraft[]) => void): ReturnType<typeof render> {
    return render(
      <ModelListEditor
        models={models}
        onChange={onChange}
        probe={{ settingsNs: 'llm-pi-ai', baseURL: 'https://gw.example/v1' }}
        api={cardApi({
          discoverModels: vi.fn(() => Promise.resolve(ok({
            models: [{ id: 'new-stt', audioInput: true }, { id: 'plain' }],
          }))),
        }) as never}
        t={t}
        disabled={false}
      />,
    )
  }

  it('flags rows whose adopted candidates declared audio directions', () => {
    editor([{ id: 'm1', audioInput: true }, { id: 'm2', audioOutput: true }], () => {})
    expect(screen.getByTitle('Audio input: this model can transcribe speech (speech-to-text).')).toBeDefined()
    expect(screen.getByTitle('Audio output: this model can speak (text-to-speech).')).toBeDefined()
  })

  it('adopts the audio declaration with the row', async () => {
    const onChange = vi.fn()
    editor([{ id: 'existing' }], onChange)
    fireEvent.click(screen.getByText('Fetch available models'))
    await screen.findByText('Choose models to add')
    // New candidates start checked, so both adopt as they were disclosed.
    fireEvent.click(screen.getByText('Add selected'))
    await waitFor(() => {
      expect(onChange).toHaveBeenCalled()
    })
    expect(onChange.mock.calls[0]?.[0]).toEqual([
      { id: 'existing' },
      { id: 'new-stt', audioInput: true },
      { id: 'plain' },
    ])
  })
})
