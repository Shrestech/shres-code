/**
 * Answering "which models can this provider serve?" for the configuration
 * surface's "fetch available models" action.
 *
 * A route the installed pi-ai catalog ships is answered **from that catalog**,
 * with no network call at all — except OpenRouter, whose `GET /models` listing
 * discloses `architecture.input_modalities` (and context length) the pinned
 * catalog does not keep current. Only a route the catalog does not describe,
 * or OpenRouter, is interrogated over the wire.
 *
 * Neither path is a catalog refresh. Nothing here is stored: the request
 * carries a draft the user is still editing, and the reply is candidate
 * metadata the surface offers for adoption. `settings.yaml` remains the only
 * thing that decides what a route serves.
 *
 * Both paths also carry declared input modalities when the source discloses
 * them — the installed catalog always does; a listing endpoint does through
 * OpenRouter's `architecture.input_modalities`, and an Ollama origin (Cloud,
 * local `:11434`, or an `ollama*` provider route) additionally answers
 * `POST /api/show` per listed id, because `GET /models` and `GET /api/tags`
 * disclose none. `/api/show` is enrichment, never a second listing: a miss,
 * a malformed body, or caller abort while it is in flight leaves that row
 * as the listing returned it, and never fails the interrogation. Endpoints
 * that disclose nothing still inherit the route's `defaultInput`. OpenRouter
 * rows additionally carry their declared audio directions as display-only
 * `audioInput`/`audioOutput` answers; audio never joins the chat modality
 * vocabulary.
 *
 * Only OpenAI-compatible protocols are interrogated. Their listing is the one
 * shape a gateway, a self-hosted server, and the official endpoints all agree
 * on, which is the case this action exists for; every other protocol reports
 * that it cannot be interrogated so the surface falls back to hand-entry
 * rather than guessing a response shape.
 *
 * @module shres-llm-pi-ai/discovery
 */

import { INVALID_CREDENTIAL_CODE, LlmError, normalizeApiKey } from '@shres-code/shres-code-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@shres-code/shres-code-llm'
import { attributionHeaders } from '@shres-code/shres-code-llm'
import { MODALITIES, catalogModels, catalogProvider } from './catalog.ts'
import type { PiAiModality } from './catalog.ts'

/**
 * Protocols whose model listing this module can read: the two that speak
 * OpenAI's `GET /models` shape with bearer auth. Azure is absent despite its
 * OpenAI lineage — it authenticates with an `api-key` header and requires an
 * `api-version` query — and Codex authenticates through OAuth; guessing at
 * either would report an authentication failure as a provider with no models.
 * pi-ai's remaining protocols are absent for the same reason.
 */
const LISTABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  'openai-completions',
  'openai-responses',
])

/**
 * Parallel `/api/show` probes per listing. Ollama Cloud's public catalog is
 * tens of models, not hundreds; eight keeps the enrichment inside a fetch
 * click without serializing every probe.
 */
const SHOW_CONCURRENCY = 8

/** Ollama's documented default listen port, used to recognize a local host. */
const OLLAMA_PORT = '11434'

/**
 * Endpoint replies larger than this are refused. The endpoint is whatever URL
 * the user typed, so the ceiling holds on the bytes actually read rather than
 * on the length the server claims — the same two-stage shape `shres-web-fetch`
 * uses for its own caller-supplied URLs, except that a truncated model listing
 * is not parseable, so overflow rejects instead of truncating.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** One entry of an OpenAI-compatible `GET /models` reply. */
interface ListingEntry {
  id?: unknown
  /** Common gateway extensions; absent from the official listings. */
  name?: unknown
  display_name?: unknown
  context_window?: unknown
  context_length?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
  /** OpenRouter's per-model architecture block; absent elsewhere. */
  architecture?: unknown
  /** OpenRouter nests the output cap here; absent from the official OpenAI listing. */
  top_provider?: unknown
}
/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** A non-empty string field of a listing entry, or `undefined`. */
function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * The declared input modalities of a listing entry's OpenRouter-style
 * `architecture.input_modalities`, narrowed to the harness vocabulary: values
 * outside it (video, file, audio) describe requests this harness never
 * constructs, so they are dropped rather than carried. Absent block, a
 * non-array value, and an all-unknown list all state no answer — `undefined` —
 * so adoption inherits the route's catalog or `defaultInput` fallback instead
 * of a claim the endpoint never made.
 * @param entry - one raw listing row.
 * @returns the declared modalities, or `undefined` when the row discloses none.
 */
function listingInput(entry: ListingEntry): readonly PiAiModality[] | undefined {
  const modalities = (entry.architecture as { input_modalities?: unknown } | null)?.input_modalities
  if (!Array.isArray(modalities)) return undefined
  const known = modalities.filter((m): m is PiAiModality => (MODALITIES as readonly unknown[]).includes(m))
  return known.length === 0 ? undefined : known
}

/**
 * The declared audio modalities of a listing entry's OpenRouter-style
 * `architecture` block: `input_modalities` containing `audio` names a
 * speech-to-text model, `output_modalities` containing `audio` a
 * text-to-speech one. Audio never joins the chat {@link PiAiModality}
 * vocabulary — the conversation never constructs audio parts — so these are
 * display-only answers carried beside `input`.
 * @param entry - one raw listing row.
 * @returns the declared audio answers; both false when the row discloses none.
 */
function listingAudio(entry: ListingEntry): { input: boolean; output: boolean } {
  const architecture = entry.architecture as
    | { input_modalities?: unknown; output_modalities?: unknown }
    | null
  const declares = (modalities: unknown): boolean =>
    Array.isArray(modalities) && modalities.includes('audio')
  return {
    input: declares(architecture?.input_modalities),
    output: declares(architecture?.output_modalities),
  }
}

/**
 * Whether this interrogation should ask Ollama's native `/api/show` after the
 * OpenAI-compatible listing. `GET /models` on ollama.com and a local daemon
 * returns ids only; capabilities live on `/api/show`. The probe is confined to
 * origins that already identify as Ollama so a random gateway is not POSTed
 * at `/api/show`.
 * @param baseURL - the OpenAI-compatible base, including `/v1`.
 * @param provider - the draft route key, when the surface named one.
 * @returns whether `/api/show` enrichment should run.
 */
function looksLikeOllama(baseURL: string, provider: string | undefined): boolean {
  if (provider !== undefined && provider.startsWith('ollama')) return true
  try {
    const url = new URL(baseURL)
    const host = url.hostname.toLowerCase()
    if (host === 'ollama.com' || host.endsWith('.ollama.com')) return true
    return url.port === OLLAMA_PORT
  } catch {
    // A baseURL that is not a URL still concatenates as a listing prefix; it
    // is not an Ollama host we can name.
    return false
  }
}

/**
 * Native Ollama origin for `/api/show`. The OpenAI-compatible base ends in
 * `/v1`; the native API sits on the same host without that suffix.
 * @param baseURL - the OpenAI-compatible base, including `/v1`.
 * @returns `{origin}/api/show`.
 */
function ollamaShowUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '').replace(/\/v1$/i, '')}/api/show`
}

/**
 * Chat input modalities from an `/api/show` `capabilities` list. `vision`
 * means images; any of `completion`, `chat`, `tools`, or `thinking` without
 * `vision` is text. An embedding-only or unreadable list states no chat
 * answer, so adoption keeps inheriting rather than claiming text.
 * @param capabilities - the show reply's `capabilities` field.
 * @returns the declared modalities, or `undefined` when the row discloses none.
 */
function showInput(capabilities: unknown): readonly PiAiModality[] | undefined {
  if (!Array.isArray(capabilities)) return undefined
  const names = capabilities.filter((value): value is string => typeof value === 'string')
  if (names.length === 0) return undefined
  if (names.includes('vision')) return ['text', 'image']
  if (names.some(name => name === 'completion' || name === 'chat' || name === 'tools' || name === 'thinking')) {
    return ['text']
  }
  return undefined
}

/**
 * Context window from `/api/show` `model_info`. Ollama stores it as
 * `{architecture}.context_length`.
 * @param info - the show reply's `model_info` object.
 * @returns a positive integer window, or `undefined` when absent.
 */
function showContextWindow(info: unknown): number | undefined {
  if (info === null || typeof info !== 'object') return undefined
  for (const [key, value] of Object.entries(info as Record<string, unknown>)) {
    if ((key === 'context_length' || key.endsWith('.context_length'))
      && typeof value === 'number' && Number.isInteger(value) && value > 0) {
      return value
    }
  }
  return undefined
}

/**
 * Best-effort `POST /api/show` for one model. Every failure — network, non-2xx,
 * oversized, non-JSON, abort — returns `undefined` so the listing row stands.
 * @param url - native `/api/show` URL.
 * @param id - model id from the listing.
 * @param apiKey - bearer token, when the listing used one.
 * @param signal - caller cancellation.
 * @returns parsed JSON, or `undefined` when the probe cannot be used.
 */
async function showModel(
  url: string,
  id: string,
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
): Promise<unknown | undefined> {
  if (signal?.aborted) return undefined
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
        ...attributionHeaders(),
      },
      body: JSON.stringify({ model: id }),
      ...signal === undefined ? {} : { signal },
    })
  } catch {
    // Abort, DNS, connect, or a header TypeError: the listing already
    // succeeded, so this row stays as GET /models returned it.
    return undefined
  }
  if (!response.ok) {
    /* v8 ignore next -- fetch exposes a body stream on an error Response; cancel is cleanup. */
    await response.body?.cancel().catch(() => {
      // Best-effort drain of a refused show body; the listing already succeeded.
    })
    return undefined
  }
  try {
    return JSON.parse(await readBounded(response, url))
  } catch {
    // Oversized, aborted mid-body, or non-JSON: skip this row's enrichment.
    return undefined
  }
}

/**
 * Fill listing rows that disclosed no `input` or `contextWindow` from Ollama
 * `/api/show`. Parallelism is bounded; abort or a per-row miss leaves that
 * row as the listing returned it.
 * @param models - OpenAI-compatible listing rows.
 * @param baseURL - the OpenAI-compatible base.
 * @param apiKey - bearer token used for the listing, when any.
 * @param signal - caller cancellation.
 * @returns the same rows, with show-declared fields filled where missing.
 */
async function enrichFromOllamaShow(
  models: LlmDiscoveredModel[],
  baseURL: string,
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
): Promise<LlmDiscoveredModel[]> {
  const pending = models.flatMap((model, index) =>
    model.input === undefined || model.contextWindow === undefined ? [{ model, index }] : [])
  if (pending.length === 0) return models
  const url = ollamaShowUrl(baseURL)
  const results = [...models]
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = pending[cursor++]
      if (next === undefined) return
      const body = await showModel(url, next.model.id, apiKey, signal)
      if (body === null || typeof body !== 'object') continue
      const shown = body as { capabilities?: unknown; model_info?: unknown }
      const input = showInput(shown.capabilities)
      const contextWindow = showContextWindow(shown.model_info)
      const current = results[next.index]
      /* v8 ignore next -- pending indexes are listing rows this function still owns. */
      if (current === undefined) continue
      results[next.index] = {
        ...current,
        ...current.input === undefined && input !== undefined ? { input } : {},
        ...current.contextWindow === undefined && contextWindow !== undefined
          ? { contextWindow } : {},
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(SHOW_CONCURRENCY, pending.length) },
    () => worker(),
  ))
  return results
}

/**
 * Join the endpoint base with the listing path. The base is treated as a
 * prefix rather than a URL to resolve against, so a deployment path such as
 * `https://gateway.example/openai/v1` keeps its segments instead of losing
 * them to `URL` resolution.
 */
function listingUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/models`
}

/**
 * Whether this interrogation should skip the installed catalog and read
 * OpenRouter's live `GET /models`. That listing always carries
 * `architecture.input_modalities`; the pinned catalog does not stay current
 * (Muse Spark and similar never appear there). A random catalog route still
 * answers from the registry — its listing usually discloses ids only.
 * @param provider - the draft route key, when the surface named one.
 * @param baseURL - the OpenAI-compatible base, when the form shows one.
 * @returns whether to interrogate OpenRouter over the wire.
 */
function isOpenRouter(provider: string | undefined, baseURL: string | undefined): boolean {
  if (provider === 'openrouter') return true
  if (baseURL === undefined || baseURL.length === 0) return false
  try {
    const host = new URL(baseURL).hostname.toLowerCase()
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai')
  } catch {
    return false
  }
}

/**
 * Endpoint to interrogate. An OpenRouter card often has no `baseURL` in
 * settings (the catalog default is the endpoint); Fetch still has to hit it.
 * @param provider - the draft route key, when the surface named one.
 * @param baseURL - the form's endpoint, when shown.
 * @returns the OpenAI-compatible base, or `undefined` when none can be named.
 */
function resolveDiscoveryBaseURL(provider: string | undefined, baseURL: string | undefined): string | undefined {
  if (baseURL !== undefined && baseURL.length > 0) return baseURL
  if (provider === 'openrouter') return catalogProvider(provider)?.baseUrl
  return undefined
}

/**
 * Read a reply body, refusing one that outgrows the ceiling. A declared length
 * is checked first so an honest server is turned away without transferring
 * anything; the accumulated total is what actually enforces the bound, because
 * a server that under-declares (or streams) tells us nothing up front.
 */
async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from
      // an oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * Read one OpenAI-compatible listing reply. Entries without a usable id are
 * skipped rather than failing the whole interrogation: a single malformed row
 * should not deny the user the rest of a working endpoint's catalog.
 */
function readListing(body: unknown): LlmDiscoveredModel[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) {
    throw new LlmError(
      'the endpoint\'s model listing has no "data" array; enter this provider\'s models by hand',
      'DISCOVERY_FAILED',
    )
  }
  const models: LlmDiscoveredModel[] = []
  for (const raw of data) {
    const entry = raw as ListingEntry | null
    if (entry === null) continue
    const id = label(entry.id)
    if (id === undefined) continue
    const name = label(entry.name, entry.display_name)
    const contextWindow = capacity(entry.context_window, entry.context_length)
    const nestedMax = (entry.top_provider as { max_completion_tokens?: unknown } | null)?.max_completion_tokens
    const maxTokens = capacity(entry.max_output_tokens, entry.max_tokens, nestedMax)
    const input = listingInput(entry)
    const audio = listingAudio(entry)
    models.push({
      id,
      ...name === undefined ? {} : { name },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...input === undefined ? {} : { input },
      ...audio.input ? { audioInput: true } : {},
      ...audio.output ? { audioOutput: true } : {},
    })
  }
  return models
}

/**
 * Accept one probe key, or refuse it before the header is built. Without this
 * the `fetch` below would throw a ByteString `TypeError` that this function's
 * catch reports as `could not reach <url>` — blaming the network for a local,
 * deterministic fault.
 * @param raw - the key typed into the form or read from storage.
 * @returns the trimmed, usable key.
 */
function usableProbeKey(raw: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? 'this provider\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this provider\'s API key contains characters no HTTP header can carry; paste the raw key only',
    INVALID_CREDENTIAL_CODE,
  )
}

/**
 * Interrogate one draft provider endpoint for the models it advertises.
 * @param request - the endpoint, protocol, and one-shot credential to use.
 * @param storedApiKey - the credential the named route already stored, asked
 *   for only when the draft carries none and only on the path that reaches the
 *   network. A configuration surface never holds a stored secret — it edits a
 *   redacted descriptor — so without this an already-configured route would be
 *   interrogated unauthenticated and answer 401.
 * @returns the advertised models in endpoint order.
 * @throws LlmError when the protocol has no readable listing, the endpoint
 *   refuses or fails the request, or the reply is not a model listing.
 */
export async function discoverModels(
  request: LlmModelDiscoveryRequest,
  storedApiKey?: () => Promise<string | undefined>,
): Promise<readonly LlmDiscoveredModel[]> {
  // A catalog route already has its answer, and a better one: the installed
  // entries carry context windows and output caps no listing endpoint reports.
  // OpenRouter is the exception: its listing discloses modalities the pinned
  // catalog does not keep current, and Fetch on that card often sends no
  // baseURL (the catalog default is the endpoint).
  if (request.provider !== undefined && !isOpenRouter(request.provider, request.baseURL)) {
    const installed = catalogModels(request.provider)
    if (installed.size > 0) {
      return [...installed.values()].map(model => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: model.input,
      }))
    }
  }
  const baseURL = resolveDiscoveryBaseURL(request.provider, request.baseURL)
  if (baseURL === undefined || baseURL.length === 0) {
    throw new LlmError(
      `pi-ai ships no catalog for provider "${request.provider ?? ''}", so its models can only come from its`
      + " endpoint; set a baseURL, or enter this provider's models by hand",
      'DISCOVERY_FAILED',
    )
  }
  // A draft that has not chosen a protocol yet is asked as OpenAI Chat
  // Completions: it is the shape a gateway is overwhelmingly likely to speak,
  // and the alternative — refusing until the field is filled — would withhold
  // the action from the case it exists for. The cost is a misdirected message
  // when the endpoint speaks something else (an Anthropic gateway answers 401,
  // which reads as a credential problem), and hand-entry remains the way out.
  const api = request.api ?? 'openai-completions'
  if (!LISTABLE_PROTOCOLS.has(api)) {
    throw new LlmError(
      `pi-ai protocol "${api}" has no model listing this build can read; enter this provider's models by hand`,
      'DISCOVERY_UNSUPPORTED',
    )
  }
  const url = listingUrl(baseURL)
  // A key typed into the form wins: it is the one the user is testing, and it
  // may be the replacement for exactly the stored key that is failing. The
  // stored one is only asked for here, past the catalog short-circuit and the
  // protocol check, so a route answered from the registry costs no credential
  // lookup — and no diagnostic about a credential it never needed.
  // A probe carrying no key stays unauthenticated, which is how a route that
  // relies on the provider's own ambient discovery is meant to be asked.
  const supplied = request.apiKey ?? await storedApiKey?.()
  const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
        ...attributionHeaders(),
      },
      ...request.signal === undefined ? {} : { signal: request.signal },
    })
  } catch (error: unknown) {
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    throw new LlmError(
      `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
    )
  }
  let text: string
  try {
    text = await readBounded(response, url)
  } catch (error: unknown) {
    // Cancellation during the body read rejects with the abort reason, which
    // may be any value; the caller gets the same coded failure it would have
    // for a cancellation before the request went out.
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw error
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  const models = readListing(body)
  // Ollama's OpenAI-compatible listing is ids only. `/api/show` is where
  // vision and context_length live; a miss must not fail a listing that
  // already succeeded (first-run's 1.5s probe would otherwise flip reachable
  // to false because enrichment overran).
  if (!looksLikeOllama(baseURL, request.provider)) return models
  return await enrichFromOllamaShow(models, baseURL, apiKey, request.signal)
}
