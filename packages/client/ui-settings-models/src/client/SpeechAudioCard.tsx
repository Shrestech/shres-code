/**
 * The Audio card of the Models section: which engine transcribes the mic
 * (STT) and reads assistant replies aloud (TTS), plus the custom cloud
 * endpoint those engines can point at.
 *
 * The engines are the speech settings section's user-layer pins
 * (`sttProvider` / `ttsProvider`); the cloud profile is that section's
 * `cloud` object, consumed by the composed `speech-openai-compatible`
 * provider. An empty pin resolves through composition, and every empty cloud
 * field inherits the composition default, so the card only ever writes what
 * the user actually chose. The API key travels separately through
 * `credentials.set`, exactly like an LLM provider key.
 *
 * The engine options come from the speech Remote's own `status()` (the
 * resolved local provider) plus the known cloud ids; the model pickers can be
 * filled from the endpoint's own listing, filtered to the models it declares
 * with audio input or output.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { DiscoveredModelView, IApiClient, SettingsNamespaceView } from '@shres-code/shres-code-api-remotes/client'
import { Modal } from '@shres-code/shres-code-client-ui-primitives'
import type { SpeechStatus } from '@shres-code/shres-code-speech/types'
import { messageOf } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** The settings namespace the speech seam owns. */
const SPEECH_NS = 'speech'

/** The cloud provider ids this card pins by name. */
const CLOUD_STT_ID = 'openai-compatible-stt'
const CLOUD_TTS_ID = 'openai-compatible-tts'

/**
 * The credential reference the composed provider defaults to. Mirrored
 * client-side: the browser cannot import the Host package to read it.
 */
const DEFAULT_CLOUD_KEY_REF = 'SPEECH_OPENAI_COMPATIBLE_API_KEY'

/** The endpoint the model fetch asks when the card's base URL is blank. */
const DEFAULT_CLOUD_BASE_URL = 'https://openrouter.ai/api/v1'

/** The one Remote call the card needs. */
export interface SpeechStatusFace {
  status: () => Promise<{ ok: true; value: SpeechStatus } | { ok: false; error: { message: string } }>
}

/** The cloud profile as this card drafts it. */
interface CloudDraft {
  baseURL: string
  sttModel: string
  sttMode: string
  ttsModel: string
  ttsMode: string
  ttsVoice: string
  apiKeyEnv: string
}

/** An all-inheriting draft. */
function emptyCloud(): CloudDraft {
  return { baseURL: '', sttModel: '', sttMode: '', ttsModel: '', ttsMode: '', ttsVoice: '', apiKeyEnv: '' }
}

/** Read the resolved section's cloud profile into a draft. */
function cloudDraftOf(section: unknown): CloudDraft {
  if (typeof section !== 'object' || section === null) return emptyCloud()
  const raw = (section as { cloud?: unknown }).cloud
  if (typeof raw !== 'object' || raw === null) return emptyCloud()
  const cloud = raw as Record<string, unknown>
  const text = (key: string): string => {
    const value = cloud[key]
    return typeof value === 'string' ? value : ''
  }
  return {
    baseURL: text('baseURL'),
    sttModel: text('sttModel'),
    sttMode: text('sttMode'),
    ttsModel: text('ttsModel'),
    ttsMode: text('ttsMode'),
    ttsVoice: text('ttsVoice'),
    apiKeyEnv: text('apiKeyEnv'),
  }
}

/** Replace the one `{provider}` placeholder, as the section's other copy does. */
function providerCopy(template: string, provider: string): string {
  return template.replace('{provider}', () => provider)
}

/** Props of {@link SpeechAudioCard}. */
export interface SpeechAudioCardProps {
  /** Wire faces for the settings, credential, and discovery writes. */
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  /** The speech Remote, when the browser mounted one. */
  speech: SpeechStatusFace | undefined
  /** The resolved `speech` settings namespace, when the Host composed the seam. */
  namespace: SettingsNamespaceView | undefined
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** Notify that a write landed, so the page refetches the section. */
  onChanged: () => void
  /**
   * Notify that a write committed, so the SECTION can own the saved notice:
   * the reload this card triggers unmounts it, so a card-local notice could
   * never survive to be read.
   */
  onSaved: () => void
  /** Close the card after a committed write, like every editor card here. */
  onClose: (changed: boolean) => void
}

/**
 * Render the Audio card.
 * @param props - wire faces, speech status, the speech namespace, and copy.
 * @returns the card, or null when the Host has no speech seam.
 */
export function SpeechAudioCard(props: SpeechAudioCardProps): ReactNode {
  const { api, speech, namespace, t } = props
  // The revision this card drafted over: a concurrent edit is a refusal,
  // never a silent overwrite of the user's section.
  const [openedAt] = useState(() => namespace?.revision ?? 0)
  const section = namespace?.value
  const [sttProvider, setSttProvider] = useState(() =>
    typeof (section as { sttProvider?: unknown } | undefined)?.sttProvider === 'string'
      ? (section as { sttProvider: string }).sttProvider
      : '')
  const [ttsProvider, setTtsProvider] = useState(() =>
    typeof (section as { ttsProvider?: unknown } | undefined)?.ttsProvider === 'string'
      ? (section as { ttsProvider: string }).ttsProvider
      : '')
  const [cloud, setCloud] = useState<CloudDraft>(() => cloudDraftOf(section))
  const [keyDraft, setKeyDraft] = useState('')
  const [keyConfigured, setKeyConfigured] = useState<boolean | undefined>(undefined)
  const [status, setStatus] = useState<SpeechStatus | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [candidates, setCandidates] = useState<readonly DiscoveredModelView[] | undefined>(undefined)
  const [fetching, setFetching] = useState(false)

  useEffect(() => {
    if (speech === undefined) return
    let live = true
    void speech.status().then((result) => {
      if (live && result.ok) setStatus(result.value)
    }, () => {
      // Transport failure: the card still renders from the stored section.
    })
    return () => { live = false }
  }, [speech])

  useEffect(() => {
    let live = true
    void api.credentials.describe({ refs: [DEFAULT_CLOUD_KEY_REF] }).then((response) => {
      if (live && response.result.ok) setKeyConfigured(response.result.value.credentials[DEFAULT_CLOUD_KEY_REF]?.configured === true)
    }, () => {
      // Credential enrichment is display-only; the write path re-checks.
    })
    return () => { live = false }
  }, [api])

  if (namespace === undefined) {
    // No speech seam composed: there is nothing this card can address.
    return null
  }

  const disabled = props.readOnly || busy
  const resolvedStt = status?.stt.kind === 'ready' ? status.stt.providerId : undefined
  const resolvedTts = status?.tts.kind === 'ready' ? status.tts.providerId : undefined

  /** Engine options: the composition default, the resolved local provider, and the cloud provider. */
  const engineOptions = (resolved: string | undefined, cloudId: string): ReactNode => (
    <>
      <option value="">{t('engineAuto')}</option>
      {resolved !== undefined && resolved !== cloudId
        ? <option value={resolved}>{providerCopy(t('engineLocal'), resolved)}</option>
        : null}
      <option value={cloudId}>{t('engineCloud')}</option>
    </>
  )

  const statusLine = (capability: SpeechStatus['stt'], resolved: string | undefined): string => {
    if (capability.kind === 'ready') return providerCopy(t('engineResolved'), resolved ?? capability.providerId)
    return capability.message
  }

  const patchCloud = (patch: Partial<CloudDraft>): void => {
    setCloud(current => ({ ...current, ...patch }))
  }

  /** The reference the key write targets: an explicit profile ref or the composed default. */
  const effectiveKeyRef = cloud.apiKeyEnv.length > 0 ? cloud.apiKeyEnv : DEFAULT_CLOUD_KEY_REF

  const fetchAudio = async (): Promise<void> => {
    const baseURL = cloud.baseURL.length > 0 ? cloud.baseURL : DEFAULT_CLOUD_BASE_URL
    setFetching(true)
    setFailure(undefined)
    try {
      const response = await api.llm.discoverModels({
        settingsNs: 'llm-pi-ai',
        baseURL,
        ...keyDraft.trim().length === 0 ? {} : { apiKey: keyDraft.trim() },
      })
      if (!response.result.ok) {
        setFailure(response.result.error.message)
        return
      }
      const audio = response.result.value.models.filter(model => model.audioInput === true || model.audioOutput === true)
      if (audio.length === 0) {
        setFailure(t('fetchAudioEmpty'))
        return
      }
      setCandidates(audio)
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setFetching(false)
    }
  }

  const closePicker = (): void => {
    setCandidates(undefined)
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const response = await api.settings.mutate({
        ns: SPEECH_NS,
        ops: [
          { op: 'set', path: ['sttProvider'], value: sttProvider },
          { op: 'set', path: ['ttsProvider'], value: ttsProvider },
          { op: 'set', path: ['cloud'], value: { ...cloud } },
        ],
        expectedRevision: openedAt,
      })
      if (!response.result.ok) {
        setFailure(response.result.error.message)
        return
      }
      const keyValue = keyDraft.trim()
      if (keyValue.length > 0) {
        const stored = await api.credentials.set({ ref: effectiveKeyRef, value: keyValue })
        if (!stored.result.ok) {
          setFailure(stored.result.error.message)
          return
        }
      }
      setKeyDraft('')
      props.onChanged()
      props.onSaved()
      props.onClose(true)
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles['editor']}>
      <div className={styles['editorHeader']}>
        <span className={styles['editorTitle']}>{t('speechTitle')}</span>
      </div>
      <p className={styles['advancedHint']}>{t('speechIntro')}</p>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('engineStt')}</span>
        <select
          className={`${styles['input']} ${styles['selectInput']}`}
          value={sttProvider}
          aria-label={t('engineStt')}
          disabled={disabled}
          onChange={(event) => { setSttProvider(event.target.value) }}
        >
          {engineOptions(resolvedStt, CLOUD_STT_ID)}
        </select>
        {status === undefined ? null : <p className={styles['advancedHint']}>{statusLine(status.stt, resolvedStt)}</p>}
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('engineTts')}</span>
        <select
          className={`${styles['input']} ${styles['selectInput']}`}
          value={ttsProvider}
          aria-label={t('engineTts')}
          disabled={disabled}
          onChange={(event) => { setTtsProvider(event.target.value) }}
        >
          {engineOptions(resolvedTts, CLOUD_TTS_ID)}
        </select>
        {status === undefined ? null : <p className={styles['advancedHint']}>{statusLine(status.tts, resolvedTts)}</p>}
      </div>
      <div className={styles['editorHeader']}>
        <span className={styles['editorTitle']}>{t('cloudSection')}</span>
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('cloudBaseURL')}</span>
        <input
          className={styles['input']}
          type="text"
          value={cloud.baseURL}
          placeholder={DEFAULT_CLOUD_BASE_URL}
          aria-label={t('cloudBaseURL')}
          disabled={disabled}
          onChange={(event) => { patchCloud({ baseURL: event.target.value }) }}
        />
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('cloudSttModel')}</span>
        <input
          className={styles['input']}
          type="text"
          value={cloud.sttModel}
          placeholder="microsoft/mai-transcribe-2"
          aria-label={t('cloudSttModel')}
          disabled={disabled}
          onChange={(event) => { patchCloud({ sttModel: event.target.value }) }}
        />
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('cloudSttMode')}</span>
        <select
          className={`${styles['input']} ${styles['selectInput']}`}
          value={cloud.sttMode}
          aria-label={t('cloudSttMode')}
          disabled={disabled}
          onChange={(event) => { patchCloud({ sttMode: event.target.value }) }}
        >
          <option value="">{t('modeInherit')}</option>
          <option value="chat-audio">{t('modeChatAudio')}</option>
          <option value="transcriptions">{t('modeTranscriptions')}</option>
        </select>
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('cloudTtsModel')}</span>
        <input
          className={styles['input']}
          type="text"
          value={cloud.ttsModel}
          placeholder="openai/gpt-4o-audio-preview"
          aria-label={t('cloudTtsModel')}
          disabled={disabled}
          onChange={(event) => { patchCloud({ ttsModel: event.target.value }) }}
        />
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('cloudTtsMode')}</span>
        <select
          className={`${styles['input']} ${styles['selectInput']}`}
          value={cloud.ttsMode}
          aria-label={t('cloudTtsMode')}
          disabled={disabled}
          onChange={(event) => { patchCloud({ ttsMode: event.target.value }) }}
        >
          <option value="">{t('modeInherit')}</option>
          <option value="chat-audio">{t('modeChatAudio')}</option>
          <option value="speech">{t('modeSpeech')}</option>
        </select>
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('cloudTtsVoice')}</span>
        <input
          className={styles['input']}
          type="text"
          value={cloud.ttsVoice}
          placeholder="alloy"
          aria-label={t('cloudTtsVoice')}
          disabled={disabled}
          onChange={(event) => { patchCloud({ ttsVoice: event.target.value }) }}
        />
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('speechKey')}</span>
        <input
          className={styles['input']}
          type="password"
          autoComplete="off"
          value={keyDraft}
          placeholder={keyConfigured === true ? t('speechKeyStored') : t('speechKey')}
          aria-label={t('speechKey')}
          disabled={disabled}
          onChange={(event) => { setKeyDraft(event.target.value) }}
        />
      </div>
      <div className={styles['addActions']}>
        <button
          type="button"
          className={styles['secondaryButton']}
          disabled={disabled || fetching}
          onClick={() => { void fetchAudio() }}
        >
          {fetching ? t('fetchingAudio') : t('fetchAudioModels')}
        </button>
        <button
          type="button"
          className={styles['primaryButton']}
          disabled={disabled}
          onClick={() => { void apply() }}
        >
          {busy ? t('speechApplying') : t('speechApply')}
        </button>
      </div>
      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      <Modal
        open={candidates !== undefined}
        onClose={closePicker}
        title={t('fetchAudioTitle')}
        closeLabel={t('close')}
        description={t('fetchAudioDescription')}
        className={styles['fetchDialog'] as string}
      >
        <ul className={styles['candidateList']}>
          {(candidates ?? []).map(candidate => (
            <li key={candidate.id} className={styles['candidate']}>
              <span className={styles['candidateLabel']}>
                <span className={styles['candidateId']}>{candidate.id}</span>
                {candidate.audioInput === true
                  ? (
                    <span className={styles['candidateMeta']} title={t('sttBadgeHint')}>
                      {t('sttBadge')}
                    </span>
                  )
                  : null}
                {candidate.audioOutput === true
                  ? (
                    <span className={styles['candidateMeta']} title={t('ttsBadgeHint')}>
                      {t('ttsBadge')}
                    </span>
                  )
                  : null}
              </span>
              <span className={styles['rowActions']}>
                <button
                  type="button"
                  className={styles['secondaryButton']}
                  disabled={disabled || candidate.audioInput !== true}
                  title={candidate.audioInput === true ? undefined : t('sttBadgeHint')}
                  onClick={() => {
                    patchCloud({ sttModel: candidate.id })
                    closePicker()
                  }}
                >
                  {t('sttBadge')}
                </button>
                <button
                  type="button"
                  className={styles['secondaryButton']}
                  disabled={disabled || candidate.audioOutput !== true}
                  title={candidate.audioOutput === true ? undefined : t('ttsBadgeHint')}
                  onClick={() => {
                    patchCloud({ ttsModel: candidate.id })
                    closePicker()
                  }}
                >
                  {t('ttsBadge')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  )
}
