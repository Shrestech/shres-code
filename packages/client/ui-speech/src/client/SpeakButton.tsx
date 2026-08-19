import { useCallback, useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
import { IconSpeakerOutline16, Tooltip } from '@shres-code/shres-code-client-ui-primitives'
import type {} from '@shres-code/shres-code-client-ui-conversation/client'
import type { SpeechUserSettings } from './settings.ts'
import type { SettingsScope, SnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import type { SpeechRemote } from './remote.ts'
import type { SpeechPlayback, SpeechPlaybackOwner } from './playback.ts'
import type { SpeechClientStatus } from './status.ts'
import css from './SpeechButton.module.css'

export type { SpeechPlayback, SpeechPlaybackOwner } from './playback.ts'

/** Injected speaker face. */
export interface SpeakButtonInjected {
  hooks: {
    speechSettings: SettingsScope<SpeechUserSettings>
    speechStatus: SnapshotStore<SpeechClientStatus>
  }
  speech: SpeechRemote
  playback: SpeechPlayback
}

/** Full speaker-button props. */
export type SpeakButtonProps =
  PropsRuntime<'conversation.chat.assistant-actions'>
  & InjectFace<SpeakButtonInjected>
  & PropsLocale<'speech'>

type SpeakPhase = 'idle' | 'pending' | 'playing'

/**
 * Decode canonical base64 from a Remote payload.
 * @param data - base64.
 * @returns bytes.
 */
export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * Per-message speaker control.
 * @param props - owner text, remote, playback, locale.
 * @returns the speaker button.
 */
export function SpeakButton({
  text, useSpeechSettings, useSpeechStatus, speech, playback, t,
}: SpeakButtonProps) {
  const voiceId = useSpeechSettings(s => s.value?.voiceId)
  const ttsReady = useSpeechStatus(s => s.ttsReady)
  const [phase, setPhase] = useState<SpeakPhase>('idle')
  const [failed, setFailed] = useState(false)
  const owner = useRef<SpeechPlaybackOwner>(Symbol('speak'))
  const abortRef = useRef<AbortController | null>(null)
  const generation = useRef(0)

  useEffect(() => playback.subscribe((current) => {
    setPhase(current === owner.current ? 'playing' : 'idle')
  }), [playback])

  useEffect(() => () => {
    abortRef.current?.abort()
    if (playback.currentOwner() === owner.current) playback.stop()
  }, [playback])

  const cancel = useCallback(() => {
    generation.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    if (playback.currentOwner() === owner.current) playback.stop()
    setPhase('idle')
  }, [playback])

  const toggle = useCallback(async () => {
    if (phase === 'playing' || phase === 'pending') {
      cancel()
      return
    }
    const token = generation.current + 1
    generation.current = token
    const ac = new AbortController()
    abortRef.current = ac
    setFailed(false)
    setPhase('pending')
    try {
      const result = await speech.synthesize({
        text: text ?? '',
        ...voiceId === undefined ? {} : { voiceId },
      })
      if (generation.current !== token || ac.signal.aborted) return
      if (!result.ok) {
        setFailed(true)
        setPhase('idle')
        return
      }
      const inner = result.value
      if (!inner.ok || inner.value.kind !== 'audio') {
        setFailed(!inner.ok)
        setPhase('idle')
        return
      }
      await playback.play(owner.current, decodeBase64(inner.value.audioBase64), inner.value.mediaType)
    } catch {
      if (generation.current === token) {
        setFailed(true)
        setPhase('idle')
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null
    }
  }, [cancel, phase, playback, speech, text, ttsReady, voiceId])

  const empty = text === undefined || text.trim().length === 0
  const label = phase === 'playing'
    ? t('speak.stop')
    : phase === 'pending'
      ? t('speak.loading')
      : t('speak.play')
  const tooltip = !ttsReady
    ? t('speak.unavailable')
    : failed
      ? t('speak.failed')
      : label

  return (
    <Tooltip label={tooltip} side="bottom">
      <button
        type="button"
        className={css.action}
        aria-label={label}
        aria-pressed={phase === 'playing' || undefined}
        aria-busy={phase === 'pending' || undefined}
        data-active={phase !== 'idle' || undefined}
        disabled={!ttsReady || empty}
        onClick={() => { void toggle() }}
      >
        <IconSpeakerOutline16 />
      </button>
    </Tooltip>
  )
}
