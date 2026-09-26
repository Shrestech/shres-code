/** `trajectory` namespace dictionaries (view tab label, toolbar, thinking-collapse, and routing strings). */

import type {
  ModelRoutingBreakReason, ModelRoutingOutcome, ModelRoutingReason,
} from '@shres-code/shres-code-model-router/client'

/** Dictionary namespace owned by this plugin. */
export const NS = 'trajectory'

/** The trajectory dictionary key set (the source of truth for both locales). */
export type TrajectoryKey =
  | 'view.trajectory'
  | 'toolbar.aria'
  | 'toolbar.duration'
  | 'toolbar.useActualDuration'
  | 'toolbar.useEqualWidth'
  | 'toolbar.actualTime'
  | 'toolbar.turns'
  | 'toolbar.expandTurns'
  | 'toolbar.collapseTurns'
  | 'toolbar.calls'
  | 'toolbar.expandCalls'
  | 'toolbar.collapseCalls'
  | 'toolbar.search'
  | 'toolbar.searchPlaceholder'
  | 'thinking.label'
  | 'thinking.segments'
  | 'routing.outcome.downgraded'
  | 'routing.outcome.keptStrong'
  | 'routing.outcome.skipped'
  | 'routing.outcome.error'
  | 'routing.reason.gatePassed'
  | 'routing.reason.stickyHold'
  | 'routing.reason.engineAbsent'
  | 'routing.reason.engineDisabled'
  | 'routing.reason.engineUnavailable'
  | 'routing.reason.judgmentFailureHeld'
  | 'routing.reason.breakerOpen'
  | 'routing.reason.invalidAnswer'
  | 'routing.reason.noCandidates'
  | 'routing.reason.baseUnlisted'
  | 'routing.reason.modelUnavailable'
  | 'routing.reason.candidateIneligible'
  | 'routing.reason.stateTooLarge'
  | 'routing.reason.judgmentInputTooLarge'
  | 'routing.reason.unknownCandidate'
  | 'routing.reason.lowConfidence'
  | 'routing.reason.thinMargin'
  | 'routing.reason.candidateEqualsBase'
  | 'routing.reason.thinkingModeIncompatible'
  | 'routing.reason.engineUncalibrated'
  | 'routing.reason.currentPreferred'
  | 'routing.reason.difficultyTooHigh'
  | 'routing.reason.gateFailed'
  | 'routing.reason.holdCap'
  | 'routing.reason.reentryCooldown'
  | 'routing.reason.escalated'
  | 'routing.reason.manualDeviation'
  | 'routing.reason.routeErrors'
  | 'routing.reason.routeFailed'
  | 'routing.reason.modeOff'
  | 'routing.reason.judgmentError'
  | 'routing.reason.warmPrefix'
  | 'routing.reason.coldPointReturn'
  | 'routing.shadow.switched'
  | 'routing.shadow.kept'
  | 'routing.confidence'
  | 'routing.streak.entered'
  | 'routing.streak.exited'
  | 'routing.badge.routed'
  | 'routing.explain'
  | 'routing.explain.label'

declare module '@shres-code/shres-code-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The trajectory view tab label, toolbar, thinking-collapse, and routing strings. */
    'trajectory': TrajectoryKey
  }
}

/** English dictionary. */
export const en: Record<TrajectoryKey, string> = {
  'view.trajectory': 'Trajectory',
  'toolbar.aria': 'Trajectory toolbar',
  'toolbar.duration': 'Duration',
  'toolbar.useActualDuration': 'Use actual duration',
  'toolbar.useEqualWidth': 'Use equal-width operations',
  'toolbar.actualTime': 'Actual time',
  'toolbar.turns': 'Turns',
  'toolbar.expandTurns': 'Expand turns',
  'toolbar.collapseTurns': 'Collapse turns',
  'toolbar.calls': 'Calls',
  'toolbar.expandCalls': 'Expand calls',
  'toolbar.collapseCalls': 'Collapse calls',
  'toolbar.search': 'Search trajectory',
  'toolbar.searchPlaceholder': 'Search',
  'thinking.label': 'Thinking',
  'thinking.segments': '{count} segments',
  'routing.outcome.downgraded': 'downgraded',
  'routing.outcome.keptStrong': 'kept strong',
  'routing.outcome.skipped': 'skipped',
  'routing.outcome.error': 'error',
  'routing.reason.gatePassed': 'gate passed',
  'routing.reason.stickyHold': 'streak held',
  'routing.reason.engineAbsent': 'engine absent',
  'routing.reason.engineDisabled': 'engine disabled',
  'routing.reason.engineUnavailable': 'engine unavailable',
  'routing.reason.judgmentFailureHeld': 'judgment failed, streak held',
  'routing.reason.breakerOpen': 'judgment paused after repeated failures',
  'routing.reason.invalidAnswer': 'invalid answer',
  'routing.reason.noCandidates': 'no candidates configured',
  'routing.reason.baseUnlisted': 'routing does not start from this model',
  'routing.reason.modelUnavailable': 'model capabilities unavailable',
  'routing.reason.candidateIneligible': 'candidate cannot preserve request capabilities',
  'routing.reason.stateTooLarge': 'current request exceeds routing context budget',
  'routing.reason.judgmentInputTooLarge': 'routing input exceeds judgment token budget',
  'routing.reason.unknownCandidate': 'chosen route is not allowlisted',
  'routing.reason.lowConfidence': 'low confidence',
  'routing.reason.thinMargin': 'thin top-two margin',
  'routing.reason.candidateEqualsBase': 'already on the routed model',
  'routing.reason.thinkingModeIncompatible': 'manual model thinks on a fixed budget, which a return would lose',
  'routing.reason.engineUncalibrated': 'judge engine is not accepted for routing without an operating point',
  'routing.reason.currentPreferred': 'current model preferred',
  'routing.reason.difficultyTooHigh': 'task too difficult to downgrade',
  'routing.reason.gateFailed': 'gate failed',
  'routing.reason.holdCap': 'streak reached its step cap',
  'routing.reason.reentryCooldown': 'cooling down after a streak exit',
  'routing.reason.escalated': 'escalated to the stronger model',
  'routing.reason.manualDeviation': 'model switched manually',
  'routing.reason.routeErrors': 'route failures',
  'routing.reason.routeFailed': 'route failed, retried on the manual model',
  'routing.reason.modeOff': 'routing off',
  'routing.reason.judgmentError': 'judgment failed',
  'routing.reason.warmPrefix': 'Strong cache still warm: no switch attempted',
  'routing.reason.coldPointReturn': 'Strong cache went cold: returned to the strong model',
  'routing.shadow.switched': 'Shadow: would have switched to {model}',
  'routing.shadow.kept': 'Shadow: kept the strong model',
  'routing.confidence': 'confidence {value}',
  'routing.streak.entered': 'streak entered · turn {turn}',
  'routing.streak.exited': 'streak ended · {reason}',
  'routing.badge.routed': 'Routed',
  'routing.explain': 'Explain',
  'routing.explain.label': 'Explain this routing decision in the Routing view',
}

/** Dictionary key per logged outcome. */
export const ROUTING_OUTCOME_KEYS: Record<ModelRoutingOutcome, TrajectoryKey> = {
  downgraded: 'routing.outcome.downgraded',
  'kept-strong': 'routing.outcome.keptStrong',
  skipped: 'routing.outcome.skipped',
  error: 'routing.outcome.error',
}

/** Dictionary key per resolved reason; one per reason class, including every streak break. */
export const ROUTING_REASON_KEYS: Record<ModelRoutingReason, TrajectoryKey> = {
  'gate-passed': 'routing.reason.gatePassed',
  'sticky-hold': 'routing.reason.stickyHold',
  'engine-absent': 'routing.reason.engineAbsent',
  'engine-disabled': 'routing.reason.engineDisabled',
  'engine-unavailable': 'routing.reason.engineUnavailable',
  'judgment-failure-held': 'routing.reason.judgmentFailureHeld',
  'breaker-open': 'routing.reason.breakerOpen',
  'invalid-answer': 'routing.reason.invalidAnswer',
  'no-candidates': 'routing.reason.noCandidates',
  'base-unlisted': 'routing.reason.baseUnlisted',
  'model-unavailable': 'routing.reason.modelUnavailable',
  'candidate-ineligible': 'routing.reason.candidateIneligible',
  'state-too-large': 'routing.reason.stateTooLarge',
  'judgment-input-too-large': 'routing.reason.judgmentInputTooLarge',
  'unknown-candidate': 'routing.reason.unknownCandidate',
  'low-confidence': 'routing.reason.lowConfidence',
  'thin-margin': 'routing.reason.thinMargin',
  'candidate-equals-base': 'routing.reason.candidateEqualsBase',
  'thinking-mode-incompatible': 'routing.reason.thinkingModeIncompatible',
  'engine-uncalibrated': 'routing.reason.engineUncalibrated',
  'current-preferred': 'routing.reason.currentPreferred',
  'difficulty-too-high': 'routing.reason.difficultyTooHigh',
  'gate-failed': 'routing.reason.gateFailed',
  'hold-cap': 'routing.reason.holdCap',
  'reentry-cooldown': 'routing.reason.reentryCooldown',
  escalated: 'routing.reason.escalated',
  'manual-deviation': 'routing.reason.manualDeviation',
  'route-errors': 'routing.reason.routeErrors',
  'route-failed': 'routing.reason.routeFailed',
  'mode-off': 'routing.reason.modeOff',
  'judgment-error': 'routing.reason.judgmentError',
  'warm-prefix': 'routing.reason.warmPrefix',
  'cold-point-return': 'routing.reason.coldPointReturn',
}

/** Dictionary key per streak break reason. */
export const ROUTING_BREAK_KEYS: Record<ModelRoutingBreakReason, TrajectoryKey> = {
  'candidate-ineligible': 'routing.reason.candidateIneligible',
  'gate-failed': 'routing.reason.gateFailed',
  'hold-cap': 'routing.reason.holdCap',
  'base-unlisted': 'routing.reason.baseUnlisted',
  'current-preferred': 'routing.reason.currentPreferred',
  'unknown-candidate': 'routing.reason.unknownCandidate',
  escalated: 'routing.reason.escalated',
  'manual-deviation': 'routing.reason.manualDeviation',
  'mode-off': 'routing.reason.modeOff',
  'route-errors': 'routing.reason.routeErrors',
  'route-failed': 'routing.reason.routeFailed',
  'cold-point-return': 'routing.reason.coldPointReturn',
}
