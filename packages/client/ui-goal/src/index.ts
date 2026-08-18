/**
 * Goal surface plugin, node half. Registers the `game` settings namespace
 * so the sidebar switch and Goal fight arena share one durable allow.
 * The browser half ships via exports["./client"].
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { installSettingsSection, settingsNamespace } from '@shres-code/shres-code-settings'

/** Settings namespace the Game mode switch writes. */
export const GAME_SETTINGS_NAMESPACE = settingsNamespace('game')

/** Host-seat Game mode config. */
export interface Config {
  /** Master allow for the Goal fight arena. Default false. */
  enabled?: boolean
}

/** Schema for the `game` settings document. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
})

/** No remount: Game mode is a client read of the same document. */
export const GAME_SETTINGS_HOOKS = {
  /**
   * Accept the settings source thunk. Unused: this seat does not remount.
   * @param _current - resolved document thunk.
   */
  setSource: (_current: () => Config) => {},
  /** Accept a settings change. Unused: this seat does not remount. */
  onChange: () => {},
}

/**
 * Register the `game` settings section when a settings service is present.
 * @param ctx - host context; omitted in the inert loader-seat smoke.
 */
export function apply(ctx?: Context): void {
  if (ctx === undefined) return
  installSettingsSection(ctx, GAME_SETTINGS_NAMESPACE, Config, { enabled: false }, GAME_SETTINGS_HOOKS)
}
