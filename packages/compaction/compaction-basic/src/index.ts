/**
 * Basic replay-aware compaction backend.
 *
 * @module @shres-code/shres-code-compaction-basic
 */

import { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { CompactionEngine, ManualCompactionError } from '@shres-code/shres-code-compaction'
import type { CompactionFailureFacts, CompactionResult, CompactionTrigger } from '@shres-code/shres-code-compaction'
import type { TokenMeasurement, TokenMeter } from '@shres-code/shres-code-token-meter'
import type { Session } from '@shres-code/shres-code-session'
import { CONTEXT_WINDOW_EXCEEDED_CODE, assertNever, errorChain } from '@shres-code/shres-code-llm'
import type { LlmCallConfig } from '@shres-code/shres-code-llm'
import type { Agent, PreStepDecision } from '@shres-code/shres-code-agent'
import type { CommandId } from '@shres-code/shres-code-commands/brand'
// Type-only: makes the optional sibling service available to `ctx.get()`.
import type {} from '@shres-code/shres-code-compaction-tool-result-pruner'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
  MAX_MAX_POINTERS,
} from './config.ts'
import {
  assertNoActiveCompaction,
  compactSurfaceRegion,
  selectCompactableRange,
} from './region.ts'
import { summarizationFailureFacts, summarizeWithLlm } from './summarizer.ts'
import type { SummarizationInput, SummaryResult } from './summarizer.ts'
import type {
  BasicCompactionConfig,
  ModelCompactPolicyConfig,
  ResolvedConfig,
} from './types.ts'

export type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'

/** The region transaction's view of this service's dynamically dispatched summarizer. */
type RegionSummarize = (input: SummarizationInput, agent: Agent, signal?: AbortSignal) => Promise<SummaryResult>

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(
  session: Session,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/** The pressure a measurement reports: the figure compared against the threshold and its source. */
interface PressureReading {
  /** Tokens compared against the target's threshold. */
  readonly tokens: number
  /** Whether the figure is the provider-anchored prompt or the heuristic envelope. */
  readonly source: 'usage' | 'heuristic'
}

/**
 * Read the pressure the latest routed request is under.
 *
 * The provider-anchored figure wins when the meter measured usage for a request
 * whose header still matches the current one: it is the only side that counts
 * what the heuristic estimator cannot see, so a route whose wire carries
 * adapter-private replay or whose content is denser than four characters per
 * token crosses the threshold there first. The heuristic envelope — surface
 * plus request furniture — is the fallback before the first response reports
 * usage and after a header change moves the anchor.
 * @param measurement - one snapshot from the session's token meter.
 * @returns the tokens to compare against the threshold and their source.
 */
function pressureReading(measurement: TokenMeasurement): PressureReading {
  return measurement.baseline.kind === 'usage'
    ? { tokens: measurement.totalTokens, source: 'usage' }
    : { tokens: measurement.surfaceTokens + measurement.headerTokens, source: 'heuristic' }
}

/**
 * Whether one measurement is at or above a target's pressure threshold.
 * @param measurement - one snapshot from the session's token meter.
 * @param thresholdTokens - the target's threshold, in the reading's own units.
 * @returns true when the next request is at or above the threshold.
 */
function underPressure(measurement: TokenMeasurement, thresholdTokens: number): boolean {
  return pressureReading(measurement).tokens >= thresholdTokens
}

/** One attempt plan for {@link BasicCompactionEngine}'s overflow-reducing compaction. */
interface RegionRetryPlan {
  /** Snapshot the first attempt selects from. */
  readonly measurement: TokenMeasurement
  /** Retention floor for the first attempt, in metered surface tokens. */
  readonly retainTokens: number
  /** 1-based attempt index recorded for the first attempt; later attempts continue from it. */
  readonly firstAttempt?: number
  /** Run one transaction over the selected span with its 1-based attempt index. */
  readonly run: (
    range: { readonly start: number; readonly end: number },
    attempt: number,
  ) => Promise<CompactionResult>
}

/**
 * Metered tokens of one selected surface span, priced by the meter's own nodes.
 * @param measurement - the snapshot the span was selected from.
 * @param range - inclusive first and last surface-node seqs.
 * @returns the sum of the span's node prices, or 0 when the span is absent.
 */
function meteredRangeTokens(
  measurement: TokenMeasurement,
  range: { readonly start: number; readonly end: number },
): number {
  const start = measurement.nodes.findIndex(node => node.seq === range.start)
  const end = measurement.nodes.findIndex(node => node.seq === range.end)
  if (start === -1 || end === -1 || end < start) return 0
  let tokens = 0
  for (let index = start; index <= end; index += 1) {
    tokens += measurement.nodes[index]?.tokens ?? 0
  }
  return tokens
}

/**
 * Errors reachable from one attempt's failure through `cause`, nearest first.
 * A manual attempt classifies its failure as `ManualCompactionError('summary')` around
 * the summarizer's own error, so the facts to read are one or two links down.
 * @param error - the failure a transaction attempt threw.
 * @returns up to eight chained errors, nearest first.
 */
function causeChain(error: unknown): Error[] {
  const chain: Error[] = []
  for (let current: unknown = error; current instanceof Error && chain.length < 8; current = current.cause) {
    chain.push(current)
  }
  return chain
}

/**
 * The summarization failure facts reachable from an attempt's error, if any.
 * @param error - the failure a transaction attempt threw.
 * @returns the nearest structured facts, or `undefined` when the chain carries none.
 */
function attemptFailureFacts(error: unknown): Omit<CompactionFailureFacts, 'attempt'> | undefined {
  for (const entry of causeChain(error)) {
    const facts = summarizationFailureFacts(entry)
    if (facts !== undefined) return facts
  }
  return undefined
}

/**
 * Whether one compaction attempt failed on the summarizer's own context overflow.
 * @param error - the failure a transaction attempt threw.
 * @returns true when durable facts or an error's own code report context overflow.
 */
function summarizerOverflowed(error: unknown): boolean {
  return causeChain(error).some(entry => summarizationFailureFacts(entry)?.code === CONTEXT_WINDOW_EXCEEDED_CODE
    || (entry as { code?: unknown }).code === CONTEXT_WINDOW_EXCEEDED_CODE)
}

/**
 * Name what a spent region-reduction could not do: the region's size, the
 * attempts, the summarizer target, and the usage that attempt reported.
 * @param overflowed - the last failed attempt and the region it ran over.
 * @param attempts - attempts made within this reduction.
 * @returns the diagnostic to throw.
 */
function summarizationOverflowExhausted(
  overflowed: { readonly error: unknown; readonly regionTokens: number },
  attempts: number,
): Error {
  const facts = attemptFailureFacts(overflowed.error)
  const target = facts === undefined ? 'an unreported target' : `${facts.provider}/${facts.model}`
  const usage = facts?.usage === undefined
    ? 'no usage'
    : `${facts.usage.inputTokens + (facts.usage.cacheReadTokens ?? 0) + (facts.usage.cacheWriteTokens ?? 0)} prompt tokens`
  const message = `compaction could not summarize a ${overflowed.regionTokens}-token region after ${attempts} `
    + `${attempts === 1 ? 'attempt' : 'attempts'} (summarizer ${target}; last attempt reported ${usage}: `
    + `${errorChain(overflowed.error)}); reduce the retained history, point summarization at `
    + 'a larger-window model, or raise maxSummaryOverflowRetries'
  // A manual attempt already classified its failure; keep the command-facing class.
  return overflowed.error instanceof ManualCompactionError
    ? new ManualCompactionError('summary', message, { cause: overflowed.error })
    : new Error(message, { cause: overflowed.error })
}

/** Resolve the conversation target used to select an optional policy override. */
function conversationTarget(
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  if (agent.options.provider === undefined || agent.options.provider.length === 0
    || agent.options.model === undefined || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

const thresholdRatioSchema = z.number()
const retainRatioSchema = z.number()
const retainTokensSchema = z.number().step(1).min(0)
const summarizationProviderSchema = z.string()
const summarizationModelSchema = z.string()
const maxTokensSchema = z.number().step(1).min(1)
const compactionRetriesSchema = z.number().step(1).min(0)
const maxOverflowRetriesSchema = z.number().step(1).min(0)
const maxSummaryOverflowRetriesSchema = z.number().step(1).min(0)
const maxPointersSchema = z.number().step(1).min(0).max(MAX_MAX_POINTERS)
const pinSeqsSchema = z.array(z.number().step(1).min(0))

const modelPolicy: z<ModelCompactPolicyConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: thresholdRatioSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
  maxSummaryOverflowRetries: maxSummaryOverflowRetriesSchema,
})

/**
 * Dependency-light compaction backend using `ctx.tokenMeter` for pressure,
 * retention, cited source events, and summary-convergence pricing.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config: z<BasicCompactionConfig> = z.object({
    thresholdRatio: thresholdRatioSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    maxSummaryOverflowRetries: maxSummaryOverflowRetriesSchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
    maxPointers: maxPointersSchema,
    pinSeqs: pinSeqsSchema,
  })

  /** Resolved and validated compaction configuration. */
  readonly config: ResolvedConfig

  private readonly warnedPressureConfigTargets = new Set<string>()
  private readonly overflowRetries = new WeakMap<Agent, number>()
  private readonly overflowAgents = new WeakMap<Session, Agent>()

  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  /**
   * Register automatic between-step pressure and model-request overflow
   * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
   */
  private _registerAutomaticCompaction(): void {
    const { ctx } = this
    const logResult = (result: CompactionResult, trigger: string): void => {
      ctx.logger.info(
        `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens)`,
      )
    }

    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error: unknown) {
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next()
            this.warnedPressureConfigTargets.add(error.targetKey)
          }
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    })

    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const target = routedTarget(agent.session)
      if (target === undefined) return next()
      const policy = resolveTargetPolicy(this.config, target)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= policy.maxOverflowRetries) return next()

      const generation = agent.session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError: unknown) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        // A model-free prune can land before later summary work fails. That
        // durable reduction is sufficient retry proof; do not discard it just
        // because the optional second phase threw. Cancellation still wins.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
          `context-overflow compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        return next()
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while compaction is awaited.
      if (signal.aborted
        || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  /**
   * Summarize the replayed conversation region through a direct one-shot
   * `ctx.llm.stream()` call whose prefix reuses the conversation's own system
   * prompt, tools, and messages so the provider's KV cache is not invalidated.
   * Override this sole hook for a template or remote summarizer.
   * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and the exact auxiliary call envelope and output.
   */
  protected async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const target = conversationTarget(agent)
    const config = target === undefined
      ? this.config
      : resolveTargetPolicy(this.config, target)
    return summarizeWithLlm(this.ctx, config, input, agent, signal)
  }

  /**
   * Compact for replayed step-boundary pressure or one provider-confirmed context
   * overflow. Both triggers price the latest durable routed request envelope;
   * overflow bypasses the normal threshold and retained-tail policy so it can
   * force one useful balanced reduction.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const policy = resolveTargetPolicy(this.config, target)
    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session)
    switch (trigger) {
      case 'context-overflow':
        break
      case 'pressure':
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(trigger, 'compaction trigger')
    }

    // Pruning is optional so compaction-basic remains independently composable.
    // Overflow always qualifies; pressure first resolves the routed model's
    // capacity and checks its target-specific threshold.
    const prune = this.ctx.get('toolResultPruner')

    if (trigger === 'context-overflow') {
      if (prune !== undefined) {
        prune.pruneSession(agent.session)
        measurement = meter.measure(agent.session)
      }
      return this.compactRangeWithOverflowRetries(agent, {
        measurement,
        retainTokens: 0,
        run: (range, attempt) => this.compactRegion(range.start, range.end, agent, signal, attempt),
      })
    }

    const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
    const targetKey = `${target.provider}/${target.model}`
    if (context === undefined) {
      throw new TargetPressureConfigError(
        targetKey,
        `compaction-basic: no context capacity for ${targetKey}; `
        + 'configure contextWindow on that adapter model',
      )
    }
    const spec = resolveCompactSpec(policy, context.contextWindow)
    // Pressure prices the whole next request through {@link pressureReading}:
    // the provider-anchored prompt when the meter has one, the heuristic
    // envelope otherwise. The request header (system prompt + tool schemas) is
    // furniture no compaction can remove, so a threshold configured near or
    // below that floor cannot express pressure for this window and composition:
    // compacting could never bring the surface under it, so firing would only
    // loop. Decline instead.
    const surfaceBudget = () => spec.thresholdTokens - measurement.headerTokens
    if (surfaceBudget() <= spec.retainTokens) return null
    if (!underPressure(measurement, spec.thresholdTokens)) return null

    // Once pressure qualifies, land the model-free pass before choosing a
    // summary range, then remeasure through the singleton replay fold.
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (surfaceBudget() <= spec.retainTokens
      || !underPressure(measurement, spec.thresholdTokens)) return null

    let result: CompactionResult | null = null
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const compacted = await this.compactRangeWithOverflowRetries(agent, {
        measurement,
        retainTokens: spec.retainTokens,
        firstAttempt: attempt + 1,
        run: (range, index) => this.compactRegion(range.start, range.end, agent, signal, index),
      })
      if (compacted === null) {
        /* v8 ignore else -- concrete replacement preserves a compactable checkpoint; subclass hooks cannot mutate it. */
        if (result === null) return null
        /* v8 ignore next -- paired with the defensive post-success branch above. */
        break
      }
      result = compacted
      measurement = meter.measure(agent.session)
      if (!underPressure(measurement, spec.thresholdTokens)) return result
    }

    const reading = pressureReading(measurement)
    throw new Error(
      `compaction still above surface budget after ${spec.compactionRetries + 1} compaction attempts `
        + `(${measurement.surfaceTokens} surface tokens >= budget ${surfaceBudget()} of threshold `
        + `${spec.thresholdTokens} minus ${measurement.headerTokens} header furniture; `
        + `${reading.source} pressure ${reading.tokens} tokens)`,
    )
  }

  /**
   * Select and compact one region, re-selecting a smaller one when the
   * summarizer reports that its own request exceeded the model's context window.
   *
   * A summarization call replays the region it condenses, so a session whose
   * remaining history alone is larger than the window fails every attempt at the
   * same size and can never compact. Each attempt keeps its own closed
   * `compaction/start`/`compaction/end` bracket; a failed one raises the
   * retention floor so the next selected region carries at most half the failed
   * region's metered tokens, which makes termination structural — the region at
   * least halves per retry, or selection declines.
   * @param agent - owner of the target session.
   * @param plan - first retention floor, its measurement, and the transaction to run.
   * @returns the first successful result, or `null` when nothing is compactable.
   * @throws the attempt's own failure when the retry budget is spent, and a named
   *   failure when the reduced region has nothing left to compact.
   */
  private async compactRangeWithOverflowRetries(
    agent: Agent,
    plan: RegionRetryPlan,
  ): Promise<CompactionResult | null> {
    const firstAttempt = plan.firstAttempt ?? 1
    let measurement = plan.measurement
    let retainTokens = plan.retainTokens
    let attempt = firstAttempt
    let overflowed: { error: unknown; regionTokens: number } | undefined
    for (;;) {
      const range = selectCompactableRange(agent.session, measurement, retainTokens, this.config.pinSeqs)
      if (range === null) {
        if (overflowed === undefined) return null
        throw summarizationOverflowExhausted(overflowed, attempt - firstAttempt)
      }
      const regionTokens = meteredRangeTokens(measurement, range)
      try {
        return await plan.run(range, attempt)
      } catch (error: unknown) {
        if (!summarizerOverflowed(error)) throw error
        if (attempt - firstAttempt >= this.config.maxSummaryOverflowRetries) {
          throw summarizationOverflowExhausted({ error, regionTokens }, attempt - firstAttempt + 1)
        }
        retainTokens = Math.max(
          retainTokens + 1,
          measurement.surfaceTokens - Math.floor(regionTokens / 2),
        )
        overflowed = { error, regionTokens }
        attempt += 1
        measurement = this.ctx.tokenMeter.measure(agent.session)
      }
    }
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @param attempt - 1-based index of this attempt within its compaction, recorded on failure.
   * @returns the successful durable compaction result.
   */
  override async compactRegion(
    start: number,
    end: number,
    agent: Agent,
    signal?: AbortSignal,
    attempt = 1,
  ): Promise<CompactionResult> {
    return compactSurfaceRegion(
      this.regionDependencies(),
      agent.session,
      start,
      end,
      agent,
      { owner: 'current-turn', stability: 'whole-surface', attempt },
      signal,
    )
  }

  /**
   * Force one useful idle-session compaction below the pressure threshold, and
   * resolve only after its standalone marker pair is durably checkpointed.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          return await this.compactRangeWithOverflowRetries(agent, {
            measurement: this.ctx.tokenMeter.measure(agent.session),
            retainTokens: 0,
            run: (range, attempt) => compactSurfaceRegion(
              this.regionDependencies(),
              agent.session,
              range.start,
              range.end,
              agent,
              {
                owner: null,
                stability: 'selected-span',
                attempt,
                ...sourceCommandId === undefined ? {} : { sourceCommandId },
                flush: async () => {
                  await this.ctx.sessions.flush(agent.session)
                },
              },
              operationSignal,
            ),
          })
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError(
              'cancelled',
              'manual compaction was cancelled',
              { cause: error },
            )
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error: unknown) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /** Bind the effective token meter and dynamically dispatched summarizer hook. */
  private regionDependencies(): {
    meter: TokenMeter
    summarize: RegionSummarize
    maxPointers: number
  } {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
      maxPointers: this.config.maxPointers,
    }
  }
}

export default BasicCompactionEngine
