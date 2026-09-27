/** Conservative capability checks for model-routing candidates.
 * @module @shres-code/shres-code-model-router/eligibility
 */

import type {
  HostedTool,
  LlmResolvedModelInfo,
  LlmRuntime,
  Message,
} from '@shres-code/shres-code-llm'
import {
  contentHasImage,
  ReasoningEffortId,
} from '@shres-code/shres-code-llm'
import type { LlmCallConfig } from '@shres-code/shres-code-llm'
import type { ModelRoutingDifficultyToEffortConfig } from './config.ts'
import type {
  ModelRoutingCandidate,
  ModelRoutingCandidateAssessment,
  ModelRoutingCandidateEligibility,
  ModelRoutingCandidateEligibilityReason,
  ModelRoutingCandidateRequirements,
} from './types.ts'

export type {
  ModelRoutingCandidateAssessment,
  ModelRoutingCandidateEligibility,
  ModelRoutingCandidateEligibilityReason,
  ModelRoutingCandidateRequirements,
} from './types.ts'

/** A prepared call's only facts this helper needs. */
interface PreparedCandidateCall {
  readonly config: LlmCallConfig
}

/** Build a detached assessment without carrying provider errors or request data. */
function assessmentFor(
  candidate: ModelRoutingCandidate,
  reason: ModelRoutingCandidateEligibilityReason,
  facts: {
    info?: LlmResolvedModelInfo | undefined
    prepared?: PreparedCandidateCall | undefined
    difficultyEffort?: string | undefined
  } = {},
): ModelRoutingCandidateAssessment {
  const { info, prepared, difficultyEffort } = facts
  const reasoningEffort = prepared?.config.reasoningEffort ?? candidate.reasoningEffort
  const inputModalities = info?.inputModalities
  const hostedTools = info?.hostedTools
  const effectiveMaxTokens = prepared?.config.maxTokens ?? info?.defaultMaxTokens
  return Object.freeze({
    id: candidate.id,
    provider: candidate.provider,
    model: candidate.model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort: String(reasoningEffort) },
    ...difficultyEffort === undefined ? {} : { difficultyReasoningEffort: difficultyEffort },
    ...inputModalities === undefined ? {} : { inputModalities: Object.freeze([...inputModalities]) },
    ...info?.context === undefined ? {} : { contextWindow: info.context.contextWindow },
    ...hostedTools === undefined ? {} : { hostedTools: Object.freeze([...hostedTools]) },
    ...effectiveMaxTokens === undefined ? {} : { effectiveMaxTokens },
    ...info?.promptCacheTtlMs === undefined ? {} : { promptCacheTtlMs: info.promptCacheTtlMs },
    reason,
  })
}

/** Build the assessment used when base metadata could not be resolved. */
function baseFailureAssessment(
  candidate: ModelRoutingCandidate,
  reason: 'base-unavailable' | 'base-context-unknown',
): ModelRoutingCandidateAssessment {
  return assessmentFor(candidate, reason)
}

/** Detach the manual facts used as the candidate capability floor. */
function candidateRequirements(
  requiresImage: boolean,
  info?: LlmResolvedModelInfo,
): ModelRoutingCandidateRequirements {
  return Object.freeze({
    requiresImage,
    ...info === undefined ? {} : {
      provider: info.provider,
      model: info.id,
      ...info.context === undefined ? {} : { contextWindow: info.context.contextWindow },
      ...info.hostedTools === undefined ? {} : { hostedTools: Object.freeze([...info.hostedTools]) },
      ...info.thinkingMode === undefined ? {} : { thinkingMode: info.thinkingMode },
      ...info.promptCacheTtlMs === undefined ? {} : { promptCacheTtlMs: info.promptCacheTtlMs },
    },
  })
}

/** Re-throw cancellation while allowing ordinary provider failures to be classified. */
function rethrowCancellation(error: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted || isAbortError(error)) throw error
}

/** Classify exact-model metadata failures without copying provider diagnostics. */
function candidateResolutionFailureReason(error: unknown): 'candidate-unavailable' | 'candidate-invalid' {
  if (typeof error !== 'object' || error === null) return 'candidate-unavailable'
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.startsWith('INVALID_')
    ? 'candidate-invalid'
    : 'candidate-unavailable'
}

/** Detect the abort errors adapters commonly use at this boundary. */
function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (typeof error !== 'object' || error === null) return false
  const named = error as { code?: unknown; name?: unknown }
  return named.name === 'AbortError' || named.code === 'ABORT_ERR'
}

/** Create a candidate request while dropping the manual route's effort. */
function candidateCallConfig(
  base: LlmCallConfig,
  candidate: ModelRoutingCandidate,
): LlmCallConfig {
  const { reasoningEffort: _manualEffort, ...baseControls } = base
  return {
    ...baseControls,
    provider: candidate.provider,
    model: candidate.model,
    ...candidate.reasoningEffort === undefined ? {} : { reasoningEffort: candidate.reasoningEffort },
  }
}

/** Return whether a candidate declares every hosted tool the manual route declares. */
function hasHostedToolFloor(
  manual: readonly HostedTool[] | undefined,
  candidate: readonly HostedTool[] | undefined,
): 'ok' | 'incompatible' {
  if (manual === undefined || manual.length === 0) return 'ok'
  return candidate !== undefined && manual.every(tool => candidate.includes(tool))
    ? 'ok'
    : 'incompatible'
}

/**
 * Check configured routes before a judgment can select one.
 * The helper performs metadata and call preparation only; it never dispatches
 * a model request. Unknown capacity or capability is conservatively excluded.
 * A candidate naming the manual provider/model is excluded as `equals-base`
 * before any lookup, whatever its effort: it is no downgrade, and a same-model
 * effort change invalidates the prompt cache on providers that render effort
 * into the cached request. While the manual route declares `budget` thinking
 * and its effective effort enables reasoning, every other candidate is
 * excluded as `thinking-mode-incompatible` before any lookup.
 * @param runtime - exact LLM runtime owning provider registrations.
 * @param base - manual route and request controls to preserve on candidates.
 * @param messages - request messages used only for nested image detection.
 * @param candidates - resolved configured candidates, returned unchanged.
 * @param difficultyToEffort - optional configured effort that must be accepted by every candidate.
 * @param signal - optional cancellation passed to every metadata lookup.
 * @returns configured candidates, eligible candidates, and detached assessments.
 *
 * The context check is a conservative declared-window floor plus the effective
 * output cap; it cannot guarantee tokenizer fit because exact input-token
 * accounting is not available yet.
 */
export async function assessModelRoutingCandidates(
  runtime: Pick<LlmRuntime, 'resolveModelInfo' | 'prepareCall'>,
  base: LlmCallConfig,
  messages: readonly Message[],
  candidates: readonly ModelRoutingCandidate[],
  difficultyToEffort?: ModelRoutingDifficultyToEffortConfig,
  signal?: AbortSignal,
): Promise<ModelRoutingCandidateEligibility> {
  signal?.throwIfAborted()
  const needsImage = messages.some(message => contentHasImage(message.content))
  const unavailableRequirements = candidateRequirements(needsImage)

  let baseInfo: LlmResolvedModelInfo
  let basePrepared: PreparedCandidateCall
  try {
    baseInfo = await runtime.resolveModelInfo(base.provider, base.model, signal)
    basePrepared = await runtime.prepareCall(base, signal)
  } catch (error) {
    rethrowCancellation(error, signal)
    const assessments = Object.freeze(candidates.map(candidate => baseFailureAssessment(candidate, 'base-unavailable')))
    return { requirements: unavailableRequirements, candidates, eligibleCandidates: [], assessments }
  }

  if (baseInfo.context === undefined) {
    const assessments = Object.freeze(candidates.map(candidate => baseFailureAssessment(candidate, 'base-context-unknown')))
    return {
      requirements: candidateRequirements(needsImage, baseInfo),
      candidates,
      eligibleCandidates: [],
      assessments,
    }
  }

  // Anthropic requires the signed thinking of earlier assistant turns in a
  // tool-use continuation; a routed segment carries none, so a budget-thinking
  // manual route that enables reasoning would resume without thinking.
  const baseEffort = basePrepared.config.reasoningEffort
  const budgetThinking = baseInfo.thinkingMode === 'budget' && baseEffort !== undefined && String(baseEffort) !== 'off'
  const eligibleCandidates: ModelRoutingCandidate[] = []
  const assessments: ModelRoutingCandidateAssessment[] = []
  const addAssessment = (
    candidate: ModelRoutingCandidate,
    reason: ModelRoutingCandidateEligibilityReason,
    info?: LlmResolvedModelInfo,
    prepared?: PreparedCandidateCall,
    difficultyEffort?: string,
  ): void => {
    assessments.push(assessmentFor(candidate, reason, { info, prepared, difficultyEffort }))
  }

  for (const candidate of candidates) {
    signal?.throwIfAborted()
    if (candidate.provider === base.provider && candidate.model === base.model) {
      addAssessment(candidate, 'equals-base')
      continue
    }
    if (budgetThinking) {
      addAssessment(candidate, 'thinking-mode-incompatible')
      continue
    }
    let info: LlmResolvedModelInfo
    try {
      info = await runtime.resolveModelInfo(candidate.provider, candidate.model, signal)
    } catch (error) {
      rethrowCancellation(error, signal)
      addAssessment(candidate, candidateResolutionFailureReason(error))
      continue
    }

    const config = candidateCallConfig(base, candidate)
    let prepared: PreparedCandidateCall
    try {
      prepared = await runtime.prepareCall(config, signal)
    } catch (error) {
      rethrowCancellation(error, signal)
      addAssessment(candidate, 'candidate-invalid', info)
      continue
    }

    let difficultyEffort: string | undefined
    if (difficultyToEffort !== undefined) {
      difficultyEffort = difficultyToEffort.reasoningEffort
      try {
        await runtime.prepareCall({
          ...config,
          reasoningEffort: ReasoningEffortId(difficultyEffort),
        }, signal)
      } catch (error) {
        rethrowCancellation(error, signal)
        addAssessment(candidate, 'difficulty-effort-invalid', info, prepared, difficultyEffort)
        continue
      }
    }

    if (needsImage) {
      if (info.inputModalities === undefined) {
        addAssessment(candidate, 'image-capability-unknown', info, prepared, difficultyEffort)
        continue
      }
      if (!info.inputModalities.includes('image')) {
        addAssessment(candidate, 'image-incompatible', info, prepared, difficultyEffort)
        continue
      }
    }

    if (info.context === undefined) {
      addAssessment(candidate, 'context-unknown', info, prepared, difficultyEffort)
      continue
    }
    if (info.context.contextWindow < baseInfo.context.contextWindow) {
      addAssessment(candidate, 'context-too-small', info, prepared, difficultyEffort)
      continue
    }
    const effectiveMaxTokens = prepared.config.maxTokens ?? info.defaultMaxTokens
    if (effectiveMaxTokens !== undefined && info.context.contextWindow <= effectiveMaxTokens) {
      addAssessment(candidate, 'max-tokens-exceeds-context', info, prepared, difficultyEffort)
      continue
    }

    const hostedTools = hasHostedToolFloor(baseInfo.hostedTools, info.hostedTools)
    if (hostedTools !== 'ok') {
      addAssessment(candidate, 'hosted-tools-incompatible', info, prepared, difficultyEffort)
      continue
    }

    eligibleCandidates.push(candidate)
    addAssessment(candidate, 'eligible', info, prepared, difficultyEffort)
  }

  return {
    requirements: candidateRequirements(needsImage, baseInfo),
    candidates,
    eligibleCandidates: Object.freeze(eligibleCandidates),
    assessments: Object.freeze(assessments),
  }
}
