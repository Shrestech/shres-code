# Agent Note: Unified normalized attachments and DeepSeek request images

Status: implemented

## Problem

Durable image history, provider resolution, inline request size, and remote file reuse have different limits. Treating an admitted image as the bytes sent on every later request forced one byte cap and one raster to serve all four concerns. Large but ordinary input was refused, clean 16-bit PNG could pass into history and fail at DeepSeek, repeated base64 expanded long requests, and a provider rejection repeated because the same durable image stayed in every future request.

Shres already stored admitted bytes and could detect which models accept images. The native DeepSeek adapter still rejected image content, so a composer attach that looked allowed died at request time on `deepseek-official`.

## Decision

The image path has two explicit versions. The attachment backend owns a provider-independent durable normalized attachment. Each image-capable model route owns a deterministic request policy, and the attachment backend derives and caches the exact request version from that attachment. Session history contains only the normalized attachment reference; inline bytes and provider file ids remain transient request projections.

Admission accepts ordinary large sources under configurable pixel, dimension, and source-byte limits, then normalizes to 8-bit sRGB/sRGBA with a long-edge cap. `readImageRequest` projects that attachment to the route's pixel and encoded-byte budget. The `deepseek-official` adapter uploads retained request versions through the OpenAI-compatible Files API and sends `file_id` blocks, with a bounded inline fallback when file resolution fails. The default catalog advertises `deepseek-v4-flash-vision-exp` as image-capable. Text-only routes receive deterministic attachment placeholders; durable history keeps the original references.

Shres discovery and composer gating stay in charge of *which models the user may attach to*. OpenRouter `architecture.input_modalities`, the vision chip, and the composer refuse-on-known-text-only path are unchanged. DeepSeek vision is an additional catalog fact plus a send path.

## Alternatives considered

**Use one 1MiB normalized attachment for storage and requests.** This makes model resolution determine durable image detail and combines local storage, inline expansion, Files quota, and model pixels into one setting.

**Keep DeepSeek data URLs as the primary transport.** Inline base64 repeats bytes on every request and caps usable image history by request-body size.

**Refuse text-only model selection after any image.** Durable history can outlive the model that first consumed it. Request-local placeholders keep the session usable without rewriting history.

**Replace shres modality autodetect with catalog-only flags.** Rejected: OpenRouter discovery and composer gating are the product-user path for non-DeepSeek routes; the pipeline only needs them to agree on `inputModalities`.

## Consequences

Normalized attachments consume up to the independent local safety cap, while request caches and remote Files consume additional derived storage. DeepSeek image requests prefer Files reuse; file-resolution failures use the smaller inline budget. Unlisted DeepSeek model ids remain text-only so the host does not persist image input an unknown endpoint may reject.

## Testing

Attachment-local tests cover normalization, request-image derivation, and batch admission. `llm-deepseek` serialize, adapter, files-api, file-store, and upload-index tests pin Files upload, inline fallback, stale-id recovery, and text-only rejection. `llm` content tests pin request offload and text-only placeholders.
