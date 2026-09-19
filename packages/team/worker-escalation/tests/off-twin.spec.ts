/**
 * Composed-but-off byte identity: the same worker session log — two failing
 * approaches, completed steps, a step-budget stop, and two failed turns —
 * written with the ladder composed at `enabled: false` and with the package
 * absent from the composition entirely. The two durable logs are identical, so
 * a deployment that composes the ladder off cannot tell it is there.
 *
 * Wall-clock stamps are dropped from the comparison (they are not part of the
 * claim) and every seq, payload, marker, and reference is compared. The third
 * case in this file runs the same script with the ladder on, so the twin is a
 * claim about a live script rather than an inert one.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { CallId, MessageId } from '@shres-code/shres-code-llm'
import type { MessageSource, ToolResultMessage, UserMessage } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import type { Session } from '@shres-code/shres-code-session'
import * as WorkerEscalation from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
})

/** Flush the microtask the ladder evaluates from. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * Boot one arm and create its worker session.
 * @param composed - `off` mounts the ladder at `enabled: false`; `absent`
 *   mounts no ladder at all; `on` mounts it enabled.
 * @returns the live worker session.
 */
async function boot(composed: 'off' | 'absent' | 'on'): Promise<Session> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  if (composed !== 'absent') await ctx.plugin(WorkerEscalation, { enabled: composed === 'on' })
  return ctx.sessions.create(SessionId('worker-twin'), { meta: { delegationDepth: 1 } })
}

/**
 * One user-role message with a fixed identity, so both arms write the same
 * bytes: a random message id would differ between two runs of the same
 * composition and prove nothing about the ladder.
 * @param id - fixed message identity.
 * @param text - message text.
 * @param source - message source.
 * @returns the message.
 */
function message(id: string, text: string, source: MessageSource): UserMessage {
  return { id: MessageId(id), role: 'user', content: [{ type: 'text', text }], source }
}

/**
 * One tool-result message with a fixed identity.
 * @param id - fixed message identity.
 * @param callId - the call this result answers.
 * @returns the message.
 */
function resultMessage(id: string, callId: CallId): ToolResultMessage {
  return {
    id: MessageId(id),
    role: 'user',
    source: { kind: 'tool', callId },
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'boom' }], isError: true }],
  }
}

/** One failing tool call and its errored result. */
function failing(session: Session, index: number, command: string): void {
  const callId = CallId('call-' + String(index))
  const called = session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command }) })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: resultMessage('result-' + String(index), callId),
  }, { surfaceOp: 'append', sourceEventSeqs: [called.seq] })
}

/** One finished step. */
function completeStep(session: Session, step: number): void {
  session.append('step/start', { turn: 1, step })
  session.append('step/end', { turn: 1, step })
}

/**
 * The scripted worker log both arms write: enough evidence for three triggers
 * plus the completed steps the cooldown needs.
 * @param session - the worker session to drive.
 */
function script(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', message('prompt-1', 'ship the parser', { kind: 'user' }), { surfaceOp: 'append' })
  failing(session, 1, 'a')
  failing(session, 2, 'b')
  completeStep(session, 1)
  completeStep(session, 2)
  session.append('step-budget/exhausted', { turn: 2, step: 3, limit: 2 }, { ignorable: true })
  session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'the route failed', code: 'RATE_LIMIT' } } })
  session.append('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'the route failed', code: 'RATE_LIMIT' } } })
  session.append('todo/write', { todos: [{ content: 'ship the parser', status: 'in_progress' }] }, { ignorable: true })
}

/** The durable event list, with the wall-clock stamp dropped. */
function durable(session: Session): string {
  return JSON.stringify(session.events.map(event => ({
    type: event.type,
    seq: event.seq,
    data: event.data,
    ignorable: 'ignorable' in event ? event.ignorable : undefined,
    surfaceOp: 'surfaceOp' in event ? event.surfaceOp : undefined,
    sourceEventSeqs: 'sourceEventSeqs' in event ? event.sourceEventSeqs : undefined,
  })))
}

describe('composed-but-off twin', () => {
  it('writes the identical durable log whether the ladder is composed off or absent', async () => {
    const composedOff = await boot('off')
    script(composedOff)
    await settle()

    const absent = await boot('absent')
    script(absent)
    await settle()

    expect(composedOff.events.map(event => event.type)).not.toContain('escalation/decision')
    expect(durable(composedOff)).toBe(durable(absent))
  })

  it('writes a decision for the same script once the ladder is on', async () => {
    const on = await boot('on')
    script(on)
    await settle()

    const decisions = on.events.filter(event => event.type === 'escalation/decision')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.data).toMatchObject({ trigger: 'errorBurst', choice: 'continue', engine: 'absent' })
  })
})
