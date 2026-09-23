/** `settings.locale` namespace dictionaries (the Language row's copy). */

/** English dictionary (the key-set source of truth). */
export const en = {
  'language.title': 'Language',
  'language.description': 'Set the language for the interface.',
} satisfies Record<string, string>

/** The settings.locale namespace key union. */
export type SettingsLocaleKey = keyof typeof en
