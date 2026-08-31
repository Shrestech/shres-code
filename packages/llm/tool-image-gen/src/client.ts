/**
 * HTTP client for the Grok Build Imagine image-generation endpoint. It mirrors
 * the open-source Grok CLI's image_gen wire exactly: the `POST
 * {base}/images/generations` path, the request body fields, and the `Bearer
 * <session access token>` authorization header. The access token is the same
 * subscription JWT grok-session serves; no XAI_API_KEY and no CLI spawn are
 * involved. Error handling adds named harness codes over the CLI's behavior.
 * Tokens and full response payloads never reach diagnostics.
 * @module @shres-code/shres-code-tool-image-gen/client
 */

import { LlmError } from '@shres-code/shres-code-llm'

/** Aspect ratios the Imagine API accepts, in the CLI's documented set. */
export const ASPECT_RATIOS = ['auto', '1:1', '16:9', '9:16', '3:2', '2:3'] as const

/** One accepted aspect-ratio token. */
export type AspectRatio = (typeof ASPECT_RATIOS)[number]

/**
 * Whether a value names an accepted aspect ratio.
 * @param value - the candidate ratio token.
 * @returns true when {@link ASPECT_RATIOS} contains it.
 */
export function isAspectRatio(value: string): value is AspectRatio {
  return (ASPECT_RATIOS as readonly string[]).includes(value)
}

/** Strict canonical base64 (RFC 4648 with padding), matching the CLI's STANDARD decoder. */
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

/** One decoded image in the Imagine response. */
export interface ImageGenResponseData {
  b64_json?: string
}

/** The parsed Imagine generation response: images in `data`. */
export interface ImageGenResponse {
  data?: ImageGenResponseData[]
}

/** Wire client construction facts. */
export interface ImageGenClientOptions {
  /** API base including the version prefix, e.g. `https://api.x.ai/v1`. */
  baseUrl: string
  /** Imagine model id, e.g. `grok-imagine-image-quality`. */
  model: string
  /** Fetch implementation; defaults to the global fetch (tests inject a stub). */
  fetch?: typeof fetch
}

/** Client for the Grok Build Imagine image-generation API. */
export class ImageGenClient {
  private readonly baseUrl: string
  private readonly model: string
  private readonly fetchImpl: typeof fetch

  constructor(options: ImageGenClientOptions) {
    this.baseUrl = options.baseUrl
    this.model = options.model
    this.fetchImpl = options.fetch ?? fetch
  }

  /**
   * Generate one image from a prompt. The request mirrors the CLI's image_gen
   * wire: model, prompt, n=1, aspect_ratio, resolution 1k, and
   * response_format b64_json, authorized by the session access token as a
   * bearer. Returns the decoded image bytes.
   * @param accessToken - the Grok subscription session access token (JWT).
   * @param prompt - the text description of the image.
   * @param aspectRatio - one of the accepted aspect ratios; defaults to auto.
   * @returns the decoded image bytes.
   */
  async generate(
    accessToken: string,
    prompt: string,
    aspectRatio: string,
  ): Promise<Uint8Array> {
    const url = `${this.baseUrl.replace(/\/$/u, '')}/images/generations`
    const body = JSON.stringify({
      model: this.model,
      prompt,
      n: 1,
      aspect_ratio: aspectRatio,
      resolution: '1k',
      response_format: 'b64_json',
    })
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    }

    let response: Response
    try {
      response = await this.fetchImpl(url, { method: 'POST', headers, body })
    } catch (error) {
      throw new LlmError(`image_gen: Imagine API request failed: ${String(error)}`, 'IMAGE_GEN_NETWORK')
    }

    if (response.status === 401) {
      throw new LlmError(
        'image_gen: the Imagine API rejected the Grok subscription session credential (HTTP 401); run "grok login" to refresh the session document',
        'IMAGE_GEN_AUTH_FAILED',
      )
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200)
      throw new LlmError(
        `image_gen: Imagine generation failed with HTTP ${response.status}: ${detail}`,
        'IMAGE_GEN_HTTP',
      )
    }

    let parsed: ImageGenResponse
    try {
      parsed = (await response.json()) as ImageGenResponse
    } catch {
      throw new LlmError('image_gen: the Imagine API returned an unparseable response', 'IMAGE_GEN_BAD_RESPONSE')
    }
    const b64 = parsed.data?.[0]?.b64_json
    if (typeof b64 !== 'string' || b64.length === 0) {
      throw new LlmError('image_gen: Imagine generation returned no image data', 'IMAGE_GEN_BAD_RESPONSE')
    }
    if (!STRICT_BASE64.test(b64)) {
      throw new LlmError('image_gen: Imagine returned invalid base64 image data', 'IMAGE_GEN_BAD_RESPONSE')
    }
    return Buffer.from(b64, 'base64')
  }
}
