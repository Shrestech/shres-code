/** `jspace` namespace dictionaries (composer chip and dock strip). */

/** English dictionary, the key-set source of truth. */
export const en = {
  'chip.on.aria': 'J-Space on, press to turn off',
  'chip.on.title': 'J-Space on — click to turn off (/j-space off)',
  'chip.off.aria': 'J-Space off, press to turn on',
  'chip.off.title': 'J-Space off — click to turn on (/j-space on)',
  'dock.goal': 'Goal',
  'dock.core': 'Core',
  'dock.next': 'Next',
  'dock.checked': 'Checked',
} satisfies Record<string, string>

/** The JSpaceKey union. */
export type JSpaceKey = keyof typeof en
