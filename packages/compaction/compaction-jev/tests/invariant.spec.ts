/**
 * The package invariant companion: a compaction that closes successfully while
 * its latest verification still reads \`escalated\` fails the append that writes
 * the close. The check reads the authoritative event stream and runs on
 * \`internal/dispatch\` before publication, so the refusal is raised by
 * \`session.append\` itself.
 *
 * Manual invariant topology (the focused-suite convention): the suite mounts the
 * registry and the companion on one root context and drives the relation through
 * real session appends.
 *
 * TEST DOUBLES: none. Both services are real and every case appends real events.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { CompactionId } from '@shres-code/shres-code-compaction'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import SessionStore from '@shres-code/shres-code-session'
import type { Session } from '@shres-code/shres-code-session'
import * as JevCompactionInvariant from '../src/invariant.ts'
import type { CompactionVerificationEvent, CompactionVerificationVerdict } from '../src/types.ts'

/** The one compaction every relation case reads. */
const COMPACTION = CompactionId('compaction-under-test')
/** A second compaction, for the cases that must ignore another lifecycle. */
const OTHER = CompactionId('another-compaction')

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(JevCompactionInvariant)
  return ctx
}

/** One logged verification attempt. */
function verification(
  verdict: CompactionVerificationVerdict,
  compactionId = COMPACTION,
): CompactionVerificationEvent {
  return {
    compactionId,
    attempt: 1,
    provider: 'conversation-provider',
    model: 'conversation-model',
    questions: [{ name: 'constraints', probability: 0.1 }, { name: 'overall', score: 2, confidence: 0.9 }],
    verdict,
    degraded: false,
  }
}

/** Open one compaction lifecycle. */
function start(session: Session, compactionId = COMPACTION): void {
  session.append('compaction/start', { compactionId, turn: 1 })
}

/** Close one compaction, optionally as a failure. */
function end(session: Session, compactionId = COMPACTION, error?: string): void {
  session.append('compaction/end', {
    compactionId,
    turn: 1,
    ...error === undefined ? {} : { error },
  })
}

describe('compaction-jev invariant companion', () => {
  it('registers the package name and disposes cleanly', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const dispose = await JevCompactionInvariant.apply(ctx)
    expect(typeof dispose).toBe('function')
    expect(JevCompactionInvariant.name).toBe('compaction-jev-invariant')
    expect(JevCompactionInvariant.inject).toEqual(['invariants'])
    dispose()
  })

  it('reserves the package name against duplicate registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(JevCompactionInvariant)

    expect(() => {
      ctx.invariants.register('@shres-code/shres-code-compaction-jev', () => {})
    }).toThrow(/already registered/)
  })

  it('rejects a close whose latest verification still reads escalated', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    start(session)
    session.append('compaction/verification', verification('escalated'))

    expect(() => { end(session) })
      .toThrow(/closed with its latest verification still reading "escalated": the escalation draft was never verified/)
    // The refused append never entered the log.
    expect(session.events.some(event => event.type === 'compaction/end')).toBe(false)
  })

  it('rejects a close whose latest of several attempts still reads escalated', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    start(session)
    session.append('compaction/verification', verification('accepted'))
    session.append('compaction/verification', verification('escalated'))

    expect(() => { end(session) }).toThrow(/escalated/)
  })

  it('accepts a close whose latest verification was accepted', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    start(session)
    session.append('compaction/verification', verification('escalated'))
    session.append('compaction/verification', verification('accepted'))

    expect(() => { end(session) }).not.toThrow()
    expect(session.events.at(-1)?.type).toBe('compaction/end')
  })

  it('accepts a close whose latest verification was accepted below threshold', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    start(session)
    session.append('compaction/verification', verification('accepted-below-threshold'))

    expect(() => { end(session) }).not.toThrow()
  })

  it('accepts a close whose verification degraded', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    start(session)
    session.append('compaction/verification', {
      ...verification('accepted'),
      questions: [],
      degraded: true,
      reason: 'engine-absent',
    })

    expect(() => { end(session) }).not.toThrow()
  })

  it('exempts a close that carries an error', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    start(session)
    session.append('compaction/verification', verification('escalated'))

    expect(() => { end(session, COMPACTION, 'the escalation draft threw') }).not.toThrow()
    expect(session.events.at(-1)?.data).toMatchObject({ error: 'the escalation draft threw' })
  })

  it('accepts a compaction with no verification at all', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    start(session)

    expect(() => { end(session) }).not.toThrow()
  })

  it('scopes the relation to the closing compaction id', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    start(session, OTHER)
    session.append('compaction/verification', verification('escalated', OTHER))
    start(session, COMPACTION)
    session.append('compaction/verification', verification('accepted'))

    expect(() => { end(session) }).not.toThrow()
    expect(session.events.filter(event => event.type === 'compaction/end')).toHaveLength(1)
  })

  it('leaves every non-compaction append alone', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    start(session)
    session.append('compaction/verification', verification('escalated'))

    expect(() => { session.append('turn/start', { turn: 1 }) }).not.toThrow()
    expect(() => { session.append('compaction/start', { compactionId: COMPACTION, turn: 1 }) }).not.toThrow()
  })
})
