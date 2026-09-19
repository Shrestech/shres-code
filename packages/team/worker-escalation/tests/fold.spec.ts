/**
 * The trigger table, the aging counter, and the step cooldown over a bare
 * session log. Each verdict names the newest event that satisfies its trigger,
 * so a standing condition keeps pointing at fresh evidence; the exclusions
 * (sandbox denials, charter discrimination probes) and the resets (a passing
 * checkpoint for `attemptCount`, a source-`user` message for
 * `repeatRunLength`) are pinned here because they decide whether a worker is
 * reported as stuck at all.
 *
 * The logs are bare event arrays: a fold reads only what a case appends, so no
 * store, invariant host, or service topology enters these cases.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@shres-code/shres-code-session'
import { resolveConfig } from '../src/config.ts'
import type {
  EscalationAttemptCountConfig,
  EscalationErrorBurstConfig,
  EscalationRepeatRunLengthConfig,
  EscalationStepBudgetExhaustedConfig,
  EscalationTurnFailureStreakConfig,
  ResolvedWorkerEscalationConfig,
  WorkerEscalationTriggerTable,
} from '../src/config.ts'
import {
  callChainKey,
  canonicalizeArguments,
  foldEscalationAging,
  foldEscalationCooldown,
  foldEscalationTriggers,
  isSandboxDenial,
} from '../src/fold.ts'
import type { EscalationDecision, EscalationTrigger, EscalationTriggerOutcome } from '../src/types.ts'

/** One logged event carrying only the fields the folds read. */
function event(type: string, seq: number, data: unknown): SessionEvent {
  return { type, seq, time: 0, data } as unknown as SessionEvent
}

/** One `tool/call` with the raw argument string the model produced. */
function call(seq: number, callId: string, name: string, args = '{}'): SessionEvent {
  return event('tool/call', seq, { turn: 1, step: 1, callId, name, arguments: args })
}

/** One tool-sourced result; a failure carries `isError` and an optional model-facing text. */
function toolResult(seq: number, callId: string, failure?: { readonly text?: string; readonly code?: string }): SessionEvent {
  return event('tool/result', seq, {
    turn: 1,
    step: 1,
    message: {
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        isError: failure !== undefined,
        content: failure?.text === undefined || failure.text.length === 0
          ? []
          : [{ type: 'text', text: failure.text }],
      }],
    },
    ...failure?.code === undefined ? {} : { error: { name: 'ToolError', code: failure.code } },
  })
}

/** One failed attempt, as a tool writes it: an errored result carrying its text. */
function failed(seq: number, callId: string, text = 'boom'): SessionEvent {
  return event('tool/result', seq, {
    turn: 1,
    step: 1,
    message: {
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text }] }],
    },
  })
}

/** A filesystem sandbox denial carried as the structured code. */
function sandboxDenied(seq: number, callId: string): SessionEvent {
  return toolResult(seq, callId, { code: 'FS_SANDBOX_DENIED', text: 'FS_SANDBOX_DENIED' })
}

/** A refusal reaching the log only as the marker the enforcing tool family renders. */
function sandboxMarked(seq: number, callId: string): SessionEvent {
  return toolResult(seq, callId, { text: '[sandbox: file access denied under workspace-write mode]' })
}

/** One charter discrimination probe: a harness run whose failure is the probe succeeding. */
function charterProbe(seq: number, callId: string): SessionEvent {
  return event('jspace/charter-probe', seq, {
    entryId: 'check-1',
    callId,
    path: '/tmp/probe.txt',
    mutationKind: 'insert',
    demonstrated: true,
  })
}

/** One nested charter check execution, of the given phase and outcome. */
function charterRun(seq: number, phase: 'checkpoint' | 'ship' | 'probe', passed: boolean, callId = 'charter-bash'): SessionEvent {
  return event('jspace/charter-run', seq, {
    entryId: 'check-1',
    callId,
    parentCallId: 'jspace-call',
    phase,
    command: 'true',
    passed,
    outputPreview: '',
  })
}

/** One completed step. */
function stepEnd(seq: number): SessionEvent {
  return event('step/end', seq, { turn: 1, step: 1 })
}

/** One step-budget stop. */
function stepBudgetStop(seq: number): SessionEvent {
  return event('step-budget/exhausted', seq, { turn: 1, step: 3, limit: 2 })
}

/** One closed turn with an explicit end reason. */
function turnEnd(seq: number, reason: unknown): SessionEvent {
  return event('turn/end', seq, { turn: 1, reason })
}

/** A durable turn failure: an `error` reason carrying a model-routing class. */
function failedTurn(seq: number, code: string): SessionEvent {
  return turnEnd(seq, { kind: 'error', error: { message: 'the route failed', code } })
}

/** One user-role message of a given source kind. */
function userMessage(seq: number, kind: 'user' | 'team-message'): SessionEvent {
  return event('user/message', seq, { source: { kind }, content: [{ type: 'text', text: 'hello' }] })
}

/** One logged ladder decision. */
function decision(seq: number, data: EscalationDecision): SessionEvent {
  return event('escalation/decision', seq, data)
}

/** One `continue` decision recording the aging state after itself. */
function continued(seq: number, continues: number): SessionEvent {
  return decision(seq, { trigger: 'errorBurst', triggerSeq: 1, choice: 'continue', engine: 'absent', aging: { continues, lastContinueSeq: seq } })
}

/** The terminal decision, which records its inherited continue count. */
function reportedBlocked(seq: number, continues: number): SessionEvent {
  return decision(seq, { trigger: 'errorBurst', triggerSeq: 1, choice: 'report-blocked', engine: 'absent', aging: { continues } })
}

/** Any one row's own fields. */
type TriggerRow =
  | EscalationErrorBurstConfig
  | EscalationAttemptCountConfig
  | EscalationRepeatRunLengthConfig
  | EscalationStepBudgetExhaustedConfig
  | EscalationTurnFailureStreakConfig

/** The ladder fields outside the trigger table a case may vary. */
interface OnlyRest {
  readonly maxContinues?: number
  readonly maxArbiterDepth?: number
  readonly minStepsBetween?: number
}

/** Resolved config with one row enabled at its own count and every other row disabled. */
function only(trigger: EscalationTrigger, row: TriggerRow, rest: OnlyRest = {}): ResolvedWorkerEscalationConfig {
  const on = (name: EscalationTrigger) => name === trigger
  const table: WorkerEscalationTriggerTable = {
    errorBurst: { enabled: on('errorBurst'), ...on('errorBurst') ? row : {} },
    attemptCount: { enabled: on('attemptCount'), ...on('attemptCount') ? row : {} },
    repeatRunLength: { enabled: on('repeatRunLength'), ...on('repeatRunLength') ? row : {} },
    stepBudgetExhausted: { enabled: on('stepBudgetExhausted'), ...on('stepBudgetExhausted') ? row : {} },
    turnFailureStreak: { enabled: on('turnFailureStreak'), ...on('turnFailureStreak') ? row : {} },
  }
  return resolveConfig({ enabled: true, ...rest, triggers: table })
}

/** One trigger's verdict over a log, at an exclusive goal-epoch lower bound. */
function verdict(
  events: readonly SessionEvent[],
  trigger: EscalationTrigger,
  config: ResolvedWorkerEscalationConfig,
  anchor = -1,
): EscalationTriggerOutcome {
  const outcome = foldEscalationTriggers(events, config, anchor).find(candidate => candidate.trigger === trigger)
  if (outcome === undefined) throw new Error(`the fold reported no verdict for ${trigger}`)
  return outcome
}

describe('the trigger table', () => {
  it('reports one verdict per trigger, in table order, all unfired over an empty log', () => {
    expect(foldEscalationTriggers([], resolveConfig({ enabled: true }))).toEqual([
      { trigger: 'errorBurst', fired: false },
      { trigger: 'attemptCount', fired: false },
      { trigger: 'repeatRunLength', fired: false },
      { trigger: 'stepBudgetExhausted', fired: false },
      { trigger: 'turnFailureStreak', fired: false },
    ])
  })

  it('omits triggerSeq from an unfired verdict', () => {
    expect(Object.keys(verdict([], 'errorBurst', resolveConfig({ enabled: true }))).sort()).toEqual(['fired', 'trigger'])
  })

  it('keeps a disabled trigger unfired while its own condition holds', () => {
    const events = [
      call(1, 'c1', 'bash', '{"command":"a"}'),
      failed(2, 'c1'),
      call(3, 'c2', 'bash', '{"command":"b"}'),
      failed(4, 'c2'),
    ]
    const config = only('attemptCount', { attempts: 2 })
    expect(verdict(events, 'errorBurst', config)).toEqual({ trigger: 'errorBurst', fired: false })
    expect(verdict(events, 'attemptCount', config)).toEqual({ trigger: 'attemptCount', fired: true, triggerSeq: 4 })
  })
})

describe('errorBurst', () => {
  /** Two consecutive failures of different approaches, the shortest burst. */
  const twoFailures = [
    call(1, 'c1', 'bash', '{"command":"a"}'),
    failed(2, 'c1'),
    call(3, 'c2', 'bash', '{"command":"b"}'),
    failed(4, 'c2'),
  ]

  it('fires at the second consecutive failure and not at the first', () => {
    const config = only('errorBurst', { burst: 2 })
    expect(verdict(twoFailures.slice(0, 2), 'errorBurst', config)).toEqual({ trigger: 'errorBurst', fired: false })
    expect(verdict(twoFailures, 'errorBurst', config)).toEqual({ trigger: 'errorBurst', fired: true, triggerSeq: 4 })
  })

  it('keeps a standing burst pointing at its newest failure', () => {
    const config = only('errorBurst', { burst: 2 })
    const events = [...twoFailures, call(5, 'c3', 'bash', '{"command":"c"}'), failed(6, 'c3')]
    expect(verdict(events, 'errorBurst', config)).toEqual({ trigger: 'errorBurst', fired: true, triggerSeq: 6 })
  })

  it('resets the burst on a successful result: FAIL, ok, FAIL does not fire', () => {
    const config = only('errorBurst', { burst: 2 })
    const events = [
      call(1, 'c1', 'bash'),
      failed(2, 'c1'),
      call(3, 'c2', 'read'),
      toolResult(4, 'c2'),
      call(5, 'c3', 'bash'),
      failed(6, 'c3'),
    ]
    expect(verdict(events, 'errorBurst', config)).toEqual({ trigger: 'errorBurst', fired: false })
  })

  it('treats a sandbox denial as transparent: it neither counts nor resets the burst', () => {
    const config = only('errorBurst', { burst: 2 })
    const across = [
      call(1, 'c1', 'bash'),
      failed(2, 'c1'),
      call(3, 'c2', 'read'),
      sandboxMarked(4, 'c2'),
      call(5, 'c3', 'bash'),
      failed(6, 'c3'),
    ]
    // The denial is invisible, so the two real failures complete the burst across it.
    expect(verdict(across, 'errorBurst', config)).toEqual({ trigger: 'errorBurst', fired: true, triggerSeq: 6 })
    const denialOnly = [
      call(1, 'c1', 'bash'),
      failed(2, 'c1'),
      call(3, 'c2', 'read'),
      sandboxMarked(4, 'c2'),
    ]
    // The denial alone never counts toward one.
    expect(verdict(denialOnly, 'errorBurst', config)).toEqual({ trigger: 'errorBurst', fired: false })
  })

  it('reads a denial from the structured code and from the rendered marker alike', () => {
    const config = only('errorBurst', { burst: 2 })
    for (const denial of [sandboxDenied(2, 'c1'), sandboxMarked(2, 'c1')]) {
      expect(verdict([call(1, 'c1', 'bash'), denial], 'errorBurst', config)).toEqual({ trigger: 'errorBurst', fired: false })
    }
    expect(isSandboxDenial('FS_SANDBOX_DENIED', '')).toBe(true)
    expect(isSandboxDenial(undefined, '[sandbox: file access denied under read-only mode]')).toBe(true)
    expect(isSandboxDenial('TOOL_ERROR', '[sandbox: file access denied under workspace-write mode]')).toBe(true)
    expect(isSandboxDenial('TOOL_ERROR', 'command not found')).toBe(false)
  })

  it('treats a charter discrimination probe as transparent', () => {
    const config = only('errorBurst', { burst: 2 })
    const markedCall = [
      charterProbe(1, 'probe-call'),
      call(2, 'probe-call', 'bash'),
      failed(3, 'probe-call'),
      call(4, 'real', 'bash'),
      failed(5, 'real'),
    ]
    // Call 2 failed, but it is the probe's own run, so the burst never reaches two.
    expect(verdict(markedCall, 'errorBurst', config)).toEqual({ trigger: 'errorBurst', fired: false })
    const phaseProbe = [
      charterRun(1, 'probe', false, 'nested'),
      call(2, 'nested', 'bash'),
      failed(3, 'nested'),
    ]
    expect(verdict(phaseProbe, 'errorBurst', config)).toEqual({ trigger: 'errorBurst', fired: false })
    // A checkpoint run's own failure is real evidence of a failing approach.
    const checkpoint = [
      charterRun(1, 'checkpoint', false, 'nested'),
      call(2, 'nested', 'bash'),
      failed(3, 'nested'),
    ]
    expect(verdict(checkpoint, 'errorBurst', config)).toEqual({ trigger: 'errorBurst', fired: false })
    expect(verdict([
      ...checkpoint,
      call(4, 'other', 'read'),
      failed(5, 'other'),
    ], 'errorBurst', config)).toEqual({ trigger: 'errorBurst', fired: true, triggerSeq: 5 })
  })

  it('reads a result whose content carries no text', () => {
    const config = only('errorBurst', { burst: 2 })
    const empty = event('tool/result', 2, {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId: 'c1' },
        content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: '' }] }],
      },
    })
    // The empty-text result still counts as the first failure of the burst.
    expect(verdict([call(1, 'c1', 'bash'), empty], 'errorBurst', config))
      .toEqual({ trigger: 'errorBurst', fired: false })
    expect(verdict([
      call(1, 'c1', 'bash'),
      empty,
      call(3, 'c2', 'bash', '{"command":"b"}'),
      failed(4, 'c2'),
    ], 'errorBurst', config)).toEqual({ trigger: 'errorBurst', fired: true, triggerSeq: 4 })
  })

  it('honours a raised burst count', () => {
    const config = only('errorBurst', { burst: 3 })
    expect(verdict(twoFailures, 'errorBurst', config)).toEqual({ trigger: 'errorBurst', fired: false })
    const three = [...twoFailures, call(5, 'c3', 'bash', '{"command":"c"}'), failed(6, 'c3')]
    expect(verdict(three, 'errorBurst', config)).toEqual({ trigger: 'errorBurst', fired: true, triggerSeq: 6 })
  })
})

describe('attemptCount', () => {
  /** Three distinct failed approaches, each a call plus its failing result. */
  const distinctFailures = [
    call(1, 'c1', 'bash', '{"command":"a"}'),
    failed(2, 'c1'),
    call(3, 'c2', 'read', '{"file_path":"/a"}'),
    failed(4, 'c2'),
    call(5, 'c3', 'grep', '{"pattern":"x"}'),
    failed(6, 'c3'),
  ]

  it('counts distinct failed approaches and fires at the threshold approach', () => {
    const three = only('attemptCount', { attempts: 3 })
    expect(verdict(distinctFailures.slice(0, 4), 'attemptCount', three)).toEqual({ trigger: 'attemptCount', fired: false })
    expect(verdict(distinctFailures, 'attemptCount', three)).toEqual({ trigger: 'attemptCount', fired: true, triggerSeq: 6 })
    // A standing count keeps pointing at the newest distinct failure.
    expect(verdict(distinctFailures, 'attemptCount', only('attemptCount', { attempts: 2 })))
      .toEqual({ trigger: 'attemptCount', fired: true, triggerSeq: 6 })
  })

  it('keys a repeated failing call to one approach, not several', () => {
    const config = only('attemptCount', { attempts: 2 })
    const repeated = [
      call(1, 'c1', 'bash', '{"command":"a","timeout":1}'),
      failed(2, 'c1'),
      // The same call with the same arguments in a different property order.
      call(3, 'c2', 'bash', '{"timeout":1,"command":"a"}'),
      failed(4, 'c2'),
      call(5, 'c3', 'bash', '{"command":"a","timeout":1}'),
      failed(6, 'c3'),
    ]
    expect(verdict(repeated, 'attemptCount', config)).toEqual({ trigger: 'attemptCount', fired: false })
    const second = [...repeated, call(7, 'c4', 'bash', '{"command":"b"}'), failed(8, 'c4')]
    expect(verdict(second, 'attemptCount', config)).toEqual({ trigger: 'attemptCount', fired: true, triggerSeq: 8 })
  })

  it('keeps counting across successful results', () => {
    const config = only('attemptCount', { attempts: 2 })
    const events = [
      call(1, 'c1', 'bash', '{"command":"a"}'),
      failed(2, 'c1'),
      call(3, 'c2', 'read', '{"file_path":"/a"}'),
      toolResult(4, 'c2'),
      call(5, 'c3', 'grep', '{"pattern":"x"}'),
      failed(6, 'c3'),
    ]
    expect(verdict(events, 'attemptCount', config)).toEqual({ trigger: 'attemptCount', fired: true, triggerSeq: 6 })
  })

  it('restarts the count at a passing charter checkpoint', () => {
    const config = only('attemptCount', { attempts: 2 })
    const events = [
      call(1, 'c1', 'bash', '{"command":"a"}'),
      failed(2, 'c1'),
      call(3, 'c2', 'read', '{"file_path":"/a"}'),
      failed(4, 'c2'),
      // Verified progress clears the failures before it.
      charterRun(5, 'checkpoint', true),
      call(6, 'c3', 'bash', '{"command":"b"}'),
      failed(7, 'c3'),
    ]
    expect(verdict(events, 'attemptCount', config)).toEqual({ trigger: 'attemptCount', fired: false })
    const reaching = [...events, call(8, 'c4', 'read', '{"file_path":"/b"}'), failed(9, 'c4')]
    expect(verdict(reaching, 'attemptCount', config)).toEqual({ trigger: 'attemptCount', fired: true, triggerSeq: 9 })
  })

  it('moves the floor only at a passing checkpoint or ship run', () => {
    const config = only('attemptCount', { attempts: 2 })
    const base = [
      call(1, 'c1', 'bash', '{"command":"a"}'),
      failed(2, 'c1'),
      call(3, 'c2', 'read', '{"file_path":"/a"}'),
      failed(4, 'c2'),
    ]
    // A failed checkpoint proves nothing, so the two failures still count.
    expect(verdict([...base, charterRun(5, 'checkpoint', false)], 'attemptCount', config))
      .toEqual({ trigger: 'attemptCount', fired: true, triggerSeq: 4 })
    // A probe-phase run is not progress either, passing or not.
    expect(verdict([...base, charterRun(5, 'probe', true)], 'attemptCount', config))
      .toEqual({ trigger: 'attemptCount', fired: true, triggerSeq: 4 })
    // A passing ship run is.
    expect(verdict([...base, charterRun(5, 'ship', true)], 'attemptCount', config))
      .toEqual({ trigger: 'attemptCount', fired: false })
  })

  it('excludes sandbox denials and charter probes from the count', () => {
    const config = only('attemptCount', { attempts: 2 })
    const denied = [
      call(1, 'c1', 'bash', '{"command":"a"}'),
      sandboxDenied(2, 'c1'),
      call(3, 'c2', 'bash', '{"command":"b"}'),
      sandboxMarked(4, 'c2'),
    ]
    expect(verdict(denied, 'attemptCount', config)).toEqual({ trigger: 'attemptCount', fired: false })
    const probed = [
      charterProbe(1, 'probe-call'),
      call(2, 'probe-call', 'bash', '{"command":"a"}'),
      failed(3, 'probe-call'),
      call(4, 'real', 'bash', '{"command":"a"}'),
      failed(5, 'real'),
    ]
    expect(verdict(probed, 'attemptCount', config)).toEqual({ trigger: 'attemptCount', fired: false })
  })

  it('cannot lower the floor with a passing run that precedes the anchor', () => {
    const config = only('attemptCount', { attempts: 1 })
    const events = [
      charterRun(1, 'checkpoint', true),
      call(2, 'c1', 'bash', '{"command":"a"}'),
      failed(3, 'c1'),
    ]
    // The epoch opens after both events, so the passing run sets no floor of its own.
    expect(verdict(events, 'attemptCount', config, 5)).toEqual({ trigger: 'attemptCount', fired: false })
  })

  it('honours the goal epoch anchor', () => {
    const config = only('attemptCount', { attempts: 2 })
    const events = [
      ...distinctFailures,
      // A new goal epoch opens after every earlier failure.
      event('jspace/card', 7, { goal: 'next assignment', goalOpenedSeq: 6 }),
    ]
    expect(verdict(events, 'attemptCount', config, 6)).toEqual({ trigger: 'attemptCount', fired: false })
    expect(verdict(events, 'attemptCount', config)).toEqual({ trigger: 'attemptCount', fired: true, triggerSeq: 6 })
  })

  it('ignores a failure whose call is absent from the log', () => {
    expect(verdict([
      failed(1, 'orphan'),
      call(2, 'c1', 'read', '{"file_path":"/a"}'),
      failed(3, 'c1'),
    ], 'attemptCount', only('attemptCount', { attempts: 1 })))
      .toEqual({ trigger: 'attemptCount', fired: true, triggerSeq: 3 })
  })

  it('canonicalizes arguments as JSON, falling back to the raw string', () => {
    expect(canonicalizeArguments('{"b":1,"a":[2,3]}')).toBe('{"a":[2,3],"b":1}')
    expect(canonicalizeArguments('{"a":[{"z":1,"y":2}]}')).toBe('{"a":[{"y":2,"z":1}]}')
    expect(canonicalizeArguments('not json')).toBe('"not json"')
    expect(callChainKey('bash', '{"a":1,"b":2}')).toBe(callChainKey('bash', '{"b":2,"a":1}'))
    expect(callChainKey('bash', '{"a":1}')).not.toBe(callChainKey('read', '{"a":1}'))
  })
})

describe('repeatRunLength', () => {
  /** One call of the one chain identity this suite repeats. */
  const identical = (seq: number, callId: string): SessionEvent =>
    call(seq, callId, 'bash', '{"command":"pnpm test","timeout":1}')

  it('fires at the chain length and not before', () => {
    const config = only('repeatRunLength', { runLength: 3 })
    const chain = [identical(1, 'c1'), identical(2, 'c2'), identical(3, 'c3')]
    expect(verdict(chain.slice(0, 2), 'repeatRunLength', config)).toEqual({ trigger: 'repeatRunLength', fired: false })
    expect(verdict(chain, 'repeatRunLength', config)).toEqual({ trigger: 'repeatRunLength', fired: true, triggerSeq: 3 })
  })

  it('treats a different argument as a new chain of one', () => {
    const config = only('repeatRunLength', { runLength: 2 })
    const events = [
      identical(1, 'c1'),
      // Same tool, different arguments: the chain restarts, so this call is not a repeat.
      call(2, 'c2', 'bash', '{"command":"pnpm lint"}'),
      identical(3, 'c3'),
    ]
    expect(verdict(events, 'repeatRunLength', config)).toEqual({ trigger: 'repeatRunLength', fired: false })
    expect(verdict([...events, identical(4, 'c4')], 'repeatRunLength', config))
      .toEqual({ trigger: 'repeatRunLength', fired: true, triggerSeq: 4 })
  })

  it('treats a different tool with the same arguments as a new chain', () => {
    const config = only('repeatRunLength', { runLength: 2 })
    const events = [identical(1, 'c1'), call(2, 'c2', 'read', '{"command":"pnpm test","timeout":1}')]
    expect(verdict(events, 'repeatRunLength', config)).toEqual({ trigger: 'repeatRunLength', fired: false })
  })

  it('ignores every event that is not a tool call', () => {
    const config = only('repeatRunLength', { runLength: 2 })
    const events = [
      identical(1, 'c1'),
      failed(2, 'c1'),
      stepEnd(3),
      // Team mail is not a human interjection, so the chain survives it.
      userMessage(4, 'team-message'),
      identical(5, 'c2'),
    ]
    expect(verdict(events, 'repeatRunLength', config)).toEqual({ trigger: 'repeatRunLength', fired: true, triggerSeq: 5 })
  })

  it('resets the chain on a human user message', () => {
    const config = only('repeatRunLength', { runLength: 2 })
    const events = [identical(1, 'c1'), userMessage(2, 'user'), identical(3, 'c2')]
    expect(verdict(events, 'repeatRunLength', config)).toEqual({ trigger: 'repeatRunLength', fired: false })
  })

  it('clears a standing chain verdict when a different call arrives', () => {
    const config = only('repeatRunLength', { runLength: 2 })
    const events = [identical(1, 'c1'), identical(2, 'c2'), call(3, 'c3', 'read', '{"file_path":"/a"}')]
    expect(verdict(events, 'repeatRunLength', config)).toEqual({ trigger: 'repeatRunLength', fired: false })
  })

  it('compares argument text that is not JSON exactly', () => {
    const config = only('repeatRunLength', { runLength: 2 })
    const events = [call(1, 'c1', 'bash', 'not json'), call(2, 'c2', 'bash', 'not json')]
    expect(verdict(events, 'repeatRunLength', config)).toEqual({ trigger: 'repeatRunLength', fired: true, triggerSeq: 2 })
    expect(verdict([...events, call(3, 'c3', 'bash', 'other')], 'repeatRunLength', config))
      .toEqual({ trigger: 'repeatRunLength', fired: false })
  })
})

describe('stepBudgetExhausted', () => {
  it('fires at the first stop by default and honours a raised count', () => {
    expect(verdict([stepBudgetStop(1)], 'stepBudgetExhausted', only('stepBudgetExhausted', {})))
      .toEqual({ trigger: 'stepBudgetExhausted', fired: true, triggerSeq: 1 })
    const two = [stepBudgetStop(1), stepBudgetStop(2)]
    expect(verdict(two, 'stepBudgetExhausted', only('stepBudgetExhausted', { exhaustions: 2 })))
      .toEqual({ trigger: 'stepBudgetExhausted', fired: true, triggerSeq: 2 })
    expect(verdict(two.slice(0, 1), 'stepBudgetExhausted', only('stepBudgetExhausted', { exhaustions: 2 })))
      .toEqual({ trigger: 'stepBudgetExhausted', fired: false })
  })

  it('does not fire without a stop, and ignores stops at or before the anchor', () => {
    const events = [stepBudgetStop(1), stepBudgetStop(2)]
    expect(verdict([stepEnd(1)], 'stepBudgetExhausted', only('stepBudgetExhausted', {})))
      .toEqual({ trigger: 'stepBudgetExhausted', fired: false })
    expect(verdict(events, 'stepBudgetExhausted', only('stepBudgetExhausted', {}), 1))
      .toEqual({ trigger: 'stepBudgetExhausted', fired: true, triggerSeq: 2 })
    expect(verdict(events, 'stepBudgetExhausted', only('stepBudgetExhausted', {}), 2))
      .toEqual({ trigger: 'stepBudgetExhausted', fired: false })
  })
})

describe('turnFailureStreak', () => {
  it('fires at the streak length and resets on any other turn end', () => {
    const config = only('turnFailureStreak', { streak: 2 })
    expect(verdict([failedTurn(1, 'RATE_LIMIT')], 'turnFailureStreak', config))
      .toEqual({ trigger: 'turnFailureStreak', fired: false })
    expect(verdict([failedTurn(1, 'RATE_LIMIT'), failedTurn(2, 'RATE_LIMIT')], 'turnFailureStreak', config))
      .toEqual({ trigger: 'turnFailureStreak', fired: true, triggerSeq: 2 })
    for (const reason of [{ kind: 'completed' }, { kind: 'blocked' }, { kind: 'aborted', reason: { kind: 'user' } }]) {
      expect(verdict([failedTurn(1, 'RATE_LIMIT'), turnEnd(2, reason), failedTurn(3, 'RATE_LIMIT')], 'turnFailureStreak', config))
        .toEqual({ trigger: 'turnFailureStreak', fired: false })
    }
  })

  it('excludes the ABORTED and UNKNOWN classes the model-routing taxonomy excludes', () => {
    const config = only('turnFailureStreak', { streak: 2 })
    for (const code of ['ABORTED', 'UNKNOWN']) {
      expect(verdict([failedTurn(1, 'RATE_LIMIT'), failedTurn(2, code)], 'turnFailureStreak', config))
        .toEqual({ trigger: 'turnFailureStreak', fired: false })
      // An excluded class resets the run rather than passing through it.
      expect(verdict([failedTurn(1, code), failedTurn(2, 'RATE_LIMIT'), failedTurn(3, 'RATE_LIMIT')], 'turnFailureStreak', config))
        .toEqual({ trigger: 'turnFailureStreak', fired: true, triggerSeq: 3 })
    }
  })

  it('does not count a failure the log recorded no string code on', () => {
    const config = only('turnFailureStreak', { streak: 2 })
    const codeless = turnEnd(2, { kind: 'error', error: { message: 'flattened with no code' } })
    expect(verdict([failedTurn(1, 'RATE_LIMIT'), codeless], 'turnFailureStreak', config))
      .toEqual({ trigger: 'turnFailureStreak', fired: false })
    const nonStringCode = turnEnd(2, { kind: 'error', error: { message: 'boom', code: 503 } })
    expect(verdict([failedTurn(1, 'RATE_LIMIT'), nonStringCode], 'turnFailureStreak', config))
      .toEqual({ trigger: 'turnFailureStreak', fired: false })
  })

  it('ignores non-turn events between failures', () => {
    const events = [
      failedTurn(1, 'RATE_LIMIT'),
      stepEnd(2),
      call(3, 'c1', 'bash'),
      failed(4, 'c1'),
      failedTurn(5, 'RATE_LIMIT'),
    ]
    expect(verdict(events, 'turnFailureStreak', only('turnFailureStreak', { streak: 2 })))
      .toEqual({ trigger: 'turnFailureStreak', fired: true, triggerSeq: 5 })
  })
})

describe('foldEscalationAging', () => {
  it('folds an empty epoch to no continues, no last-continue seq, and no terminal', () => {
    expect(foldEscalationAging([])).toEqual({ continues: 0, reportBlocked: false })
  })

  it('counts continue resolutions and points at the newest one', () => {
    expect(foldEscalationAging([continued(1, 1), continued(5, 2)]))
      .toEqual({ continues: 2, lastContinueSeq: 5, reportBlocked: false })
  })

  it('latches the report-blocked terminal without counting it as a continue', () => {
    expect(foldEscalationAging([continued(1, 1), reportedBlocked(4, 1)]))
      .toEqual({ continues: 1, lastContinueSeq: 1, reportBlocked: true })
  })

  it('excludes every decision at or below the epoch anchor', () => {
    const events = [continued(1, 1), continued(4, 2), reportedBlocked(6, 2)]
    expect(foldEscalationAging(events, 4)).toEqual({ continues: 0, reportBlocked: true })
    expect(foldEscalationAging(events, 3)).toEqual({ continues: 1, lastContinueSeq: 4, reportBlocked: true })
    expect(foldEscalationAging(events, 0)).toEqual({ continues: 2, lastContinueSeq: 4, reportBlocked: true })
  })
})

describe('foldEscalationCooldown', () => {
  it('counts every completed step of an epoch with no decision', () => {
    expect(foldEscalationCooldown([stepEnd(1), stepEnd(2), stepEnd(3)]))
      .toEqual({ stepsSinceLastDecision: 3 })
  })

  it('counts steps after the newest decision and reports its seq', () => {
    expect(foldEscalationCooldown([stepEnd(1), continued(2, 1), stepEnd(3), stepEnd(4)]))
      .toEqual({ lastDecisionSeq: 2, stepsSinceLastDecision: 2 })
  })

  it('takes the newest decision of any choice', () => {
    expect(foldEscalationCooldown([continued(1, 1), reportedBlocked(3, 1), stepEnd(4)]))
      .toEqual({ lastDecisionSeq: 3, stepsSinceLastDecision: 1 })
  })

  it('falls back to the epoch anchor for a decision outside the epoch', () => {
    expect(foldEscalationCooldown([continued(1, 1), stepEnd(3), stepEnd(4)], 2))
      .toEqual({ stepsSinceLastDecision: 2 })
  })
})
