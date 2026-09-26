import { describe, expect, it } from 'vitest'
import type { Agent } from '@shres-code/shres-code-agent'
import { SessionId } from '@shres-code/shres-code-session'
import { SubagentRouteRequestId } from '@shres-code/shres-code-subagent'
import type { SubagentChildRouteRequest } from '@shres-code/shres-code-subagent'
import { resolveConfig } from '../src/config.ts'
import { isChildRouteParent, logChildDecision, matchChildPolicy, resolveChildRouteConsult } from '../src/child-route.ts'
import type { ModelRouterConfig } from '../src/config.ts'

const STRONG = { provider: 'strong-provider', model: 'strong-model' }
const CHEAP = { id: 'cheap', provider: 'cheap-provider', model: 'cheap-model', description: 'a test candidate' }

function config(overrides: Partial<ModelRouterConfig> = {}) {
  return resolveConfig({
    initialMode: 'on',
    candidates: [{ ...CHEAP }],
    routeFrom: [{ ...STRONG, objective: 'dollars' }],
    downgradeThreshold: 0.8,
    downgradeMargin: 0.1,
    routeInstructions: 'Which route should handle this turn?',
    difficultyInstructions: 'How hard is this turn?',
    hold: { minSteps: 0 },
    childPolicies: [{ match: { kind: 'subagent', agentType: 'explore' }, candidate: 'cheap' }],
    ...overrides,
  })
}

function parent(
  route: { provider?: string; model?: string } = STRONG,
  header: { config: { provider?: string; model?: string } } | undefined = { config: route },
  onAppend: (type: string, data: unknown) => void = () => undefined,
): Agent {
  return {
    id: SessionId('parent'),
    options: route,
    ctx: { get: () => undefined },
    session: {
      id: SessionId('parent'),
      events: [],
      header: {},
      append: onAppend,
      requestHeader: () => header,
    },
  } as unknown as Agent
}

function request(overrides: Partial<SubagentChildRouteRequest> = {}): SubagentChildRouteRequest {
  return {
    parent: parent(),
    kind: 'subagent',
    subagentProvider: 'spawn',
    inherited: STRONG,
    agentType: 'explore',
    prompt: 'explore the tree',
    signal: new AbortController().signal,
    routeRequestId: SubagentRouteRequestId('route-1'),
    ...overrides,
  }
}

describe('matchChildPolicy', () => {
  it('selects the first matching rule', () => {
    const resolved = config({
      childPolicies: [
        { match: { kind: 'workflow' }, candidate: 'cheap' },
        { match: { kind: 'subagent', agentType: 'explore' }, candidate: 'cheap' },
      ],
    })
    expect(matchChildPolicy(resolved.childPolicies, request())?.index).toBe(1)
    expect(matchChildPolicy(resolved.childPolicies, request({ agentType: 'review' }))).toBeUndefined()
  })
})

describe('resolveChildRouteConsult', () => {
  it('writes nothing when mode is off', () => {
    expect(resolveChildRouteConsult({ config: config(), mode: 'off', suspended: new Set() }, request())).toEqual({})
  })

  it('writes nothing when no rule matches', () => {
    expect(resolveChildRouteConsult(
      { config: config(), mode: 'on', suspended: new Set() },
      request({ agentType: 'review' }),
    )).toEqual({})
  })

  it('routes the first matching rule on', () => {
    const result = resolveChildRouteConsult({ config: config(), mode: 'on', suspended: new Set() }, request())
    expect(result.route).toEqual({ provider: CHEAP.provider, model: CHEAP.model })
    expect(result.decision).toMatchObject({
      outcome: 'routed',
      reason: 'child-policy',
      routeRequestId: 'route-1',
      selection: { candidateId: 'cheap', provider: CHEAP.provider, model: CHEAP.model },
      effortApplied: false,
    })
  })

  it('logs shadow and returns no route', () => {
    const result = resolveChildRouteConsult({ config: config(), mode: 'shadow', suspended: new Set() }, request())
    expect(result.route).toBeUndefined()
    expect(result.decision).toMatchObject({ outcome: 'routed', reason: 'child-policy', shadow: true })
  })

  it('keeps an unlisted parent base', () => {
    const result = resolveChildRouteConsult(
      { config: config(), mode: 'on', suspended: new Set() },
      request({ parent: parent({ provider: 'other', model: 'other-model' }), inherited: { provider: 'other', model: 'other-model' } }),
    )
    expect(result.route).toBeUndefined()
    expect(result.decision).toMatchObject({ outcome: 'kept', reason: 'base-unlisted' })
  })

  it('keeps when the candidate equals the base', () => {
    const resolved = config({
      candidates: [{ id: 'cheap', provider: STRONG.provider, model: STRONG.model, description: 'same as base' }],
      childPolicies: [{ match: { kind: 'subagent' }, candidate: 'cheap' }],
    })
    const result = resolveChildRouteConsult({ config: resolved, mode: 'on', suspended: new Set() }, request())
    expect(result.route).toBeUndefined()
    expect(result.decision).toMatchObject({ outcome: 'kept', reason: 'candidate-equals-base' })
  })

  it('keeps a suspended candidate', () => {
    const result = resolveChildRouteConsult(
      { config: config(), mode: 'on', suspended: new Set(['cheap']) },
      request(),
    )
    expect(result.route).toBeUndefined()
    expect(result.decision).toMatchObject({ outcome: 'kept', reason: 'child-route-errors' })
  })

  it('marks a judge rule as pendingJudge', () => {
    const resolved = config({
      childPolicies: [{ match: { kind: 'subagent' }, candidate: 'cheap', judge: true }],
      childRouteInstructions: 'Keep the parent model or use the cheaper child?',
    })
    const result = resolveChildRouteConsult({ config: resolved, mode: 'on', suspended: new Set() }, request())
    expect(result.pendingJudge).toBe(true)
    expect(result.route).toBeUndefined()
    expect(result.candidate?.id).toBe('cheap')
  })

  it('uses parent options when selectionInForce is empty and options name a listed base', () => {
    const resolved = config({ childPolicies: [{ match: {}, candidate: 'cheap' }] })
    const { agentType: _agentType, ...withoutType } = request({
      parent: parent(STRONG, undefined),
      inherited: {},
    })
    const result = resolveChildRouteConsult(
      { config: resolved, mode: 'on', suspended: new Set() },
      withoutType,
    )
    expect(result.route).toEqual({ provider: CHEAP.provider, model: CHEAP.model })
  })

  it('falls back when parent options omit provider and model', () => {
    const result = resolveChildRouteConsult(
      { config: config(), mode: 'on', suspended: new Set() },
      request({
        parent: parent({}, undefined),
      }),
    )
    expect(result.decision).toMatchObject({ outcome: 'kept', reason: 'base-unlisted' })
  })

  it('logs a child-decision and recognises a live parent', () => {
    const appended: unknown[] = []
    const agent = parent(STRONG, { config: STRONG }, (type, data) => { appended.push({ type, data }) })
    logChildDecision(agent.session, {
      outcome: 'kept',
      reason: 'base-unlisted',
      routeRequestId: 'route-1',
      childKind: 'subagent',
      policyIndex: 0,
      inherited: {},
      effortApplied: false,
      promptChars: 1,
    })
    expect(appended).toEqual([{ type: 'model-routing/child-decision', data: expect.objectContaining({ reason: 'base-unlisted' }) }])
    expect(isChildRouteParent(agent)).toBe(true)
  })
})
