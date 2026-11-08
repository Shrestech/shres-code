/** Host registration for the busy-Enter preference and Chat rendering defaults. */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { settingsNamespace } from '@shres-code/shres-code-settings'
import {
  chatVirtualizationFields, CONVERSATION_SETTINGS_NAMESPACE, ConversationSettingsSchema,
} from './submission-settings.ts'
import type { ChatVirtualizationOptions } from './submission-settings.ts'

/** Host composition defaults for the measured Chat row window. */
export type Config = ChatVirtualizationOptions

/** Validate and default the Host composition values copied into the settings base layer. */
export const Config: z<Config> = z.object({
  overscanRows: chatVirtualizationFields.overscanRows,
  estimatedRowHeight: chatVirtualizationFields.estimatedRowHeight,
  initialViewportHeight: chatVirtualizationFields.initialViewportHeight,
})

export {
  BUSY_ENTER_BEHAVIORS, BUSY_ENTER_FIELD, CONVERSATION_SETTINGS_NAMESPACE,
  DEFAULT_BUSY_ENTER_BEHAVIOR, type BusyEnterBehavior, type ConversationSettings,
} from './submission-settings.ts'

/**
 * Register the durable conversation section when a settings provider exists.
 * @param ctx - Host context whose optional settings service owns the section.
 * @param config - Host composition defaults for the Chat row window.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      settingsNamespace(CONVERSATION_SETTINGS_NAMESPACE),
      ConversationSettingsSchema,
      { base: config },
    )
  })
}
