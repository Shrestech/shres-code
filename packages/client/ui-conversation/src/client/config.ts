/** Client defaults for the Host-backed conversation settings and Chat renderer. */
import z from '@shres-code/schemastery'
import { chatVirtualizationFields, resolveChatVirtualizationConfig } from '../submission-settings.ts'
import type {
  ChatVirtualizationOptions, ResolvedChatVirtualizationConfig,
} from '../submission-settings.ts'

/**
 * Tunables for the measured Chat row window.
 *
 * The fields are optional at the input boundary because Schemastery supplies
 * the defaults during plugin activation.
 */
export type Config = ChatVirtualizationOptions

/** Fully resolved values passed to ChatView through its injected share. */
export type ChatVirtualizationConfig = ResolvedChatVirtualizationConfig

/** Validate and default client Chat rendering values before the settings scope loads. */
export const Config: z<Config> = z.object({
  overscanRows: chatVirtualizationFields.overscanRows,
  estimatedRowHeight: chatVirtualizationFields.estimatedRowHeight,
  initialViewportHeight: chatVirtualizationFields.initialViewportHeight,
})

/**
 * Resolve Loader activation through the same schema used by direct mounts.
 * @param config - raw plugin configuration, or an omitted value for defaults.
 * @returns the complete virtualization configuration.
 */
export function resolveConfig(config?: Config): ChatVirtualizationConfig {
  return resolveChatVirtualizationConfig(config)
}
