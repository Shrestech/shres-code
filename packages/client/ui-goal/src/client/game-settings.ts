/**
 * Settings fields this plugin reads from the `game` namespace.
 * Spelled here: the client must not import the Host package at runtime.
 */

/** Stored Game mode settings the Host seat registers. */
export interface GameSettings {
  /** Master allow for the Goal fight arena. Default false. */
  enabled?: boolean
}

/** Settings namespace the Host seat registers. */
export const GAME_SETTINGS_NAMESPACE = 'game'

/**
 * Whether Settings currently allows the Goal fight arena.
 * @param snapshot - bound settings-scope snapshot.
 * @returns true only after a ready document with `enabled: true`.
 */
export function gameSettingsEnabled(snapshot: {
  status: string
  value: GameSettings | undefined
}): boolean {
  return snapshot.status === 'ready' && snapshot.value?.enabled === true
}
