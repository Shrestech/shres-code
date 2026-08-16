/** Locale preference stored in the Host user-settings document. */

import z from '@roos-code/schemastery'

/** Settings namespace owned by the locale plugin. */
export const LOCALE_SETTINGS_NAMESPACE = 'locale'

/** Field carrying an explicit locale selection; absence delegates to the browser. */
export const LOCALE_PREFERENCE_FIELD = 'preference'

/** Locale identifiers shipped by the browser client. */
export const LOCALE_IDS = ['en'] as const

/** Retired locale identifiers that may still appear in persisted settings. */
export const RETIRED_LOCALE_IDS = ['zh'] as const

/** Shipped locale identifier. */
export type LocaleId = typeof LOCALE_IDS[number]

/** Identifier that may still be stored from a pre-purge settings document. */
export type PersistedLocaleId = LocaleId | typeof RETIRED_LOCALE_IDS[number]

/** Durable locale section shared by the Host schema and the browser scope. */
export interface LocaleSettings {
  /** Explicit locale selection; absence delegates to the browser. */
  preference?: PersistedLocaleId
}

/** Durable locale schema; also the wire envelope the browser scope validates against. */
export const LocaleSettingsSchema: z<LocaleSettings> = z.object({
  [LOCALE_PREFERENCE_FIELD]: z.union([...LOCALE_IDS, ...RETIRED_LOCALE_IDS]).required(false),
})

/**
 * Map a persisted or requested locale id onto a shipped locale.
 * A leftover `zh` preference becomes `en` without writing the document back.
 * @param value - stored preference, or any other unknown value.
 * @returns a shipped locale, or `undefined` when the value is absent or unknown.
 */
export function normalizeLocalePreference(value: unknown): LocaleId | undefined {
  if (value === 'en' || value === 'zh') return 'en'
  return undefined
}
