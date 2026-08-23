/**
 * Spoken yes/no classification for Talk-mode confirm-to-send.
 * Deny wins when both polarities appear so a mixed utterance cannot send.
 * @module @shres-code/shres-code-client-ui-speech/client/confirm-intent
 */

/** Closed confirm-listen verdict. */
export type ConfirmIntent = 'confirm' | 'deny' | 'unknown'

/** Auto-stop window for the hands-free confirm listen. */
export const TALK_CONFIRM_LISTEN_MS = 2_000

/** Unknown-answer retries before Talk mode discards (fail closed). */
export const TALK_CONFIRM_MAX_TRIES = 2

interface PolarPhrases {
  readonly confirm: readonly string[]
  readonly deny: readonly string[]
}

/** Confirm/deny phrases keyed by BCP-47 primary subtag. */
const PHRASES: Readonly<Record<string, PolarPhrases>> = {
  en: {
    confirm: ['yes', 'yeah', 'yep', 'yup', 'confirm', 'confirmed', 'send', 'go', 'ok', 'okay', 'proceed', 'affirmative'],
    deny: ['no', 'nope', 'nah', 'cancel', 'discard', 'stop', 'wait', 'negative', 'dont'],
  },
  es: {
    confirm: ['sí', 'si', 'confirma', 'confirmar', 'envía', 'enviar', 'vale', 'ok'],
    deny: ['no', 'cancelar', 'cancela', 'descarta', 'parar'],
  },
  fr: {
    confirm: ['oui', 'confirme', 'confirmer', 'envoie', 'envoyer', 'ok', 'daccord'],
    deny: ['non', 'annule', 'annuler', 'stop'],
  },
  de: {
    confirm: ['ja', 'bestätigen', 'bestaetigen', 'senden', 'ok', 'okay'],
    deny: ['nein', 'abbrechen', 'stopp', 'stop'],
  },
  zh: {
    confirm: ['是', '确认', '發送', '发送', '好', '对', '對', '行'],
    deny: ['不', '取消', '不要', '停'],
  },
  ja: {
    confirm: ['はい', '確認', '送って', 'お願いします', 'うん'],
    deny: ['いいえ', 'やめて', 'キャンセル', 'だめ'],
  },
  ko: {
    confirm: ['네', '응', '확인', '보내', '좋아요'],
    deny: ['아니', '아니요', '취소', '그만'],
  },
  pt: {
    confirm: ['sim', 'confirma', 'confirmar', 'enviar', 'ok', 'pode'],
    deny: ['não', 'nao', 'cancelar', 'cancela', 'parar'],
  },
  it: {
    confirm: ['sì', 'si', 'conferma', 'confermare', 'invia', 'ok'],
    deny: ['no', 'annulla', 'ferma', 'stop'],
  },
  hi: {
    confirm: ['हाँ', 'हां', 'हा', 'भेजो', 'ठीक', 'yes'],
    deny: ['नहीं', 'nahi', 'मत', 'रद्द', 'no'],
  },
  ar: {
    confirm: ['نعم', 'أجل', 'ارسل', 'أرسل', 'حسنا', 'حسنًا'],
    deny: ['لا', 'الغاء', 'إلغاء', 'توقف'],
  },
  ru: {
    confirm: ['да', 'подтвердить', 'отправить', 'ок', 'хорошо'],
    deny: ['нет', 'отмена', 'стоп', 'не'],
  },
}

/**
 * Primary subtag of a BCP-47 tag.
 * @param language - settings language.
 * @returns lowercased primary subtag, or `en`.
 */
function primaryTag(language: string | undefined): string {
  const [primary] = (language ?? 'en').trim().toLowerCase().split('-')
  return primary === undefined || primary.length === 0 ? 'en' : primary
}

/**
 * Normalize an utterance for phrase matching.
 * @param text - raw transcript.
 * @returns NFKC lowercased text with punctuation stripped.
 */
export function normalizeConfirmUtterance(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

const SCRIPT_SUBSTRING = new Set(['zh', 'ja', 'ko', 'hi', 'ar'])

/**
 * Classify a confirm-listen transcript as send, discard, or retry.
 * @param text - STT transcript of the yes/no listen.
 * @param language - BCP-47 tag from speech settings.
 * @returns confirm, deny, or unknown. Deny wins when both polarities match.
 */
export function classifyConfirmUtterance(text: string, language?: string): ConfirmIntent {
  const normalized = normalizeConfirmUtterance(text)
  if (normalized.length === 0) return 'unknown'
  const tag = primaryTag(language)
  const phrases = PHRASES[tag] ?? PHRASES.en
  /* v8 ignore next -- PHRASES.en is always present. */
  if (phrases === undefined) return 'unknown'
  const tokens = normalized.split(' ')
  const substring = SCRIPT_SUBSTRING.has(tag)
  const matches = (needles: readonly string[]): boolean => {
    for (const needle of needles) {
      if (normalized === needle || tokens.includes(needle)) return true
      if (substring && needle.length > 0 && normalized.includes(needle)) return true
    }
    return false
  }
  if (matches(phrases.deny)) return 'deny'
  if (matches(phrases.confirm)) return 'confirm'
  return 'unknown'
}
