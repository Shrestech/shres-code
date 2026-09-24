/**
 * The package invariant companion: a downgraded routing decision must be
 * followed by a \`request/header\` carrying the route that decision selected.
 * The check reads the authoritative event stream, and it runs on
 * \`internal/dispatch\` before publication, so a header that contradicts the
 * decision fails the \`session.append\` that writes it.
 *
 * Manual invariant topology (the focused-suite convention): the suite mounts the
 * registry and the companion on one root context and drives the relation through
 * real session appends.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import SessionStore from '@shres-code/shres-code-session'
import type { Session } from '@shres-code/shres-code-session'
import * as ModelRouterInvariant from '../src/invariant.ts'
import type { ModelRoutingDecision } from '../src/types.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(ModelRouterInvariant)
  return ctx
}

/**
 * One logged decision. An override set to \`undefined\` drops the key instead of
 * logging it: \`Session.append\` refuses data carrying an explicit \`undefined\`.
 */
function decision(
  overrides: Partial<Omit<ModelRoutingDecision, 'selection'>> & { selection?: ModelRoutingDecision['selection'] | undefined } = {},
): ModelRoutingDecision {
  const merged: Record<string, unknown> = {
    outcome: 'downgraded',
    reason: 'gate-passed',
    stateHash: '00000000',
    stateSeqs: [0],
    selection: { candidateId: 'cheap', provider: 'cheap-provider', model: 'cheap-model' },
    sticky: { active: true, routeErrorLimit: 2, stepsElapsed: 0, enteredTurn: 1 },
    ...overrides,
  }
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as unknown as ModelRoutingDecision
}

/** Append one full request-header snapshot for a route, with an optional rendered system prompt. */
function header(session: Session, provider: string, model: string, system?: string): void {
  session.append('request/header', {
    header: { config: { provider, model }, ...system === undefined ? {} : { system } },
    reason: 'initial',
  })
}

describe('model-router invariant companion', () => {
  it('registers the package name and disposes cleanly', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const dispose = await ModelRouterInvariant.apply(ctx)
    expect(typeof dispose).toBe('function')
    dispose()
  })

  it('reserves the package name against duplicate registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(ModelRouterInvariant)

    expect(() => {
      ctx.invariants.register('@shres-code/shres-code-model-router', () => {})
    }).toThrow(/already registered/)
  })

  it('accepts configuration replacements before an explicit mode selection', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()

    expect(() => {
      session.append('model-routing/configuration', { active: true })
      session.append('model-routing/configuration', { active: false })
    }).not.toThrow()
    expect(session.events.map(event => event.type)).toEqual([
      'model-routing/configuration',
      'model-routing/configuration',
    ])
  })

  it('rejects configuration after a same-valued explicit mode selection', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('model-routing/configuration', { active: true })
    session.append('model-routing/mode', { active: true })

    expect(() => {
      session.append('model-routing/configuration', { active: false })
    }).toThrow(/cannot follow an explicit model-routing\/mode selection/)
    expect(session.events.map(event => event.type)).toEqual([
      'model-routing/configuration',
      'model-routing/mode',
    ])
  })

  it('accepts the request header carrying the route a downgraded decision selected', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('model-routing/decision', decision())
    expect(() => { header(session, 'cheap-provider', 'cheap-model') }).not.toThrow()
    expect(session.events.at(-1)?.type).toBe('request/header')
  })

  it('rejects a request header that does not match the selected route', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('model-routing/decision', decision())

    expect(() => { header(session, 'other-provider', 'other-model') })
      .toThrow(/does not match the selected route/)
    // The refused append never entered the log.
    expect(session.events.some(event => event.type === 'request/header')).toBe(false)
  })

  it('rejects a downgraded decision that carries no selection', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('model-routing/decision', decision({ selection: undefined }))
    // The logged payload omits the key entirely: an explicit `undefined` member
    // is refused by Session.append itself ('carries non-JSON-serializable data').
    expect(decision({ selection: undefined })).not.toHaveProperty('selection')
    expect(JSON.stringify(session.events.at(-1)?.data)).not.toContain('selection')
    expect(() => { header(session, 'cheap-provider', 'cheap-model') })
      .toThrow(/a downgraded routing decision carries no selection/)
  })

  it('ignores headers with no downgraded decision to check', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    // No decision at all, then one that kept the manual route.
    expect(() => { header(session, 'strong-provider', 'strong-model') }).not.toThrow()
    session.append('model-routing/decision', decision({
      outcome: 'kept-strong',
      reason: 'low-confidence',
      selection: undefined,
      sticky: { active: false, stepsElapsed: 0 },
    }))
    expect(() => { header(session, 'strong-provider', 'strong-model') }).not.toThrow()
    // A non-header event is not a claim about the route.
    expect(() => { session.append('turn/start', { turn: 1 }) }).not.toThrow()
  })

  it('requires a recovery request to use its recorded manual route', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('model-routing/decision', decision({
      outcome: 'kept-strong', reason: 'route-errors', selection: undefined,
      sticky: { active: false, stepsElapsed: 0, entryBase: { provider: 'strong', model: 'manual' } },
    }))
    expect(() => { header(session, 'cheap-provider', 'cheap-model') }).toThrow(/does not match the selected route/)
    expect(() => { header(session, 'strong', 'manual') }).not.toThrow()
    session.append('turn/start', { turn: 2 })
    expect(() => { header(session, 'cheap-provider', 'cheap-model') }).not.toThrow()
  })

  it('rejects a routed header whose system prompt names the manual model', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('model-routing/decision', decision({
      sticky: { active: true, routeErrorLimit: 2, stepsElapsed: 0, enteredTurn: 1, entryBase: { provider: 'strong', model: 'strong-model' } },
    }))

    expect(() => { header(session, 'cheap-provider', 'cheap-model', 'You are a coding agent powered by the strong-model model.') })
      .toThrow(/routed request names the manual model/)
    expect(session.events.some(event => event.type === 'request/header')).toBe(false)
    // A routed prompt that names no manual model, and a prompt-less header, pass.
    expect(() => {
      header(session, 'cheap-provider', 'cheap-model', 'You are a coding agent.')
      header(session, 'cheap-provider', 'cheap-model')
    }).not.toThrow()
  })

  it('accepts the manual model name on a route-error recovery request', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('model-routing/decision', decision({
      outcome: 'kept-strong', reason: 'route-errors', selection: undefined,
      sticky: { active: false, stepsElapsed: 0, entryBase: { provider: 'strong', model: 'strong-model' } },
    }))
    // The recovery request runs the manual route, so naming it is accurate.
    expect(() => { header(session, 'strong', 'strong-model', 'You are the strong-model model.') }).not.toThrow()
  })

  it('requires a route-failed decision to follow the same step\'s downgrade for its provider', async () => {
    const ctx = await setup()
    const routeFailed = (provider = 'cheap-provider') => decision({
      outcome: 'kept-strong',
      reason: 'route-failed',
      selection: undefined,
      failure: { code: 'AUTH', provider, model: 'cheap-model' },
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'route-failed', entryBase: { provider: 'strong', model: 'strong-model' } },
    })
    const rejected = /a route-failed decision must follow the same step's downgraded decision for the failed provider/

    // No decision, a step boundary, or another provider breaks the relation.
    const none = ctx.sessions.create()
    expect(() => { none.append('model-routing/decision', routeFailed()) }).toThrow(rejected)
    const stepped = ctx.sessions.create()
    stepped.append('model-routing/decision', decision())
    stepped.append('step/start', { turn: 1, step: 2 })
    expect(() => { stepped.append('model-routing/decision', routeFailed()) }).toThrow(rejected)
    const other = ctx.sessions.create()
    other.append('model-routing/decision', decision())
    expect(() => { other.append('model-routing/decision', routeFailed('other-provider')) }).toThrow(rejected)

    // The same step's downgrade for the provider admits it, and the retried
    // request must then leave the failed route.
    const valid = ctx.sessions.create()
    valid.append('turn/start', { turn: 1 })
    valid.append('model-routing/decision', decision())
    header(valid, 'cheap-provider', 'cheap-model')
    expect(() => { valid.append('model-routing/decision', routeFailed()) }).not.toThrow()
    expect(() => { header(valid, 'cheap-provider', 'cheap-model') }).toThrow(/the retry after a route-failed decision runs the failed route/)
    // The same provider with another model is not the failed route.
    expect(() => { header(valid, 'cheap-provider', 'cheap-model-2') }).not.toThrow()
    expect(() => { header(valid, 'strong', 'strong-model', 'You are the strong-model model.') }).not.toThrow()
  })

  it('refuses a recovery request whose decision has no recorded manual route', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('model-routing/decision', decision({
      outcome: 'kept-strong', reason: 'route-errors', selection: undefined,
      sticky: { active: false, stepsElapsed: 0 },
    }))
    expect(() => { header(session, 'strong', 'manual') }).toThrow(/recovery decision carries no manual route/)
  })
})
