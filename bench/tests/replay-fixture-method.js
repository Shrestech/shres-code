/** Synthetic method values for keyless tests, never an experiment amendment. @module */
import { ESCALATION_TRIGGERS } from '../../packages/team/progress-signals/lib/index.js'
import { parseReplayMethod, REPLAY_ROW_SEMANTICS_VERSION } from '../routing/replay-method.js'

/**
 * Construct a fresh complete synthetic method.
 * @param {object} overrides - explicit test variants.
 * @returns {object} test-only method fields.
 */
export function fixtureMethod(overrides = {}) {
  return {
    version: REPLAY_ROW_SEMANTICS_VERSION,
    eceBins: 10,
    tieBreak: ['falseDowngrade', 'downgradeThreshold', 'downgradeMargin'],
    labelSources: { S: 'unlabelled', C: 'c-trajectory' },
    triggerTable: Object.fromEntries(ESCALATION_TRIGGERS.map(name => [name, { enabled: name === 'errorBurst', threshold: 2 }])),
    triggerTableId: 'test-error-burst',
    finalWindow: 'to-trial-end',
    coldPointBasis: { base: 'trial-own-route', ttl: 'route-base-counterfactual' },
    cRowRequestConfig: 'route-base-composition',
    ...overrides,
  }
}

/**
 * Attach method identity and a trajectory label to an arithmetic fixture.
 * @param {object} fields - row values, with a fixture cheapSufficient boolean.
 * @param {object} method - synthetic method used by the test.
 * @returns {object} durable replay row fields.
 */
export function fixtureRow(fields, method = fixtureMethod()) {
  const { cheapSufficient = true, ...rest } = fields
  return {
    arm: 'C', methodSha256: parseReplayMethod(method, { require: [] }).methodSha256,
    label: { status: 'labelled', cheapSufficient, source: 'c-trajectory', triggerTableId: method.triggerTableId },
    ...rest,
  }
}
