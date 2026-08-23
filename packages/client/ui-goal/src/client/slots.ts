/**
 * GoalBar's injected face. The target 'conversation.input.dock' slot is
 * declared (children table) and typed by ui-conversation; this package only
 * contributes the entry, so no SlotMap merge lives here. The live goal value
 * is NOT part of this face — it arrives through `useProjection('goal')`
 * (the framework standard kit); inject carries only the mutation verbs
 * (callbacks from inject, live state from useProjection).
 */

import type { RemoteResult } from '@shres-code/shres-code-typert-protocol'
import type { SettingsScope } from '@shres-code/shres-code-client-runtime/client'
import type { GameSettings } from './game-settings.ts'

/**
 * Settled outcome of one goal mutation, rendered inline by the strip. The
 * strip renders the failure only — the mutated goal arrives through the
 * projection — so the success value stays unread here.
 */
export type GoalActionResult = RemoteResult<unknown>

/** Injected business face of the GoalBar dock entry: the mutation verbs (function properties: the strip destructures them freely). */
export interface GoalBarActions {
  /**
   * Replace the current goal's objective (CAS on the projected ref).
   * @param objective - replacement objective text.
   */
  onEdit: (objective: string) => Promise<GoalActionResult>
  /** Pause an active goal. */
  onPause: () => Promise<GoalActionResult>
  /** Resume a paused goal. */
  onResume: () => Promise<GoalActionResult>
  /** Clear the current goal (tombstone). */
  onClear: () => Promise<GoalActionResult>
}

/** Injected face of the Goal dock: verbs plus the Game mode settings hook. */
export interface GoalDockInjected extends GoalBarActions {
  /** Settings scope for the `game` namespace. */
  hooks: {
    /** Bound Host mirror of Settings → Game mode. */
    gameSettings: SettingsScope<GameSettings>
  }
}

/** Injected face of the composer-row Game mode switch. */
export interface GameModeToggleInjected {
  /** Settings scope for the `game` namespace. */
  hooks: {
    /** Bound Host mirror of Settings → Game mode. */
    gameSettings: SettingsScope<GameSettings>
  }
  /**
   * Persist Game mode.
   * @param enabled - next allow value.
   */
  setEnabled: (enabled: boolean) => Promise<void>
}
