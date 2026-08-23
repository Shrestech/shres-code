/**
 * BCP-47 tags the talk surface offers. Whisper tiny.en covers English;
 * other tags load the multilingual tiny checkpoint.
 * @module @shres-code/shres-code-speech/languages
 */

/** One picker row. */
export interface SpeechLanguageOption {
  /** BCP-47 tag stored in settings. */
  readonly id: string
  /** Native-script label shown in Settings and the talk deck. */
  readonly label: string
  /** Whisper pipeline `language` kwarg; omitted for English-only tiny.en. */
  readonly whisper?: string
  /** When true, Talk mode may speak the confirm-to-send prompt (Kokoro English). */
  readonly spokenConfirm: boolean
}

/** English-only checkpoint. */
export const WHISPER_EN_MODEL_ID = 'Xenova/whisper-tiny.en'

/** Multilingual tiny checkpoint. */
export const WHISPER_MULTI_MODEL_ID = 'Xenova/whisper-tiny'

/** Languages the talk surface lists. */
export const SPEECH_LANGUAGES: readonly SpeechLanguageOption[] = [
  { id: 'en', label: 'English', spokenConfirm: true },
  { id: 'es', label: 'Español', whisper: 'spanish', spokenConfirm: false },
  { id: 'fr', label: 'Français', whisper: 'french', spokenConfirm: false },
  { id: 'de', label: 'Deutsch', whisper: 'german', spokenConfirm: false },
  { id: 'zh', label: '中文', whisper: 'chinese', spokenConfirm: false },
  { id: 'ja', label: '日本語', whisper: 'japanese', spokenConfirm: false },
  { id: 'ko', label: '한국어', whisper: 'korean', spokenConfirm: false },
  { id: 'pt', label: 'Português', whisper: 'portuguese', spokenConfirm: false },
  { id: 'it', label: 'Italiano', whisper: 'italian', spokenConfirm: false },
  { id: 'hi', label: 'हिन्दी', whisper: 'hindi', spokenConfirm: false },
  { id: 'ar', label: 'العربية', whisper: 'arabic', spokenConfirm: false },
  { id: 'ru', label: 'Русский', whisper: 'russian', spokenConfirm: false },
]

/**
 * Primary subtag of a BCP-47 tag.
 * @param language - settings language.
 * @returns lowercased primary subtag, or `en`.
 */
export function languagePrimary(language: string): string {
  const [primary] = language.trim().toLowerCase().split('-')
  return primary === undefined || primary.length === 0 ? 'en' : primary
}

/**
 * Resolve the Whisper checkpoint for a language tag.
 * @param language - BCP-47 tag from settings.
 * @returns Hugging Face model id.
 */
export function modelForLanguage(language: string): string {
  return languagePrimary(language) === 'en' ? WHISPER_EN_MODEL_ID : WHISPER_MULTI_MODEL_ID
}

/**
 * Whisper pipeline language name, when the multilingual checkpoint needs it.
 * @param language - BCP-47 tag from settings.
 * @returns pipeline language, or undefined for English-only tiny.en.
 */
export function whisperLanguageName(language: string): string | undefined {
  const primary = languagePrimary(language)
  const row = SPEECH_LANGUAGES.find(option => option.id === primary)
  return row?.whisper
}

/**
 * Whether Kokoro confirmation speech is offered for this tag.
 * @param language - BCP-47 tag from settings.
 * @returns true only for English.
 */
export function spokenConfirmEnabled(language: string): boolean {
  return languagePrimary(language) === 'en'
}
