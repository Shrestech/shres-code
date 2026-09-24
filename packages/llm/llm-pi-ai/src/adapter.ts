/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles plus a
 * `Models` collection holding the `Provider` each route built — and an
 * operation captures a whole snapshot before its first `await`. A
 * configuration change builds a *new* collection rather than mutating the one
 * in use, because `Models.streamSimple()` is lazy: it resolves the provider
 * when the stream is first consumed, which is after the credential await, so a
 * mutated collection would let a request that started under one configuration
 * finish under another — or fail with a provider that no longer exists. This is
 * what makes the seam's per-step call freeze (`llm.prepareCall()`) hold all the
 * way down: switching models mid-reply takes effect on the next step, never
 * inside the one in flight.
 *
 * Credentials stay outside that collection. The harness resolves a route's key
 * through its own seam and passes it as the request's `apiKey` option, which
 * pi-ai treats as the highest-priority auth override — so `Models` never holds
 * a credential store and the harness keeps its fail-loud reference semantics.
 *
 * @module shres-llm-pi-ai/adapter
 */

import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type {
  Api,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@shres-code/shres-code-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  LlmThinkingMode,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@shres-code/shres-code-llm'
import type { AttachmentStore } from '@shres-code/shres-code-attachment'
import { idleWatchdog, timeoutOf } from '@shres-code/shres-code-timeout'
import type { HostedTool } from '@shres-code/shres-code-llm'
import { resolveCacheUsage } from './config.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { toPiContext } from './context.ts'
import { applyHostedToolsPayload, hostedToolsDialectFor, mapHostedToolCalls } from './hosted-tools/index.ts'
import type { HostedToolsPlan } from './hosted-tools/index.ts'
import { PROMPT_CACHE_KEY_FIELDS, SILENT_OVERFLOW_PROTOCOLS } from './provider.ts'
import { toStreamChunks } from './stream.ts'

/** One resolution's frozen view: the profiles and the collection built from them. */
interface PiAiSnapshot {
  /** The resolved profiles this collection was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
}

/** Constructor options for {@link PiAiAdapter}: the resolution and observation hooks the route's owner supplies. */
export interface PiAiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /**
   * Observe one assistant history message degrading to provider-neutral
   * conversion because its stored replay state is unusable by this build.
   */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
  /**
   * Rewrite one outgoing provider request payload before it is sent. pi-ai
   * hands the hook the request body it built for the model, together with the
   * provider, the model, and the session this request belongs to; returning a
   * value replaces it and returning `undefined` keeps it (which still lets the
   * hook mutate the body in place).
   *
   * Deployment-owned, and the escape hatch for a vendor request field this
   * package does not model: a route can splice provider-specific fields such as
   * xAI's `service_tier`, or a cache-key spelling
   * {@link PROMPT_CACHE_KEY_FIELDS} does not cover. The hook runs last, after
   * the hosted-tools and prompt-cache-key splices, so it observes the final
   * body.
   */
  onPayload?: (payload: unknown, request: PiAiPayloadRequest) => unknown
  /**
   * Prompt-cache lifetime to declare on one model's metadata, in milliseconds,
   * or `undefined` to declare none. The route's owner supplies it because only
   * the owner knows which upstream serves the route and how long that upstream
   * keeps a prefix; the protocol alone does not determine it.
   */
  promptCacheTtlMs?: (provider: string, model: string) => number | undefined
}

/**
 * The request one {@link PiAiAdapterOptions.onPayload | payload hook} observes.
 *
 * The session id is derived from the seam's own `GenerateOptions.sessionId`
 * rather than restated, so the brand and the optionality cannot drift from the
 * field this context mirrors.
 */
export interface PiAiPayloadRequest {
  /** Provider route key selecting the profile that built this request. */
  provider: string
  /** Exact model id the request names (`GenerateOptions.model`). */
  model: string
  /** Session the request belongs to; absent for a call the loop did not stamp. */
  sessionId?: GenerateOptions['sessionId']
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
  onPayload?: SimpleStreamOptions['onPayload'],
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    ...onPayload === undefined ? {} : { onPayload },
    maxRetries: 0,
  }
}

/**
 * Reclassify a terminal error finish as caller abort.
 * @param chunk - one translated stream chunk.
 * @returns an abort finish when `chunk` is an error finish, otherwise `chunk`.
 */
function errorFinishAsCallerAbort(chunk: StreamChunk): StreamChunk {
  if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') return chunk
  return {
    ...chunk,
    reason: {
      kind: 'aborted',
      failure: { message: 'pi-ai request aborted by caller', code: 'ABORTED' },
    },
  }
}

/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the profile's configured level, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * The temperature fact pi-ai's request builder acts on. An Anthropic-protocol
 * model whose compat declares `supportsTemperature: false` has a stated
 * temperature omitted from the request without any error, so the route
 * declares that refusal instead of letting a caller's value vanish.
 * @param model - the resolved pi-ai model.
 * @returns `{ acceptsTemperature: false }` for that refusal, otherwise nothing.
 */
function temperatureInfo(model: Model<Api>): { acceptsTemperature?: false } {
  if (model.api !== 'anthropic-messages') return {}
  // Model<Api>'s compat is a union over every protocol; the api check selects Anthropic's.
  const compat = model.compat as { supportsTemperature?: boolean } | undefined
  return compat?.supportsTemperature === false ? { acceptsTemperature: false } : {}
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the collection those profiles built.
 */
export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    const models: MutableModels = createModels()
    for (const profile of profiles.values()) models.setProvider(profile.piProvider)
    this.snapshot = { profiles, models }
    return this.snapshot
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    this.profileOf(snapshot, provider)
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  /**
   * The splice plan for one model's effective hosted tools, derived from the
   * resolved profile declaration and the model's wire dialect. `undefined`
   * leaves the request on the local tool catalog.
   * @param profile - the route's resolved profile.
   * @param model - the resolved model descriptor, for its wire protocol.
   * @param modelId - the model id the declaration resolved under.
   * @returns the dialect's splice plan, or `undefined` when none are declared.
   */
  private hostedPlanOf(
    profile: ResolvedPiAiProviderProfile,
    model: Model<Api>,
    modelId: string,
  ): HostedToolsPlan | undefined {
    const tools = profile.hostedTools.get(modelId)
    if (tools === undefined || tools.length === 0) return undefined
    return hostedToolsDialectFor(model.api)?.spliceFor(tools)
  }

  /** The advertised hosted-tool field for one model, or nothing to declare none. */
  private hostedToolsOf(
    profile: ResolvedPiAiProviderProfile,
    modelId: string,
  ): { hostedTools: readonly HostedTool[] } | Record<string, never> {
    const tools = profile.hostedTools.get(modelId)
    return tools === undefined ? {} : { hostedTools: [...tools] }
  }

  /**
   * The thinking mode an Anthropic Messages route runs, or nothing for other
   * protocols: pi-ai sends adaptive thinking to a model whose compat sets
   * `forceAdaptiveThinking`, a fixed thinking budget to any other reasoning
   * model, and no thinking to a non-reasoning one.
   */
  private thinkingModeOf(model: Model<Api>): { thinkingMode: LlmThinkingMode } | Record<string, never> {
    if (model.api !== 'anthropic-messages') return {}
    if (!model.reasoning) return { thinkingMode: 'none' }
    const compat = model.compat as { forceAdaptiveThinking?: boolean } | undefined
    return { thinkingMode: compat?.forceAdaptiveThinking === true ? 'adaptive' : 'budget' }
  }

  /** The owner-declared prompt-cache lifetime for one model, or nothing to declare none. */
  private promptCacheTtlOf(
    provider: string,
    modelId: string,
  ): { promptCacheTtlMs: number } | Record<string, never> {
    const ttl = this.config.promptCacheTtlMs?.(provider, modelId)
    return ttl === undefined ? {} : { promptCacheTtlMs: ttl }
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      const profile = this.profileOf(snapshot, provider)
      return snapshot.models.getModels(provider).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
        ...this.hostedToolsOf(profile, model.id),
        ...this.promptCacheTtlOf(provider, model.id),
        ...this.thinkingModeOf(model),
      }))
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      const profile = this.profileOf(snapshot, provider)
      const resolvedModel = this.modelOf(snapshot, provider, model)
      const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
      // Only a cap the deployment configured is a request default; the
      // catalog's `maxTokens` sizes the model and stops there.
      const configuredMaxTokens = profile.configuredMaxTokens.get(model)
      return {
        provider,
        id: model,
        name: resolvedModel.name,
        inputModalities: [...resolvedModel.input],
        ...this.hostedToolsOf(profile, model),
        ...this.promptCacheTtlOf(provider, model),
        ...this.thinkingModeOf(resolvedModel),
        context: { contextWindow: resolvedModel.contextWindow },
        ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
        ...reasoningInfo(resolvedModel, defaultLevel),
        ...temperatureInfo(resolvedModel),
      }
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the collection all come from the same immutable
    // snapshot, and the credential freezes with them. A configuration change
    // mid-request builds a separate snapshot, so this request finishes under
    // the one it started with and the next call picks up the new one.
    const snapshot = this.current()
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? profile.reasoning,
    )
    const cacheUsage = resolveCacheUsage(profile.cacheUsage, model.api)
    const apiKey = await this.config.resolveApiKey(options.provider, profile)
    const hosted = this.hostedPlanOf(profile, model, options.model)
    // Whether a cache key goes out is decided per request for the model actually
    // being sent: one route's catalog can span protocols, so the field is looked
    // up on the resolved model's protocol, never on the route. A profile asking
    // for session affinity on a protocol that declares no such field sends
    // nothing, which is not an error; a request with no session id has no key to
    // send either.
    const cacheKeyField = profile.promptCacheKey === 'session'
      ? PROMPT_CACHE_KEY_FIELDS[model.api]
      : undefined
    const cacheKey = cacheKeyField === undefined || options.sessionId === undefined
      ? undefined
      : { field: cacheKeyField, value: String(options.sessionId) }

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const onReplayDegrade = (reason: string): void => {
        this.config.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }
      const context = attachments === undefined
        ? toPiContext(options, undefined, onReplayDegrade)
        : await toPiContext(options, attachments, onReplayDegrade)
      // Everything this package splices rides pi-ai's one payload hook, in
      // order: hosted tools, then the vendor prompt cache key, then the route's
      // own onPayload hook. Splicing here (rather than forking pi-ai) keeps the
      // shared adapter on the stock dependency, and chaining the results keeps
      // every effect on the one payload pi-ai sends — the deployment hook last,
      // so it observes the final body. Only a final non-undefined result
      // replaces the outgoing payload; a hook that mutates in place and
      // returns undefined keeps its own mutation.
      const onPayload = hosted === undefined && cacheKey === undefined && this.config.onPayload === undefined
        ? undefined
        : (payload: unknown): unknown => {
          let current = payload
          if (hosted !== undefined) {
            const spliced = applyHostedToolsPayload(current, hosted)
            if (spliced !== undefined) current = spliced
          }
          if (cacheKey !== undefined) {
            // Spreading is the whole splice: pi-ai hands the hook the request
            // params object it built and is about to serialize, so the body
            // needs no shape inspection the way the hosted-tools splice does.
            current = { ...(current as Record<string, unknown>), [cacheKey.field]: cacheKey.value }
          }
          if (this.config.onPayload !== undefined) {
            const result = this.config.onPayload(current, {
              provider: options.provider,
              model: model.id,
              ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
            })
            if (result !== undefined) current = result
          }
          return current === payload ? undefined : current
        }
      const events = snapshot.models.streamSimple(model, context, {
        ...profileOptions(profile, reasoning, apiKey, onPayload),
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: watchdog.signal,
        // Profile headers are deployment-owned; attribution names are
        // Harness-owned and therefore win collisions.
        headers: requestHeaders(profile.headers),
      })
      // A hosted tool pi-ai surfaces as an ordinary tool call must be promoted
      // to a server-tool-call block here, the adapter seam that knows the
      // route's hosted names, so the loop structurally never dispatches it.
      const hostedNames = hosted === undefined || hosted.callNames.length === 0
        ? undefined
        : new Set(hosted.callNames)
      // Usage-based overflow detection is scoped to the protocols whose
      // provider can accept an oversized prompt silently.
      const translated = toStreamChunks(
        events,
        cacheUsage,
        SILENT_OVERFLOW_PROTOCOLS.has(model.api) ? model.contextWindow : undefined,
      )
      const iterator = hostedNames === undefined
        ? translated[Symbol.asyncIterator]()
        : mapHostedToolCalls(translated, hostedNames)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          // pi-ai can emit an error event (with the abort reason as the
          // message) instead of throwing when the caller signal is already
          // aborted, so the catch remap below never runs.
          yield options.signal?.aborted === true
            ? errorFinishAsCallerAbort(result.value)
            : result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedSdkTeardown) {
            // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
          }
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}
