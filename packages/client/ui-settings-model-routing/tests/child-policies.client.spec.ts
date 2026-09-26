import { describe, expect, it } from 'vitest'
import { childPoliciesSection, hasChildPoliciesCapability } from '../src/client/view.ts'
import { namespace } from './fixtures.client.ts'

describe('hasChildPoliciesCapability', () => {
  it('is true only when the schema names childPolicies', () => {
    expect(hasChildPoliciesCapability({})).toBe(false)
    expect(hasChildPoliciesCapability({ childPolicies: {} })).toBe(true)
    expect(hasChildPoliciesCapability({ properties: { childPolicies: { type: 'array' } } })).toBe(true)
  })
})

describe('childPoliciesSection', () => {
  it('reads ordered rules, the error streak, and judge text', () => {
    const section = childPoliciesSection(namespace('model-router', {
      childPolicies: [
        { match: { kind: 'subagent', agentType: 'explore' }, candidate: 'cheap', judge: true },
        { match: {}, candidate: 'mid' },
      ],
      childRouteErrors: 3,
      childRouteInstructions: 'Keep the parent model or use the cheaper child?',
    }))
    expect(section).toEqual({
      childPolicies: [
        { matchKind: 'subagent', agentType: 'explore', candidate: 'cheap', judge: true },
        { candidate: 'mid', judge: false },
      ],
      childRouteErrors: 3,
      childRouteInstructions: 'Keep the parent model or use the cheaper child?',
    })
  })
})
