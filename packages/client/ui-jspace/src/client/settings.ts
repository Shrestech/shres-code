/**
 * Settings fields this plugin reads from the `jspace` namespace.
 * Spelled here: the client must not import the Host package at runtime.
 */

/** Stored J-Space settings the Host seat registers. */
export interface JSpaceSettings {
  /** Master allow. Chip and dock hide when this is not true. */
  enabled?: boolean
  /** `available` waits for open; `always-open` is reserved for the prompt Consumer. */
  mode?: 'available' | 'always-open'
  /** Require a coverage term and successful evidence call. */
  requireCoverage?: boolean
  /** Extra coverage terms, escaped as literals. */
  coverageTerms?: string[]
}

/** Settings namespace the Host seat registers. */
export const JSPACE_SETTINGS_NAMESPACE = 'jspace'

/**
 * Whether Settings currently allows the J-Space surfaces.
 * @param snapshot - bound settings-scope snapshot.
 * @returns true only after a ready document with `enabled: true`.
 */
export function jspaceSettingsEnabled(snapshot: {
  status: string
  value: JSpaceSettings | undefined
}): boolean {
  return snapshot.status === 'ready' && snapshot.value?.enabled === true
}
