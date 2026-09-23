/** `settings.theme` namespace dictionaries (the Appearance row's copy). */

/** English dictionary, the key-set source of truth. */
export const en = {
  'appearance.title': 'Theme',
  'appearance.description': 'Select your preferred theme.',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'System',
} satisfies Record<string, string>

/** The ThemeKey union. */
export type ThemeKey = keyof typeof en
