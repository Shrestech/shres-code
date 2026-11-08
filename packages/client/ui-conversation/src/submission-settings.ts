/** Host-backed busy-Enter and Chat virtualization settings. */

import z from '@shres-code/schemastery'

/** Settings namespace owned by the conversation plugin. */
export const CONVERSATION_SETTINGS_NAMESPACE = 'ui-conversation'

/** Field carrying the delivery mode for plain Enter while an agent is busy. */
export const BUSY_ENTER_FIELD = 'busyEnter'

/** Busy-Enter behaviors accepted at settings and input boundaries. */
export const BUSY_ENTER_BEHAVIORS = ['queue', 'steer'] as const

/** Configurable meaning of plain Enter while the addressed agent is busy. */
export type BusyEnterBehavior = typeof BUSY_ENTER_BEHAVIORS[number]

/** Default preserves Enter-as-Queue for running conversations. */
export const DEFAULT_BUSY_ENTER_BEHAVIOR: BusyEnterBehavior = 'queue'

/** Default number of extra Chat rows mounted around the visible window. */
export const DEFAULT_OVERSCAN_ROWS = 12

/** Default row height estimate used before a Chat row is measured. */
export const DEFAULT_ESTIMATED_ROW_HEIGHT = 96

/** Default viewport height estimate used before the Chat scrollport is measured. */
export const DEFAULT_INITIAL_VIEWPORT_HEIGHT = 600

/** Raw Chat row-window values accepted by Host and browser plugin configuration. */
export interface ChatVirtualizationOptions {
  /** Number of extra mounted rows kept on either side of the visible window. */
  overscanRows?: number
  /** Estimated height in pixels used before a Chat row is measured. */
  estimatedRowHeight?: number
  /** Initial viewport height in pixels used before the scrollport is measured. */
  initialViewportHeight?: number
}

/** Fully resolved Chat row-window values consumed by the renderer. */
export type ResolvedChatVirtualizationConfig = Readonly<Required<ChatVirtualizationOptions>>

/** Shared field definitions for the Host schema, browser schema, and settings schema. */
export const chatVirtualizationFields = {
  overscanRows: z.natural().default(DEFAULT_OVERSCAN_ROWS),
  estimatedRowHeight: z.natural().min(1).default(DEFAULT_ESTIMATED_ROW_HEIGHT),
  initialViewportHeight: z.natural().min(1).default(DEFAULT_INITIAL_VIEWPORT_HEIGHT),
}

/** Validate and default raw Chat row-window values. */
const ChatVirtualizationConfigSchema: z<ChatVirtualizationOptions> = z.object({
  overscanRows: chatVirtualizationFields.overscanRows,
  estimatedRowHeight: chatVirtualizationFields.estimatedRowHeight,
  initialViewportHeight: chatVirtualizationFields.initialViewportHeight,
})

/**
 * Resolve Chat row-window values for the renderer.
 * @param config - Raw plugin or settings values; omitted fields use schema defaults.
 * @returns Validated, complete row-window values.
 */
export function resolveChatVirtualizationConfig(config?: ChatVirtualizationOptions): ResolvedChatVirtualizationConfig {
  const resolved = ChatVirtualizationConfigSchema(config)
  return {
    overscanRows: resolved.overscanRows as number,
    estimatedRowHeight: resolved.estimatedRowHeight as number,
    initialViewportHeight: resolved.initialViewportHeight as number,
  }
}

/** Durable conversation section shared by the Host schema and the browser scope. */
export interface ConversationSettings extends ChatVirtualizationOptions {
  /** Delivery mode for plain Enter while the addressed agent is busy. */
  busyEnter: BusyEnterBehavior
}

/** Durable conversation schema; also the wire envelope the browser scope validates against. */
export const ConversationSettingsSchema: z<ConversationSettings> = z.object({
  [BUSY_ENTER_FIELD]: z.union([...BUSY_ENTER_BEHAVIORS]).default(DEFAULT_BUSY_ENTER_BEHAVIOR),
  ...chatVirtualizationFields,
})
