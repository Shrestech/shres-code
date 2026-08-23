/**
 * Speech plugin, browser half: mic in conversation.input.right, speaker in
 * assistant-actions, and General Settings rows for voice and auto-submit.
 * @module @shres-code/shres-code-client-ui-speech/client
 */

import type { ClientContext } from '@shres-code/shres-code-client-runtime/client'
import { createSnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import type {} from '@shres-code/shres-code-api-remotes/client'
import type {} from '@shres-code/shres-code-client-ui-conversation/client'
import type {} from '@shres-code/shres-code-client-locale/client'
import type {} from '@shres-code/shres-code-client-ui-settings/client'
import {
  SPEECH_SETTINGS_NAMESPACE,
  type SpeechUserSettings,
} from './settings.ts'
import { MicButton } from './MicButton.tsx'
import type { MicButtonInjected } from './MicButton.tsx'
import { SpeakButton } from './SpeakButton.tsx'
import type { SpeakButtonInjected } from './SpeakButton.tsx'
import { AutoSubmitRow, VoiceRow } from './SpeechSettingsRows.tsx'
import type { SpeechSettingsInjected } from './SpeechSettingsRows.tsx'
import { createSpeechPlayback } from './playback.ts'
import type { SpeechRemote } from './remote.ts'
import { INITIAL_SPEECH_CLIENT_STATUS } from './status.ts'
import type { SpeechClientStatus } from './status.ts'
import { en } from './locales.ts'
import type { SpeechKey } from './locales.ts'

export type { MicButtonInjected, MicButtonProps } from './MicButton.tsx'
export type { SpeakButtonInjected, SpeakButtonProps, SpeechPlayback } from './SpeakButton.tsx'
export type { SpeechSettingsInjected, SpeechSettingsRowProps } from './SpeechSettingsRows.tsx'
export type { SpeechRemote } from './remote.ts'
export type { SpeechKey } from './locales.ts'
export type { SpeechClientStatus } from './status.ts'
export { INITIAL_SPEECH_CLIENT_STATUS } from './status.ts'
export { audioBufferToWav, bytesToBase64 } from './pcm.ts'
export { decodeBase64 } from './SpeakButton.tsx'
export { createSpeechPlayback } from './playback.ts'

declare module '@shres-code/shres-code-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Speech mic, speaker, and settings copy. */
    speech: SpeechKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'speech'

/** Required services. */
export const inject = ['slots', 'remote', 'remote.speech', 'locale', 'settingsScope']

/**
 * Project a Remote `status()` payload onto the client snapshot.
 * @param value - host status.
 * @returns the store snapshot.
 */
export function projectSpeechStatus(value: {
  readonly tts: { readonly kind: string }
  readonly stt: { readonly kind: string }
  readonly voices: SpeechClientStatus['voices']
}): SpeechClientStatus {
  return {
    ttsReady: value.tts.kind === 'ready',
    sttReady: value.stt.kind === 'ready',
    voices: value.voices,
  }
}

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-speech: dictionaries')
  const scope = ctx.settingsScope.bind<SpeechUserSettings>({
    namespace: SPEECH_SETTINGS_NAMESPACE,
  })
  const playback = createSpeechPlayback()
  ctx.effect(() => () => { playback.dispose() }, 'ui-speech: playback')

  const speech: SpeechRemote = (ctx.remote as { speech: SpeechRemote }).speech
  const statusStore = createSnapshotStore(INITIAL_SPEECH_CLIENT_STATUS)

  const refreshStatus = (): Promise<void> => speech.status().then((result) => {
    if (result.ok) statusStore.set(projectSpeechStatus(result.value))
  }, () => {
    // Transport failure; keep the last snapshot — the connection/reset
    // re-probe is the recovery path.
  })
  void refreshStatus()
  ctx.effect(
    () => ctx.on('connection/reset', () => { void refreshStatus() }),
    'ui-speech: status re-probe',
  )

  const settingsInject = (): SpeechSettingsInjected => ({
    hooks: { speechSettings: scope, speechStatus: statusStore },
    setField: (field, value) => { void scope.set(field, value) },
  })

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'mic',
    order: 20,
    locale: NS,
    inject: (): MicButtonInjected => ({
      hooks: { speechSettings: scope, speechStatus: statusStore },
      speech,
    }),
  }, MicButton))

  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'speak',
    order: 20,
    locale: NS,
    inject: (): SpeakButtonInjected => ({
      hooks: { speechSettings: scope, speechStatus: statusStore },
      speech,
      playback,
    }),
  }, SpeakButton))

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'speech-voice',
    order: 41,
    locale: NS,
    inject: settingsInject,
  }, VoiceRow))

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'auto-submit-voice',
    order: 42,
    locale: NS,
    inject: settingsInject,
  }, AutoSubmitRow))
}
