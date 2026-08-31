/**
 * The model-facing image_gen tool. Registers the tool and its system-prompt
 * guidance, resolves the Grok subscription session credential through the
 * shared grok-credential service, calls the Grok Imagine API, and persists the
 * generated image to the attachments service and a workspace file. Render
 * intent is the generic card; the tool result reports the saved locations.
 * @module @shres-code/shres-code-tool-image-gen/image-gen
 */

import type { Context } from '@shres-code/cordis'
import { defineTool } from '@shres-code/shres-code-tools'
import type { GenericCallView, ToolResult } from '@shres-code/shres-code-tools'
import type { GrokSessionManager } from '@shres-code/shres-code-grok-credential'
import { ImageGenClient, isAspectRatio } from './client.ts'
import type { ResolvedConfig } from './config.ts'
import { resolveCredentialSpec } from './config.ts'
import { persistGeneratedImage } from './persist.ts'

/** Tool id the image_gen tool registers under. */
export const IMAGE_GEN_TOOL_NAME = 'image_gen'

/** Schema-validated image_gen arguments. */
export interface ImageGenArgs {
  /** Text description of the image to generate. */
  prompt: string
  /** Aspect ratio; defaults to auto. */
  aspect_ratio?: string
}

/** Tool output: where the generated image was saved. */
export interface ImageGenOutput {
  filePath: string
  attachmentId: string | null
  mediaType: 'image/jpeg'
  aspectRatio: string
  model: string
}

/** Model-facing guidance for the aspect_ratio parameter, matching the CLI's own text. */
const ASPECT_RATIO_DESCRIPTION = "Aspect ratio of the generated image, decided from the user's request. Defaults to 'auto'. 1:1 for square (icons, profiles), 16:9 for wide (landscapes, cinematic), 9:16 for tall (phone wallpapers, stories), 3:2 for horizontal photos, 2:3 for vertical (portraits, posters)."

/**
 * Validate the schema-clean arguments a call carries; rejects a blank prompt or
 * an unknown aspect ratio that the model sent despite the schema.
 * @param args - the schema-validated arguments.
 * @returns the normalized aspect ratio (auto when absent).
 */
export function parseImageGenArgs(args: ImageGenArgs): { prompt: string; aspectRatio: string } {
  const prompt = args.prompt.trim()
  if (prompt.length === 0) throw new Error('image_gen: prompt must be a non-empty string')
  const aspectRatio = args.aspect_ratio ?? 'auto'
  if (!isAspectRatio(aspectRatio)) {
    throw new Error(`image_gen: unknown aspect_ratio "${aspectRatio}"`)
  }
  return { prompt, aspectRatio }
}

/**
 * Call-time presenter: a generic card naming the requested image.
 * @param args - the tool arguments; the prompt becomes the generic card's raw input.
 * @returns a generic call card.
 */
export function presentImageGenCall(args: ImageGenArgs): GenericCallView {
  return { card: 'generic', title: 'Generate image', kind: 'other', rawInput: args.prompt }
}

/**
 * Result-time presenter.
 * @param _args - the tool arguments.
 * @param result - the tool result; a failure falls back to the generic card.
 * @returns a generic result card.
 */
export function presentImageGenResult(_args: ImageGenArgs, result: ToolResult): GenericCallView {
  return { card: 'generic', title: result.isError ? 'Image generation failed' : 'Image generated' }
}

/**
 * Render the saved-generated-image text block the model reads.
 * @param value - the tool output naming where the image was saved.
 * @returns the model-facing text.
 */
export function formatImageGenOutput(value: ImageGenOutput): string {
  const attachment = value.attachmentId === null ? '' : ` (attachment ${value.attachmentId})`
  return `Saved generated image to ${value.filePath}${attachment}.`
}

/**
 * Register the image_gen tool and its system-prompt guidance into a context.
 * The tool reads the shared grok-credential service (a hard inject: without it
 * the plugin fiber is INACTIVE and apply never runs) and the optional
 * attachments store; the credential and any stored image bytes never enter
 * diagnostics or the tool result content.
 *
 * @param ctx - context whose tools/systemPrompt registries receive the tool; the
 *   registrations are effect-scoped and unregister on plugin dispose.
 * @param resolved - fully resolved plugin configuration.
 * @param fetchImpl - fetch implementation for the Imagine client; defaulted to
 *   the global fetch and injectable in tests.
 */
export function applyImageGenTool(ctx: Context, resolved: ResolvedConfig, fetchImpl: typeof fetch = fetch): void {
  const credentialSpec = resolveCredentialSpec(resolved)
  const managerFor = (): GrokSessionManager => ctx.grokCredential.managerFor(credentialSpec)

  ctx.systemPrompt.section({
    name: 'tool:image_gen',
    order: 115,
    text: 'Use the image_gen tool to generate a new image from a text description through the Grok subscription. It returns the absolute path where the image was saved; refer to the saved file when you tell the user where it landed. Generate multiple images with separate tool calls.',
  })

  ctx.tools.register(defineTool({
    name: IMAGE_GEN_TOOL_NAME,
    description: 'Generate a new image from a text description using the Grok Imagine API and save it to disk; returns the saved image path.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Text description of the image to generate.' },
      aspect_ratio: { type: 'string', enum: ['auto', '1:1', '16:9', '9:16', '3:2', '2:3'], description: ASPECT_RATIO_DESCRIPTION },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          filePath: { type: 'string', required: true },
          attachmentId: {
            required: true,
            oneOf: [
              { type: 'string' },
              { type: 'null' },
            ],
          },
          mediaType: { type: 'string', required: true, enum: ['image/jpeg'] },
          aspectRatio: { type: 'string', required: true },
          model: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatImageGenOutput(value) }],
    },
    timeoutMs: resolved.timeoutMs,
    // File-writing (and attachment) tool: not concurrency-safe, so the loop
    // serializes calls and the deterministic file counter cannot race.
    async execute(args: ImageGenArgs) {
      const input = parseImageGenArgs(args)
      const accessToken = await managerFor().accessToken()
      const client = new ImageGenClient({ baseUrl: resolved.baseURL, model: resolved.model, fetch: fetchImpl })
      const bytes = await client.generate(accessToken, input.prompt, input.aspectRatio)
      const store = ctx.get('attachments') ?? null
      const output = await persistGeneratedImage(store, bytes, 'image/jpeg', resolved.outputDirectory)
      return {
        filePath: output.filePath,
        attachmentId: output.attachmentId,
        mediaType: 'image/jpeg' as const,
        aspectRatio: input.aspectRatio,
        model: resolved.model,
      }
    },
    presentCall: presentImageGenCall,
    presentResult: presentImageGenResult,
  }))
}
