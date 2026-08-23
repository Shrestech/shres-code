import { describe, expect, it } from 'vitest'
import {
  languagePrimary,
  modelForLanguage,
  spokenConfirmEnabled,
  SPEECH_LANGUAGES,
  WHISPER_EN_MODEL_ID,
  WHISPER_MULTI_MODEL_ID,
  whisperLanguageName,
} from '../src/languages.ts'

describe('speech language catalog', () => {
  it('routes English to tiny.en and every other tag to multilingual tiny', () => {
    expect(languagePrimary('')).toBe('en')
    expect(languagePrimary('EN-US')).toBe('en')
    expect(modelForLanguage('en')).toBe(WHISPER_EN_MODEL_ID)
    expect(modelForLanguage('es')).toBe(WHISPER_MULTI_MODEL_ID)
    expect(whisperLanguageName('en')).toBeUndefined()
    expect(whisperLanguageName('es-MX')).toBe('spanish')
    expect(spokenConfirmEnabled('en-GB')).toBe(true)
    expect(spokenConfirmEnabled('fr')).toBe(false)
    expect(SPEECH_LANGUAGES.map(row => row.id)).toEqual([
      'en', 'es', 'fr', 'de', 'zh', 'ja', 'ko', 'pt', 'it', 'hi', 'ar', 'ru',
    ])
  })
})
