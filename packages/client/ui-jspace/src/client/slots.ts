/**
 * Injected faces for the J-Space chip and dock. Live card and goal values
 * arrive through `useProjection`; Settings `enabled` arrives through the
 * reserved `hooks` compartment. Inject carries only command verbs.
 */

import type { SessionId, SettingsScope } from '@shres-code/shres-code-client-runtime/client'
import type { JSpaceSettings } from './settings.ts'

/** Injected business face of the composer J-Space chip. */
export interface JSpaceChipInjected {
  /** Current conversation session; inherited parent cards must not count as open. */
  sessionId: SessionId
  /** Settings scope for the `jspace` namespace. */
  hooks: {
    /** Bound Host mirror of Settings → J-Space. */
    jspaceSettings: SettingsScope<JSpaceSettings>
  }
  /**
   * Close the session card by executing `/j-space off`.
   * @returns null on admitted execution; a user-visible failure line otherwise.
   */
  closeCard: () => Promise<string | null>
  /**
   * Open the session card by executing `/j-space on`.
   * Bare on opens the host stock Goal/Next; this chip does not collect arguments.
   * @returns null on admitted execution; a user-visible failure line otherwise.
   */
  openCard: () => Promise<string | null>
}

/** Injected business face of the J-Space dock strip. */
export interface JSpaceDockInjected {
  /** Current conversation session; inherited parent cards must not render. */
  sessionId: SessionId
  /** Settings scope for the `jspace` namespace. */
  hooks: {
    /** Bound Host mirror of Settings → J-Space. */
    jspaceSettings: SettingsScope<JSpaceSettings>
  }
}
