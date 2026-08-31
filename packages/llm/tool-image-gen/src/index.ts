/**
 * Default-off model-facing image_gen tool over the Grok subscription. Registers
 * the tool only when enabled in config and, on each call, resolves the same
 * session credential grok-session serves (the shared grok-credential service,
 * single-flight refresh, no XAI_API_KEY and no CLI spawn), posts to the Grok
 * Build Imagine API, and saves the generated image to the attachments service
 * and a workspace file. When disabled, the tool is not registered at all and
 * the model never sees it.
 * @module @shres-code/shres-code-tool-image-gen
 */

import type { Context } from '@shres-code/cordis'
import { applyImageGenTool } from './image-gen.ts'
import {
  Config,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_OUTPUT_DIRECTORY,
  DEFAULT_REFRESH_LEEWAY_MS,
  DEFAULT_TIMEOUT_MS,
  defaultAuthPath,
  resolveConfig,
  resolveCredentialSpec,
} from './config.ts'

export {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_OUTPUT_DIRECTORY,
  DEFAULT_REFRESH_LEEWAY_MS,
  DEFAULT_TIMEOUT_MS,
  Config,
  defaultAuthPath,
  resolveConfig,
  resolveCredentialSpec,
}
export type { CredentialSpec, ResolvedConfig } from './config.ts'
export { ASPECT_RATIOS, ImageGenClient, isAspectRatio } from './client.ts'
export type { AspectRatio, ImageGenClientOptions, ImageGenResponse, ImageGenResponseData } from './client.ts'
export { IMAGE_GEN_TOOL_NAME, applyImageGenTool, formatImageGenOutput, parseImageGenArgs, presentImageGenCall, presentImageGenResult } from './image-gen.ts'
export type { ImageGenArgs, ImageGenOutput } from './image-gen.ts'
export { persistGeneratedImage } from './persist.ts'
export type { GeneratedImageOutput } from './persist.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-image-gen'

/** Services required before the plugin can register the tool. */
export const inject = ['tools', 'systemPrompt', 'grokCredential']

/**
 * Register the image_gen tool when enabled. Disabled-by-default: an absent or
 * false `enabled` registers nothing, so the model never sees the tool.
 * @param ctx - context carrying tools, systemPrompt, and grokCredential.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return
  applyImageGenTool(ctx, resolved)
}
