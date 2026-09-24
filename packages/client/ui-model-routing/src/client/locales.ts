/** `modelRouting` namespace dictionaries (the composer routing chip's copy). */

/** English dictionary, the key-set source of truth. */
export const en = {
  'chip.off.aria': 'Automatic model routing off, press to turn on',
  'chip.off.title': 'Automatic model routing off — click to turn on (/route on)',
  'chip.on.aria': 'Automatic model routing on, press to turn off',
  'chip.on.title': 'Automatic model routing on — click to turn off (/route off)',
  'idle.warning': 'Auto routing is idle — this session already runs the routing target',
  'idle.unlisted': 'Auto routing is idle — not enabled for this model',
  'idle.restore': 'Restore strong model',
  'idle.restore.title': 'Restore strong model — switch back to the last strong route; one prefix re-prefill on the next request (cache miss)',
} satisfies Record<string, string>

/** The RoutingKey union. */
export type RoutingKey = keyof typeof en
