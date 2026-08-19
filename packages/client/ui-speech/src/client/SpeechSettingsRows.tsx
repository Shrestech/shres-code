import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@shres-code/shres-code-client-ui-primitives'
import { DEFAULT_SPEECH_VOICE_ID, type SpeechUserSettings } from './settings.ts'
import type { SettingsScope, SnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import type { SpeechClientStatus } from './status.ts'
import css from './SpeechButton.module.css'

/** Injected settings-row face. */
export interface SpeechSettingsInjected {
  hooks: {
    speechSettings: SettingsScope<SpeechUserSettings>
    speechStatus: SnapshotStore<SpeechClientStatus>
  }
  setField: (field: 'voiceId' | 'autoSubmitVoice', value: unknown) => void
}

/** Full settings-row props. */
export type SpeechSettingsRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'speech'>
  & InjectFace<SpeechSettingsInjected>

/**
 * Kokoro voice picker.
 * @param props - settings scope, live status, locale.
 * @returns the settings row.
 */
export function VoiceRow({ useSpeechSettings, useSpeechStatus, setField, t }: SpeechSettingsRowProps) {
  const value = useSpeechSettings(s => s.value)
  const voices = useSpeechStatus(s => s.voices)
  const [open, setOpen] = useState(false)
  const selected = value?.voiceId ?? DEFAULT_SPEECH_VOICE_ID
  const label = voices.find(voice => voice.id === selected)?.name ?? selected
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('settings.voice.title')}</div>
        <div className={css.desc}>{t('settings.voice.description')}</div>
      </div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={voices.map(voice => ({ id: voice.id, label: `${voice.name} (${voice.id})` }))}
        selectedId={selected}
        onSelect={(id) => {
          setOpen(false)
          setField('voiceId', id)
        }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className={css.selector}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(value => !value) }}
          >
            {label}
            <IconChevronDownOutline14 className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}

/**
 * Auto-submit after dictation toggle.
 * @param props - settings scope and locale.
 * @returns the settings row.
 */
export function AutoSubmitRow({ useSpeechSettings, setField, t }: SpeechSettingsRowProps) {
  const value = useSpeechSettings(s => s.value)
  const on = value?.autoSubmitVoice === true
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('settings.autoSubmit.title')}</div>
        <div className={css.desc}>{t('settings.autoSubmit.description')}</div>
      </div>
      <button
        type="button"
        className={css.selector}
        aria-pressed={on}
        onClick={() => { setField('autoSubmitVoice', !on) }}
      >
        {on ? t('settings.autoSubmit.on') : t('settings.autoSubmit.off')}
      </button>
    </div>
  )
}
