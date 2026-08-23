/**
 * Talk composer: auto-listen for the instruction, then a hands-free yes/no
 * listen before the coding engine runs. The agent never sees audio, and
 * neither capture nor confirm requires a click or key.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
import { IconMicOutline16 } from '@shres-code/shres-code-client-ui-primitives'
import type { ComposerChainProps } from '@shres-code/shres-code-client-ui-conversation/client'
import type { SettingsScope, SnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import type { SpeechUserSettings } from './settings.ts'
import type { SpeechClientStatus } from './status.ts'
import type { SpeechRemote } from './remote.ts'
import type { SpeechPlayback } from './playback.ts'
import { audioBufferToWav, bytesToBase64 } from './pcm.ts'
import { decodeBase64 } from './SpeakButton.tsx'
import { SPEECH_LANGUAGES, spokenConfirmEnabled } from './languages.ts'
import {
  classifyConfirmUtterance,
  TALK_CONFIRM_LISTEN_MS,
  TALK_CONFIRM_MAX_TRIES,
} from './confirm-intent.ts'
import { watchUtteranceEnd } from './talk-listen.ts'
import css from './TalkDeck.module.css'

/** Selector match: talk mode is on and no approval/question takeover. */
export type TalkMatch = Record<string, never>

/**
 * Elect the talk composer.
 * @param owner - composer chain currency.
 * @returns empty match when talk mode owns the seat.
 */
export function selectTalkComposer(owner: ComposerChainProps): TalkMatch | null {
  if (owner.talkMode !== true) return null
  if (owner.interactions.length > 0) return null
  return {}
}

/** Injected talk-deck face. */
export interface TalkDeckInjected {
  hooks: {
    speechSettings: SettingsScope<SpeechUserSettings>
    speechStatus: SnapshotStore<SpeechClientStatus>
  }
  speech: SpeechRemote
  playback: SpeechPlayback
  setLanguage: (language: string) => void
  /** Leave Talk mode and restore the typing composer. */
  setTalkMode: (enabled: boolean) => void
}

/** Full talk composer props. */
export type TalkDeckProps =
  PropsRuntime<'conversation.composer'>
  & { matched: TalkMatch }
  & InjectFace<TalkDeckInjected>
  & PropsLocale<'speech'>

type TalkPhase =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'confirm'
  | 'confirm-listening'
  | 'confirm-transcribing'

/**
 * Decode one captured blob to a transcript, or `undefined` on failure / blank.
 * @param blob - MediaRecorder output.
 * @param speech - speech Remote.
 * @param language - BCP-47 tag.
 * @returns a transcript, or a failed/blank reason.
 */
async function transcribeBlob(
  blob: Blob,
  speech: SpeechRemote,
  language: string,
): Promise<{ ok: true; text: string } | { ok: false; reason: 'failed' | 'blank' }> {
  let context: AudioContext | undefined
  try {
    context = new AudioContext({ sampleRate: 16_000 })
    if (typeof context.resume === 'function' && context.state === 'suspended') {
      await context.resume()
    }
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    const wav = audioBufferToWav(decoded)
    const result = await speech.transcribe({
      audioBase64: bytesToBase64(wav),
      mediaType: 'audio/wav',
      language,
    })
    if (!result.ok || !result.value.ok) return { ok: false, reason: 'failed' }
    const text = result.value.value.text.trim()
    if (text === '') return { ok: false, reason: 'blank' }
    return { ok: true, text }
  } catch {
    return { ok: false, reason: 'failed' }
  } finally {
    if (context !== undefined) {
      try {
        await context.close()
      } catch {
        // AudioContext.close rejects after a failed decode; the instance is already dead.
      }
    }
  }
}

/**
 * Talk surface that replaces the typing composer.
 * @param props - session kit, speech remote, settings, locale.
 * @returns the talk deck.
 */
export function TalkDeck({
  inputActions, useSpeechSettings, useSpeechStatus, speech, playback, setLanguage, setTalkMode, t,
}: TalkDeckProps) {
  const language = useSpeechSettings(s => s.value?.language ?? 'en')
  const sttReady = useSpeechStatus(s => s.sttReady)
  const ttsReady = useSpeechStatus(s => s.ttsReady)
  const [phase, setPhase] = useState<TalkPhase>('idle')
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState<string | undefined>()
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const owner = useRef<symbol>(Symbol('talk'))
  const transcriptRef = useRef('')
  const confirmTries = useRef(0)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const confirmListenRef = useRef<() => Promise<void>>(async () => {})
  const stopWatch = useRef<() => void>(() => {})
  const opening = useRef(false)
  const blocked = useRef(false)

  const releaseStream = useCallback(() => {
    if (confirmTimer.current !== undefined) {
      clearTimeout(confirmTimer.current)
      confirmTimer.current = undefined
    }
    stopWatch.current()
    stopWatch.current = () => {}
    if (stream.current !== null) {
      for (const track of stream.current.getTracks()) track.stop()
      stream.current = null
    }
    recorder.current = null
  }, [])

  const speak = useCallback(async (text: string): Promise<void> => {
    if (!ttsReady || !spokenConfirmEnabled(language) || text.trim() === '') return
    try {
      const audio = await speech.synthesize({ text, language })
      if (audio.ok && audio.value.ok && audio.value.value.kind === 'audio') {
        await playback.play(
          owner.current,
          decodeBase64(audio.value.value.audioBase64),
          audio.value.value.mediaType,
        )
      }
    } catch {
      // Autoplay or synthesize rejection; the yes/no listen still has to run.
    }
  }, [language, playback, speech, ttsReady])

  const send = useCallback((): void => {
    const text = transcriptRef.current.trim()
    if (text === '') return
    playback.stop()
    inputActions.setDraft(text)
    inputActions.submit()
    transcriptRef.current = ''
    setTranscript('')
    setError(undefined)
    setPhase('idle')
    confirmTries.current = 0
  }, [inputActions, playback])

  const discard = useCallback((): void => {
    playback.stop()
    transcriptRef.current = ''
    setTranscript('')
    setPhase('idle')
    confirmTries.current = 0
  }, [playback])

  const openMic = useCallback(async (onStop: (blob: Blob) => void): Promise<boolean> => {
    if (navigator.mediaDevices === undefined) {
      setError(t('mic.failed'))
      return false
    }
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true },
      })
      stream.current = mediaStream
      const media = new MediaRecorder(mediaStream)
      chunks.current = []
      media.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data)
      }
      media.onstop = () => {
        releaseStream()
        onStop(new Blob(chunks.current, { type: media.mimeType || 'audio/webm' }))
      }
      recorder.current = media
      media.start(100)
      return true
    } catch {
      releaseStream()
      setError(t('mic.permission'))
      return false
    }
  }, [releaseStream, t])

  const listenForConfirm = useCallback(async (): Promise<void> => {
    if (!sttReady) return
    const opened = await openMic((blob) => {
      void (async () => {
        setPhase('confirm-transcribing')
        const result = await transcribeBlob(blob, speech, language)
        const intent = classifyConfirmUtterance(result.ok ? result.text : '', language)
        if (intent === 'confirm') {
          send()
          return
        }
        if (intent === 'deny') {
          await speak(t('talk.confirm.cancelled'))
          setError(undefined)
          discard()
          return
        }
        confirmTries.current += 1
        setError(t('talk.confirm.unknown'))
        if (confirmTries.current >= TALK_CONFIRM_MAX_TRIES) {
          await speak(t('talk.confirm.cancelled'))
          discard()
          return
        }
        await speak(t('talk.confirm.unknown'))
        await confirmListenRef.current()
      })()
    })
    if (!opened) {
      discard()
      return
    }
    setPhase('confirm-listening')
    confirmTimer.current = setTimeout(() => {
      recorder.current?.stop()
    }, TALK_CONFIRM_LISTEN_MS)
  }, [discard, language, openMic, send, speak, speech, sttReady, t])

  confirmListenRef.current = listenForConfirm

  const finishInstruction = useCallback(async (blob: Blob): Promise<void> => {
    setPhase('transcribing')
    const result = await transcribeBlob(blob, speech, language)
    if (!result.ok) {
      setError(t(result.reason === 'blank' ? 'mic.blank' : 'mic.failed'))
      setPhase('idle')
      return
    }
    transcriptRef.current = result.text
    setTranscript(result.text)
    setError(undefined)
    confirmTries.current = 0
    setPhase('confirm')
    await speak(`${t('talk.confirm.prompt')} ${result.text}`)
    await listenForConfirm()
  }, [language, listenForConfirm, speak, speech, t])

  useEffect(() => () => {
    if (recorder.current !== null && recorder.current.state !== 'inactive') {
      recorder.current.ondataavailable = null
      recorder.current.onstop = null
      recorder.current.stop()
    }
    releaseStream()
    playback.stop()
  }, [playback, releaseStream])

  const start = useCallback(async () => {
    if (!sttReady || phase !== 'idle' || blocked.current || opening.current) return
    opening.current = true
    const opened = await openMic((blob) => { void finishInstruction(blob) })
    opening.current = false
    if (opened) {
      const live = stream.current
      if (live !== null) {
        stopWatch.current = watchUtteranceEnd(live, () => {
          const media = recorder.current
          if (media !== null && media.state !== 'inactive') media.stop()
        })
      }
      setPhase('listening')
      return
    }
    blocked.current = true
  }, [finishInstruction, openMic, phase, sttReady])

  useEffect(() => {
    if (phase !== 'idle' || !sttReady || blocked.current) return
    void start()
  }, [phase, start, sttReady])

  const confirming = phase === 'confirm'
    || phase === 'confirm-listening'
    || phase === 'confirm-transcribing'
  const live = phase === 'listening' || phase === 'confirm-listening'
  const status = !sttReady
    ? t('talk.unavailable')
    : phase === 'transcribing' || phase === 'confirm-transcribing'
      ? t('talk.transcribing')
      : confirming
        ? t('talk.confirm.title')
        : t('talk.listening')
  const detail = !sttReady
    ? undefined
    : confirming
      ? (phase === 'confirm-listening' ? t('talk.confirm.listening') : t('talk.confirm.body'))
      : phase === 'transcribing'
        ? undefined
        : t('talk.speak')

  return (
    <div className={css.frame} data-talk-deck="" data-phase={phase}>
      <div className={css.card}>
        <div className={css.top}>
          <span className={css.brand}>{t('talk.mode')}</span>
          <label className={css.lang}>
            <select
              aria-label={t('settings.language.title')}
              value={language}
              disabled={confirming}
              onChange={(event) => { setLanguage(event.target.value) }}
            >
              {SPEECH_LANGUAGES.map(row => (
                <option key={row.id} value={row.id}>{row.label}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={css.exit}
            disabled={confirming}
            onClick={() => { setTalkMode(false) }}
          >
            {t('talk.exit')}
          </button>
        </div>
        <div className={css.stage} data-talk-listen="">
          <div className={css.orb} data-live={live || undefined}>
            <span className={css.ring} />
            <span className={css.ring} />
            <span className={css.core}>
              <IconMicOutline16 size={22} />
            </span>
          </div>
          <p className={css.status}>{status}</p>
          {detail !== undefined && <p className={css.detail}>{detail}</p>}
        </div>
        {confirming && transcript !== '' && (
          <p className={css.quote} data-talk-transcript="">{transcript}</p>
        )}
        {error !== undefined && <p className={css.error} role="status">{error}</p>}
      </div>
    </div>
  )
}
