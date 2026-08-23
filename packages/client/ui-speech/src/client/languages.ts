/**
 * Talk-surface language catalog. Spelled here so the client bundle does not
 * value-import the Host speech package; tests assert it matches the Host list.
 * @module @shres-code/shres-code-client-ui-speech/client/languages
 */

/** One picker row. */
export interface SpeechLanguageOption {
  /** BCP-47 tag stored in settings. */
  readonly id: string
  /** Native-script label. */
  readonly label: string
}

/** Languages the talk surface and Settings list. */
export const SPEECH_LANGUAGES: readonly SpeechLanguageOption[] = [
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
  { id: 'de', label: 'Deutsch' },
  { id: 'zh', label: '中文' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
  { id: 'pt', label: 'Português' },
  { id: 'it', label: 'Italiano' },
  { id: 'hi', label: 'हिन्दी' },
  { id: 'ar', label: 'العربية' },
  { id: 'ru', label: 'Русский' },
]

/**
 * Whether confirmation TTS is offered. Kokoro's JS pack is English-only.
 * @param language - settings language tag.
 * @returns true for English primary subtags.
 */
export function spokenConfirmEnabled(language: string | undefined): boolean {
  const [primary] = (language ?? 'en').toLowerCase().split('-')
  return primary === 'en'
}
