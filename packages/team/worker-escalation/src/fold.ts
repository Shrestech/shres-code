/**
 * Pure folds over a worker session's committed events: the five trigger folds,
 * the goal-epoch aging counter, and the step cooldown. Nothing here keeps live
 * memory — resume, fork, and compaction restore every state from the log
 * alone, which is what lets a restarted worker continue a half-aged epoch and
 * lets a bench replay one.
 *
 * @module @shres-code/shres-code-worker-escalation/fold
 */

import type { SessionEvent, TurnEndReason } from '@shres-code/shres-code-session'
import { sandboxDenialMarker } from '@shres-code/shres-code-sandbox'
import type { ConfinedSandboxMode } from '@shres-code/shres-code-sandbox'
import { assertNever } from '@shres-code/shres-code-jspace'
import type {} from '@shres-code/shres-code-jspace'
import type {} from '@shres-code/shres-code-step-budget'
import { ESCALATION_TRIGGERS } from './config.ts'
import type { ResolvedWorkerEscalationConfig } from './config.ts'
import type {
  EscalationTrigger,
  EscalationTriggerOutcome,
  WorkerEscalationProgressFacts,
} from './types.ts'

/** Modes that can refuse a file effect; `danger-full-access` bypasses confinement. */
const CONFINING_MODES: readonly ConfinedSandboxMode[] = ['read-only', 'workspace-write']

/** The model-facing denial markers the enforcing tool families render, read from their one producer. */
const SANDBOX_DENIAL_MARKERS: readonly string[] = CONFINING_MODES.map(mode => sandboxDenialMarker(mode))

/**
 * Whether one tool result reports a sandbox policy denial rather than a real
 * failure of the approach. A confining filesystem provider throws the
 * structured code; a kernel refusal reaches the log only as the rendered
 * marker, so both carriers are read.
 * @param code - the result's structured error code, when it carries one.
 * @param text - the result's model-facing text.
 * @returns true when the result is a policy denial, never a failed attempt.
 */
export function isSandboxDenial(code: string | undefined, text: string): boolean {
  if (code === 'FS_SANDBOX_DENIED') return true
  return SANDBOX_DENIAL_MARKERS.some(marker => text.includes(marker))
}

/**
 * Deep key-sort of a parsed-JSON value, so two argument objects that differ
 * only in property order canonicalize identically. Arguments reach a fold as
 * the `tool/call` event's raw string, so JSON's value domain is the whole
 * input domain.
 * @param value - parsed argument value.
 * @returns the canonicalized value.
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key])
    return sorted
  }
  return value
}

/**
 * Canonical string form of one call's arguments, computed exactly as the
 * repeat-tool-reminder guard computes its chain identity: the loop's parsed
 * arguments (or its raw-string fallback for malformed argument JSON), deep
 * key-sorted, then stringified.
 * @param raw - the `tool/call` event's raw `arguments` string.
 * @returns the canonical form.
 */
export function canonicalizeArguments(raw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // The loop logs the raw string when the model's argument JSON does not
    // parse, which is the same fallback the guard's chain key canonicalizes.
    parsed = raw
  }
  return JSON.stringify(sortJsonValue(parsed))
}

/**
 * The chain identity of one call: the `[name, canonical arguments]` tuple the
 * repeat-tool-reminder guard keys its consecutive-repeat chain on, so an
 * identical-call chain means here exactly what it means there.
 * @param name - tool name.
 * @param rawArguments - the call's raw `arguments` string.
 * @returns the chain key.
 */
export function callChainKey(name: string, rawArguments: string): string {
  return JSON.stringify([name, canonicalizeArguments(rawArguments)])
}

/** One tool-sourced result's logged facts. */
interface ToolOutcome {
  /** `tool/result` event seq. */
  readonly seq: number
  /** True when the result was not an error. */
  readonly ok: boolean
  /** Model-facing text of the result. */
  readonly text: string
  /** Structured error code, when the tool stamped one. */
  readonly code: string | undefined
  /** The owning call's id. */
  readonly callId: string
}

/** Tool-sourced result facts for one event, or undefined for another kind of event. */
function toolOutcomeOf(event: SessionEvent): ToolOutcome | undefined {
  if (event.type !== 'tool/result') return undefined
  const block = event.data.message.content[0]
  const parts: string[] = []
  for (const part of block.content) {
    if (part.type === 'text' && part.text.length > 0) parts.push(part.text)
  }
  const code = event.data.error?.code
  return {
    seq: event.seq,
    ok: block.isError !== true,
    text: parts.join('\n'),
    code: typeof code === 'string' ? code : undefined,
    callId: String(event.data.message.source.callId),
  }
}

/** Every tool-sourced result in log order. */
function toolOutcomes(events: readonly SessionEvent[]): ToolOutcome[] {
  const outcomes: ToolOutcome[] = []
  for (const event of events) {
    const outcome = toolOutcomeOf(event)
    if (outcome !== undefined) outcomes.push(outcome)
  }
  return outcomes
}

/** One trailing tool call paired with the result that answered it. */
export interface WorkerToolWindowEntry {
  /** `tool/call` event seq. */
  readonly seq: number
  /** Tool name. */
  readonly name: string
  /** True when the result was not an error. */
  readonly ok: boolean
  /** The call's raw `arguments` string, exactly as the model produced it. */
  readonly arguments: string
  /** Joined model-facing text of the result. */
  readonly text: string
}

/**
 * Fold the trailing tool window, oldest-first: each call a result already
 * answered, capped at `maxTools` and counted back from the newest call. A call
 * still in flight carries no outcome yet and is not part of the window.
 * @param events - session log or any prefix of it.
 * @param maxTools - maximum entries retained.
 * @returns the trailing entries, oldest-first.
 */
export function foldToolWindow(events: readonly SessionEvent[], maxTools: number): readonly WorkerToolWindowEntry[] {
  const results = new Map<string, { readonly ok: boolean; readonly text: string }>()
  for (const event of events) {
    const outcome = toolOutcomeOf(event)
    if (outcome !== undefined) results.set(outcome.callId, { ok: outcome.ok, text: outcome.text })
  }
  const window: WorkerToolWindowEntry[] = []
  for (let index = events.length - 1; index >= 0 && window.length < maxTools; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'tool/call') continue
    const result = results.get(String(event.data.callId))
    if (result === undefined) continue
    window.push({
      seq: event.seq,
      name: event.data.name,
      ok: result.ok,
      arguments: event.data.arguments,
      text: result.text,
    })
  }
  return window.reverse()
}

/**
 * Call ids the charter machinery ran for discrimination probing. These are the
 * harness's own probe runs, whose failure is the probe succeeding, so they are
 * invisible to every failure-counting trigger.
 */
function charterProbeCallIds(events: readonly SessionEvent[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.type === 'jspace/charter-probe'
      || (event.type === 'jspace/charter-run' && event.data.phase === 'probe')) {
      ids.add(String(event.data.callId))
    }
  }
  return ids
}

/**
 * Whether one node of a parsed `tool/call` argument value declares a charter
 * check the harness will discriminate: a check object carrying a `failProbe`, at
 * any depth, because `jspace_open` carries its checks under `charter` while
 * `jspace_charter_amend` nests them under `add` and `replace[].entry`.
 * @param value - one node of the parsed argument value.
 * @returns true when the node declares a probed check.
 */
function declaresProbedCheck(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(declaresProbedCheck)
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (record.kind === 'check' && record.failProbe !== undefined)
    || Object.values(record).some(declaresProbedCheck)
}

/**
 * Whether one call's raw arguments declare a check the harness will probe.
 * @param raw - the `tool/call` event's raw `arguments` string.
 * @returns true when the call registers a probed check.
 */
function declaresProbe(raw: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // The same fallback the chain key takes: argument text that does not parse
    // declares nothing.
    return false
  }
  return declaresProbedCheck(parsed)
}

/**
 * Whether a charter discrimination probe is still in flight: a call that
 * registers a probed check and whose own `tool/result` has not landed yet.
 *
 * The probe's nested check run is dispatched inside that call, and the run's
 * markers (`jspace/charter-run` phase `probe`, then `jspace/charter-probe`) are
 * appended before the call's own result. A verdict taken while the call is open
 * would therefore read the probe's own run, whose failure is the probe
 * succeeding; the registering call's arguments are the one probe signal that is
 * in the log before the probe runs, which is what makes this recognition
 * independent of when the markers land.
 * @param events - the session log or any prefix of it.
 * @returns true when a probe-owning call is unresolved.
 */
export function probeInFlight(events: readonly SessionEvent[]): boolean {
  let open: string | undefined
  for (const event of events) {
    if (event.type === 'tool/call') {
      if (declaresProbe(event.data.arguments)) open = String(event.data.callId)
      continue
    }
    if (event.type !== 'tool/result' || open === undefined) continue
    if (String(event.data.message.source.callId) === open) open = undefined
  }
  return open !== undefined
}

/** One call's logged identity: the name and raw arguments a failed attempt is keyed by. */
interface CallIdentity {
  /** Tool name. */
  readonly name: string
  /** Raw `arguments` string, exactly as the model produced it. */
  readonly arguments: string
}

/** Model-ordered calls by call id. */
function callsById(events: readonly SessionEvent[]): ReadonlyMap<string, CallIdentity> {
  const calls = new Map<string, CallIdentity>()
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    calls.set(String(event.data.callId), { name: event.data.name, arguments: event.data.arguments })
  }
  return calls
}

/**
 * Whether one turn's end reason is a durable failure.
 *
 * The loop records a failed turn as `turn/end { reason: { kind: 'error', error } }`
 * carrying the `LlmError` facts verbatim, so a provider-side class is
 * recoverable from the log. Model-routing's route-failure trigger is the same
 * taxonomy, restated here because that predicate is private to that package: a
 * cancelled turn is not a failure, and the flattened `UNKNOWN` class is not
 * attributable to anything the worker did. `llm/retry` events, prunable error
 * finish chunks, and `aborted` turns are deliberately not counted.
 * @param reason - the turn's end reason.
 * @returns true when the turn failed durably.
 */
function isDurableTurnFailure(reason: TurnEndReason): boolean {
  if (reason.kind !== 'error') return false
  // Read through an unknown-typed view: a replayed log is a durable boundary,
  // so a stored failure may carry no code at all even though the live type
  // requires one, and such a failure is not attributable to the worker.
  const code: unknown = (reason.error as { code?: unknown }).code
  return typeof code === 'string' && code !== 'ABORTED' && code !== 'UNKNOWN'
}

/**
 * One run's length at a fold point, with the newest seq at which it reached the
 * threshold the caller asked about. The length is threshold-independent, which
 * is what lets a trigger fold read `seq` alone while the Stage 1 ask's state
 * reads `count` from the same fold.
 */
interface MeasuredRun {
  /** The run's length at the fold point. */
  readonly count: number
  /** Seq of the newest event at which the run reached the caller's threshold. */
  readonly seq: number | undefined
}

/**
 * Measure the current error burst. A sandbox denial and a charter probe are
 * transparent: they neither count nor reset the run. Any successful
 * tool-sourced result resets it.
 * @param outcomes - every tool-sourced result in log order.
 * @param probes - call ids the charter machinery probed with.
 * @param burst - failure count the caller's threshold asks about.
 * @returns the current run of consecutive failures, and the newest seq at which it reached `burst`.
 */
function errorBurstRun(
  outcomes: readonly ToolOutcome[],
  probes: ReadonlySet<string>,
  burst: number,
): MeasuredRun {
  let count = 0
  let seq: number | undefined
  for (const outcome of outcomes) {
    if (isSandboxDenial(outcome.code, outcome.text) || probes.has(outcome.callId)) continue
    if (outcome.ok) {
      count = 0
      seq = undefined
      continue
    }
    count += 1
    if (count >= burst) seq = outcome.seq
  }
  return { count, seq }
}

/**
 * Measure the failed approaches of one goal epoch. A distinct approach is a
 * distinct `[tool, canonical arguments]` chain key, so repeating one failing
 * call is one approach, not several.
 * @param events - the session log or any prefix of it.
 * @param outcomes - every tool-sourced result in log order.
 * @param calls - model-ordered calls by call id.
 * @param probes - call ids the charter machinery probed with.
 * @param attempts - distinct-approach count the caller's threshold asks about.
 * @param epochAnchorSeq - exclusive lower bound of the goal epoch.
 * @returns the distinct failed approaches since the progress floor, and the newest seq at which they reached `attempts`.
 */
function attemptCountRun(
  events: readonly SessionEvent[],
  outcomes: readonly ToolOutcome[],
  calls: ReadonlyMap<string, CallIdentity>,
  probes: ReadonlySet<string>,
  attempts: number,
  epochAnchorSeq: number,
): MeasuredRun {
  const floor = progressFloor(events, epochAnchorSeq)
  const seen = new Set<string>()
  let seq: number | undefined
  for (const outcome of outcomes) {
    if (outcome.seq <= floor || outcome.ok) continue
    if (isSandboxDenial(outcome.code, outcome.text) || probes.has(outcome.callId)) continue
    const call = calls.get(outcome.callId)
    // The fold reads any prefix of the log, so the call event can sit outside
    // it; the attempt then has no chain identity to count under, and skipping it
    // is what keeps the count to approaches the fold can identify.
    if (call === undefined) continue
    const key = callChainKey(call.name, call.arguments)
    if (seen.has(key)) continue
    seen.add(key)
    if (seen.size >= attempts) seq = outcome.seq
  }
  return { count: seen.size, seq }
}

/**
 * The progress floor of the attempt count: the goal epoch's anchor, advanced
 * to the newest passing charter checkpoint or ship run, because verified
 * progress clears the failures before it.
 */
function progressFloor(events: readonly SessionEvent[], epochAnchorSeq: number): number {
  let floor = epochAnchorSeq
  for (const event of events) {
    if (event.type !== 'jspace/charter-run') continue
    if (event.data.phase === 'probe' || !event.data.passed) continue
    if (event.seq > floor) floor = event.seq
  }
  return floor
}

/**
 * Measure the identical-call chain in force. The chain uses the
 * repeat-tool-reminder guard's semantics: a call identical to the chain's last
 * tracked call extends it, any other call starts a new chain of one, and a
 * source-`user` message resets it entirely.
 * @param events - the session log or any prefix of it.
 * @param runLength - chain length the caller's threshold asks about.
 * @returns the chain length at the fold point, and the newest seq at which it reached `runLength`.
 */
function repeatRunRun(events: readonly SessionEvent[], runLength: number): MeasuredRun {
  let key: string | undefined
  let length = 0
  let seq: number | undefined
  for (const event of events) {
    if (event.type === 'user/message') {
      if (event.data.source.kind === 'user') {
        key = undefined
        length = 0
        seq = undefined
      }
      continue
    }
    if (event.type !== 'tool/call') continue
    const next = callChainKey(event.data.name, event.data.arguments)
    length = key === next ? length + 1 : 1
    key = next
    seq = length >= runLength ? event.seq : undefined
  }
  return { count: length, seq }
}

/**
 * Measure the step-budget stops of one goal epoch.
 * @param events - the session log or any prefix of it.
 * @param exhaustions - stop count the caller's threshold asks about.
 * @param epochAnchorSeq - exclusive lower bound of the goal epoch.
 * @returns the stops on the epoch, and the newest seq at which they reached `exhaustions`.
 */
function stepBudgetRun(events: readonly SessionEvent[], exhaustions: number, epochAnchorSeq: number): MeasuredRun {
  let count = 0
  let seq: number | undefined
  for (const event of events) {
    if (event.type !== 'step-budget/exhausted' || event.seq <= epochAnchorSeq) continue
    count += 1
    if (count >= exhaustions) seq = event.seq
  }
  return { count, seq }
}

/**
 * Measure the durable turn-failure streak in force.
 * @param events - the session log or any prefix of it.
 * @param streak - streak length the caller's threshold asks about.
 * @returns the streak at the fold point, and the newest seq at which it reached `streak`.
 */
function turnFailureRun(events: readonly SessionEvent[], streak: number): MeasuredRun {
  let count = 0
  let seq: number | undefined
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    if (!isDurableTurnFailure(event.data.reason)) {
      count = 0
      seq = undefined
      continue
    }
    count += 1
    if (count >= streak) seq = event.seq
  }
  return { count, seq }
}

/**
 * Fold every trigger's verdict over a worker session's committed events.
 *
 * Each verdict reports the newest event that satisfies its trigger at the fold
 * point, so a standing condition keeps pointing at fresh evidence rather than
 * at the moment it began. Verdicts are reported in
 * {@link ESCALATION_TRIGGERS} order, which is also the order the service
 * resolves a multiple-trigger firing set in.
 * @param events - the session log or any prefix of it.
 * @param config - resolved ladder configuration.
 * @param epochAnchorSeq - exclusive lower bound of the goal epoch: the jspace
 *   card's `goalOpenedSeq`, or -1 to fold the whole log. Only the
 *   epoch-scoped triggers read it.
 * @returns one verdict per trigger.
 */
export function foldEscalationTriggers(
  events: readonly SessionEvent[],
  config: ResolvedWorkerEscalationConfig,
  epochAnchorSeq: number = -1,
): readonly EscalationTriggerOutcome[] {
  const outcomes = toolOutcomes(events)
  const probes = charterProbeCallIds(events)
  const calls = callsById(events)
  const rows = config.triggers
  const fires: Record<EscalationTrigger, number | undefined> = {
    errorBurst: rows.errorBurst.enabled ? errorBurstRun(outcomes, probes, rows.errorBurst.threshold).seq : undefined,
    attemptCount: rows.attemptCount.enabled
      ? attemptCountRun(events, outcomes, calls, probes, rows.attemptCount.threshold, epochAnchorSeq).seq
      : undefined,
    repeatRunLength: rows.repeatRunLength.enabled
      ? repeatRunRun(events, rows.repeatRunLength.threshold).seq
      : undefined,
    stepBudgetExhausted: rows.stepBudgetExhausted.enabled
      ? stepBudgetRun(events, rows.stepBudgetExhausted.threshold, epochAnchorSeq).seq
      : undefined,
    turnFailureStreak: rows.turnFailureStreak.enabled
      ? turnFailureRun(events, rows.turnFailureStreak.threshold).seq
      : undefined,
  }
  return ESCALATION_TRIGGERS.map((trigger) => {
    const seq = fires[trigger]
    return seq === undefined
      ? { trigger, fired: false }
      : { trigger, fired: true, triggerSeq: seq }
  })
}

/**
 * Fold the numbers-first facts the Stage 1 ask's state renders: how the
 * worker's tool calls resolved, the identical-call chain in force, the goal
 * epoch's distinct failed approaches, and the completed steps since its
 * progress floor.
 *
 * Every count comes from the same fold that fires the trigger it measures, at
 * the deployment's own configured threshold, so a state number and a firing
 * verdict cannot drift apart. Enablement is deliberately not read: a trigger
 * the deployment turned off still measures here, because the ask's state is
 * evidence about the worker rather than a verdict on it.
 * @param events - the session log or any prefix of it.
 * @param config - resolved ladder configuration.
 * @param epochAnchorSeq - exclusive lower bound of the goal epoch: the jspace
 *   card's `goalOpenedSeq`, or -1 to fold the whole log.
 * @returns the outcome counts and the run lengths those folds report.
 */
export function foldProgressFacts(
  events: readonly SessionEvent[],
  config: ResolvedWorkerEscalationConfig,
  epochAnchorSeq: number = -1,
): WorkerEscalationProgressFacts {
  const outcomes = toolOutcomes(events)
  const probes = charterProbeCallIds(events)
  const calls = callsById(events)
  const rows = config.triggers
  let ok = 0
  let fail = 0
  for (const outcome of outcomes) {
    if (isSandboxDenial(outcome.code, outcome.text) || probes.has(outcome.callId)) continue
    if (outcome.ok) ok += 1
    else fail += 1
  }
  const floor = progressFloor(events, epochAnchorSeq)
  let steps = 0
  for (const event of events) {
    if (event.type === 'step/end' && event.seq > floor) steps += 1
  }
  return {
    ok,
    fail,
    repeatRunLength: repeatRunRun(events, rows.repeatRunLength.threshold).count,
    attemptCount: attemptCountRun(events, outcomes, calls, probes, rows.attemptCount.threshold, epochAnchorSeq).count,
    stepsSinceCheckpoint: steps,
  }
}

/**
 * Whether the event at `triggerSeq` is the kind of event a named trigger
 * counts. The thresholds are policy and stay out of the companion; this
 * predicate is the config-free half of the trigger contract, and it is what
 * makes an orphaned decision impossible.
 * @param events - session log.
 * @param triggerSeq - the seq a decision claims satisfied its trigger.
 * @param trigger - the trigger family.
 * @returns true when the pointed-at event proves the trigger.
 */
export function triggerSatisfiedAt(
  events: readonly SessionEvent[],
  triggerSeq: number,
  trigger: EscalationTrigger,
): boolean {
  const event = events.find(candidate => candidate.seq === triggerSeq)
  if (event === undefined) return false
  switch (trigger) {
    case 'errorBurst':
    case 'attemptCount': {
      const outcome = toolOutcomeOf(event)
      if (outcome === undefined || outcome.ok) return false
      return !isSandboxDenial(outcome.code, outcome.text)
        && !charterProbeCallIds(events).has(outcome.callId)
    }
    case 'repeatRunLength':
      return event.type === 'tool/call'
    case 'stepBudgetExhausted':
      return event.type === 'step-budget/exhausted'
    case 'turnFailureStreak':
      return event.type === 'turn/end' && isDurableTurnFailure(event.data.reason)
    default:
      return assertNever(trigger)
  }
}

/** The aging state one goal epoch reaches: its continue resolutions and the terminal latch. */
export interface EscalationAgingState {
  /** Continue resolutions the epoch has taken. */
  readonly continues: number
  /** Seq of the newest continue resolution; absent before the first. */
  readonly lastContinueSeq?: number
  /** Whether the epoch already reported the worker blocked, which is its one-shot terminal. */
  readonly reportBlocked: boolean
}

/**
 * Fold the aging state of one goal epoch.
 * @param events - the session log or any prefix of it.
 * @param epochAnchorSeq - exclusive lower bound of the goal epoch: the jspace
 *   card's `goalOpenedSeq`, or -1 to fold the whole log.
 * @returns the epoch's continue count, its newest continue seq, and whether its
 *   terminal already fired.
 */
export function foldEscalationAging(events: readonly SessionEvent[], epochAnchorSeq: number = -1): EscalationAgingState {
  let continues = 0
  let lastContinueSeq: number | undefined
  let reportBlocked = false
  for (const event of events) {
    if (event.type !== 'escalation/decision' || event.seq <= epochAnchorSeq) continue
    if (event.data.choice === 'report-blocked') {
      reportBlocked = true
      continue
    }
    continues += 1
    lastContinueSeq = event.seq
  }
  return {
    continues,
    reportBlocked,
    ...lastContinueSeq === undefined ? {} : { lastContinueSeq },
  }
}

/** The step cooldown state of one goal epoch. */
export interface EscalationCooldownState {
  /** Seq of the newest ladder decision in the epoch; absent before the first. */
  readonly lastDecisionSeq?: number
  /** Completed steps since that decision, or since the epoch's anchor when there is none. */
  readonly stepsSinceLastDecision: number
}

/**
 * Fold the step cooldown the ladder gates on: completed steps since the newest
 * decision, so a standing trigger cannot write a decision per event.
 * @param events - the session log or any prefix of it.
 * @param epochAnchorSeq - exclusive lower bound of the goal epoch: the jspace
 *   card's `goalOpenedSeq`, or -1 to fold the whole log.
 * @returns the newest decision seq and the completed steps since it.
 */
export function foldEscalationCooldown(
  events: readonly SessionEvent[],
  epochAnchorSeq: number = -1,
): EscalationCooldownState {
  let lastDecisionSeq: number | undefined
  for (const event of events) {
    if (event.type === 'escalation/decision' && event.seq > epochAnchorSeq) lastDecisionSeq = event.seq
  }
  const from = lastDecisionSeq ?? epochAnchorSeq
  let steps = 0
  for (const event of events) {
    if (event.type === 'step/end' && event.seq > from) steps += 1
  }
  return {
    stepsSinceLastDecision: steps,
    ...lastDecisionSeq === undefined ? {} : { lastDecisionSeq },
  }
}
