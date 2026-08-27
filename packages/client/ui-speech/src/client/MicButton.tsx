import { useCallback, useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
import { Button, IconMicOutline16, Modal, Tooltip } from '@shres-code/shres-code-client-ui-primitives'
import type {} from '@shres-code/shres-code-client-ui-conversation/client'
import type { SpeechUserSettings } from './settings.ts'
import type { SettingsScope, SnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import type { SpeechRemote } from './remote.ts'
import type { SpeechClientStatus } from './status.ts'
import { audioBufferToWav, bytesToBase64 } from './pcm.ts'
import css from './SpeechButton.module.css'

/** Injected mic face. */
export interface MicButtonInjected {
  hooks: {
    speechSettings: SettingsScope<SpeechUserSettings>
    speechStatus: SnapshotStore<SpeechClientStatus>
  }
  speech: SpeechRemote
  /** Persist Talk mode from the hands-free offer dialog. */
  setTalkMode: (enabled: boolean) => void
}

/** Full mic-button props. */
export type MicButtonProps =
  PropsRuntime<'conversation.input.right'>
  & InjectFace<MicButtonInjected>
  & PropsLocale<'speech'>

type MicPhase = 'idle' | 'recording' | 'transcribing'
type MicError = 'permission' | 'failed' | 'blank'

/**
 * Composer microphone: record, decode to WAV, transcribe, fill the draft.
 * @param props - session kit, speech remote, settings, locale.
 * @returns the mic control.
 */
export function MicButton({
  inputActions, useSpeechSettings, useSpeechStatus, speech, setTalkMode, t,
}: MicButtonProps) {
  const settings = useSpeechSettings(s => s.value)
  const sttReady = useSpeechStatus(s => s.sttReady)
  const [phase, setPhase] = useState<MicPhase>('idle')
  const [starting, setStarting] = useState<boolean>(false)
  const [error, setError] = useState<MicError | undefined>()
  const [offerOpen, setOfferOpen] = useState(false)
  const mounted = useRef(true)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])

  const releaseStream = useCallback(() => {
    if (stream.current !== null) {
      for (const track of stream.current.getTracks()) track.stop()
      stream.current = null
    }
    recorder.current = null
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (recorder.current !== null && recorder.current.state !== 'inactive') {
        recorder.current.ondataavailable = null
        recorder.current.onstop = null
        recorder.current.stop()
      }
      releaseStream()
    }
  }, [releaseStream])

  const finish = useCallback(async (blob: Blob) => {
    setPhase('transcribing')
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
        ...settings?.language === undefined ? {} : { language: settings.language },
      })
      // A session switch unmounts the mic mid-transcribe; the departed
      // session's composer must not receive the draft or the submit.
      if (!mounted.current) return
      if (!result.ok) {
        setError('failed')
        return
      }
      const inner = result.value
      if (!inner.ok) {
        setError('failed')
        return
      }
      const text = inner.value.text.trim()
      if (text === '') {
        setError('blank')
        return
      }
      inputActions.setDraft(text)
      if (settings !== undefined && settings.autoSubmitVoice) {
        inputActions.submit()
      }
    } catch {
      setError('failed')
    } finally {
      if (context !== undefined) {
        try {
          await context.close()
        } catch {
          // AudioContext.close rejects after a failed decode; the instance is already dead.
        }
      }
      setPhase('idle')
    }
  }, [inputActions, settings?.autoSubmitVoice, settings?.language, speech])

  const toggle = useCallback(async () => {
    if (phase === 'recording') {
      recorder.current?.stop()
      return
    }
    /* v8 ignore next -- the disabled button gates re-entry: React flushes `starting` between discrete clicks. */
    if (starting) return
    // Some browsers omit mediaDevices; the DOM lib types it as always present.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- mediaDevices is missing in some browsers
    if (navigator.mediaDevices === undefined) {
      setError('failed')
      return
    }
    setError(undefined)
    setStarting(true)
    let mediaStream: MediaStream
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setStarting(false)
      setError('permission')
      return
    }
    setStarting(false)
    // Unmounted while the permission prompt was open: stop the resolved
    // tracks here — the unmount cleanup already ran and never saw this stream.
    if (!mounted.current) {
      for (const track of mediaStream.getTracks()) track.stop()
      return
    }
    stream.current = mediaStream
    let media: MediaRecorder
    try {
      media = new MediaRecorder(mediaStream)
    } catch {
      releaseStream()
      setError('failed')
      return
    }
    chunks.current = []
    media.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.current.push(event.data)
    }
    media.onstop = () => {
      releaseStream()
      const blob = new Blob(chunks.current, { type: media.mimeType || 'audio/webm' })
      void finish(blob)
    }
    try {
      recorder.current = media
      media.start(100)
      setPhase('recording')
    } catch {
      releaseStream()
      setError('failed')
    }
  }, [finish, phase, releaseStream, starting])

  const onMicClick = (): void => {
    if (phase === 'recording') {
      void toggle()
      return
    }
    if (phase === 'transcribing') return
    setOfferOpen(true)
  }

  const label = phase === 'recording'
    ? t('mic.recording')
    : phase === 'transcribing'
      ? t('mic.transcribing')
      : t('mic.idle')
  const tooltip = !sttReady
    ? t('mic.unavailable')
    : error === 'permission'
      ? t('mic.permission')
      : error === 'failed'
        ? t('mic.failed')
        : error === 'blank'
          ? t('mic.blank')
          : label

  return (
    <>
      <Tooltip label={tooltip} side="top">
        <button
          type="button"
          className={css.action}
          aria-label={label}
          aria-pressed={phase === 'recording' || undefined}
          data-active={phase === 'recording' || undefined}
          disabled={starting || phase === 'transcribing'}
          onClick={onMicClick}
        >
          <IconMicOutline16 />
        </button>
      </Tooltip>
      <Modal
        open={offerOpen}
        onClose={() => { setOfferOpen(false) }}
        title={t('talk.offer.title')}
        closeLabel={t('talk.offer.close')}
        description={t('talk.offer.body')}
        footer={(
          <>
            <Button
              variant="outline"
              onClick={() => { setOfferOpen(false) }}
            >
              {t('talk.offer.dismiss')}
            </Button>
            <Button
              variant="outline"
              disabled={!sttReady}
              onClick={() => {
                setOfferOpen(false)
                void toggle()
              }}
            >
              {t('talk.offer.dictate')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setOfferOpen(false)
                setTalkMode(true)
              }}
            >
              {t('talk.offer.enable')}
            </Button>
          </>
        )}
      />
    </>
  )
}
