/** `command` namespace dictionaries (the popupSelect shell's copy). */

/** English dictionary, the key-set source of truth. */
export const en = {
  'search.placeholder': 'Search…',
  'search.aria': 'Filter options',
  'status.loading': 'Loading options…',
  'status.applying': 'Applying…',
  'status.empty': 'No options',
  'overlay.aria': '/{command} options',
  'listbox.aria': '/{command} matches',
} satisfies Record<string, string>

/** The CommandKey union. */
export type CommandKey = keyof typeof en
