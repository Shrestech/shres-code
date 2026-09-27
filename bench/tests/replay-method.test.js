/**
 * Replay-method validator tests: the DTO accepts exactly the owner-pinned
 * representations, requires nothing by default and everything each stage
 * names, rejects unknown keys at every level, and hashes stably under key
 * order. The parsed method is a deep clone, so no consumer shares structure
 * with the caller. Keyless.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ESCALATION_TRIGGERS } from '../../packages/team/progress-signals/lib/index.js'
import {
  ALL_METHOD_FIELDS,
  LABELLER_METHOD_FIELDS,
  MethodInvalidError,
  MethodProvenanceError,
  MethodUnpinnedError,
  parseReplayMethod,
  REPLAY_ROW_SEMANTICS_VERSION,
  TIE_BREAK_KEYS,
} from '../routing/replay-method.js'

assert.ok(ESCALATION_TRIGGERS.length >= 1, 'the progress-signals trigger list must not be empty')

/** A fresh complete valid method, built from the public trigger list. */
function completeMethod() {
  return {
    version: REPLAY_ROW_SEMANTICS_VERSION,
    eceBins: 10,
    tieBreak: ['falseDowngrade', 'downgradeThreshold', 'downgradeMargin'],
    labelSources: { S: 'unlabelled', C: 'c-trajectory' },
    triggerTable: Object.fromEntries(ESCALATION_TRIGGERS.map((name) => [name, { enabled: name === 'errorBurst', threshold: 2 }])),
    triggerTableId: 'test-error-burst',
    finalWindow: 'to-trial-end',
    coldPointBasis: { base: 'trial-own-route', ttl: 'route-base-counterfactual' },
    cRowRequestConfig: 'route-base-composition',
  }
}

/** Rebuild a value with every object's keys inserted in reverse order. */
function reversed(value) {
  if (Array.isArray(value)) return value.map(reversed)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, member]) => [key, reversed(member)]))
  }
  return value
}

/** Assert the parse throws MethodInvalidError with the given field and reason. */
function assertInvalid(value, options, field, reason) {
  assert.throws(() => parseReplayMethod(value, options), (error) => {
    assert.ok(error instanceof MethodInvalidError, `expected MethodInvalidError, got ${error}`)
    assert.equal(error.field, field)
    assert.equal(error.reason, reason)
    return true
  })
}

/** Assert the parse throws MethodUnpinnedError with the given missing list. */
function assertUnpinned(value, options, missing) {
  assert.throws(() => parseReplayMethod(value, options), (error) => {
    assert.ok(error instanceof MethodUnpinnedError, `expected MethodUnpinnedError, got ${error}`)
    assert.deepEqual(error.missing, missing)
    return true
  })
}

test('the exported constants carry the fixed DTO values', () => {
  assert.equal(REPLAY_ROW_SEMANTICS_VERSION, 'pr16-replay@1')
  assert.deepEqual({ ...TIE_BREAK_KEYS }, { falseDowngrade: 'asc', downgradeThreshold: 'desc', downgradeMargin: 'desc' })
  assert.deepEqual([...ALL_METHOD_FIELDS], [
    'version', 'eceBins', 'tieBreak', 'labelSources', 'triggerTable',
    'triggerTableId', 'finalWindow', 'coldPointBasis', 'cRowRequestConfig',
  ])
  assert.deepEqual([...LABELLER_METHOD_FIELDS], ['version', 'labelSources', 'triggerTable', 'triggerTableId', 'finalWindow'])
  for (const constant of [TIE_BREAK_KEYS, ALL_METHOD_FIELDS, LABELLER_METHOD_FIELDS]) {
    assert.ok(Object.isFrozen(constant))
  }
})

test('a complete method parses with any requirement subset and a 64-hex hash', () => {
  for (const require of [[], ['version'], ['version', 'eceBins', 'tieBreak'], LABELLER_METHOD_FIELDS, ALL_METHOD_FIELDS]) {
    const { method, methodSha256 } = parseReplayMethod(completeMethod(), { require: [...require] })
    assert.deepEqual(method, completeMethod())
    assert.match(methodSha256, /^[0-9a-f]{64}$/)
  }
})

test('the hash is stable under key order and identical JSON, and arrays keep their order', () => {
  const ordered = completeMethod()
  const shuffled = reversed(ordered)
  assert.notDeepEqual(Object.keys(shuffled), Object.keys(ordered), 'the fixtures must really differ in key order')
  const a = parseReplayMethod(ordered, { require: ALL_METHOD_FIELDS })
  const b = parseReplayMethod(shuffled, { require: ALL_METHOD_FIELDS })
  assert.equal(a.methodSha256, b.methodSha256)
  const roundTripped = JSON.parse(JSON.stringify(ordered))
  assert.equal(parseReplayMethod(roundTripped, { require: [] }).methodSha256, a.methodSha256)
  const reversedTieBreak = { ...ordered, tieBreak: [...ordered.tieBreak].reverse() }
  assert.notEqual(parseReplayMethod(reversedTieBreak, { require: ALL_METHOD_FIELDS }).methodSha256, a.methodSha256)
  const otherBins = { ...ordered, eceBins: 12 }
  assert.notEqual(parseReplayMethod(otherBins, { require: ALL_METHOD_FIELDS }).methodSha256, a.methodSha256)
})

test('the parsed method is a deterministic deep clone and the input is never mutated', () => {
  const input = completeMethod()
  const snapshot = structuredClone(input)
  const first = parseReplayMethod(input, { require: ALL_METHOD_FIELDS })
  const second = parseReplayMethod(input, { require: ALL_METHOD_FIELDS })
  assert.deepEqual(first, second)
  assert.deepEqual(input, snapshot)
  assert.notEqual(first.method, input)
  assert.notEqual(first.method.triggerTable, input.triggerTable)
  assert.notEqual(first.method.labelSources, input.labelSources)
  first.method.triggerTable.errorBurst.threshold = 99
  first.method.labelSources.C = 'unlabelled'
  assert.equal(input.triggerTable.errorBurst.threshold, 2)
  assert.equal(input.labelSources.C, 'c-trajectory')
  assert.deepEqual(input, snapshot)
})

test('every missing required field is named once, in DTO order', () => {
  assertUnpinned(undefined, { require: ALL_METHOD_FIELDS }, [...ALL_METHOD_FIELDS])
  assertUnpinned(null, { require: ALL_METHOD_FIELDS }, [...ALL_METHOD_FIELDS])
  assertUnpinned({}, { require: ALL_METHOD_FIELDS }, [...ALL_METHOD_FIELDS])
  for (const field of ALL_METHOD_FIELDS) {
    const partial = completeMethod()
    delete partial[field]
    assertUnpinned(partial, { require: ALL_METHOD_FIELDS }, [field])
  }
  assertUnpinned({ version: undefined }, { require: ['version'] }, ['version'])
  const empty = parseReplayMethod(completeMethod(), { require: [] })
  assert.deepEqual(empty.method, completeMethod())
})

test('each stage requirement set accepts its partial pin and names the rest', () => {
  const labeller = completeMethod()
  delete labeller.eceBins
  delete labeller.tieBreak
  delete labeller.coldPointBasis
  delete labeller.cRowRequestConfig
  const labelled = parseReplayMethod(labeller, { require: LABELLER_METHOD_FIELDS })
  assert.match(labelled.methodSha256, /^[0-9a-f]{64}$/)
  assertUnpinned(labeller, { require: ALL_METHOD_FIELDS }, ['eceBins', 'tieBreak', 'coldPointBasis', 'cRowRequestConfig'])

  const frontend = completeMethod()
  delete frontend.eceBins
  delete frontend.tieBreak
  delete frontend.labelSources
  delete frontend.triggerTable
  delete frontend.triggerTableId
  delete frontend.finalWindow
  const consulted = parseReplayMethod(frontend, { require: ['version', 'coldPointBasis', 'cRowRequestConfig'] })
  assert.match(consulted.methodSha256, /^[0-9a-f]{64}$/)

  const metrics = completeMethod()
  delete metrics.labelSources
  delete metrics.triggerTable
  delete metrics.triggerTableId
  delete metrics.finalWindow
  delete metrics.coldPointBasis
  delete metrics.cRowRequestConfig
  const computed = parseReplayMethod(metrics, { require: ['version', 'eceBins', 'tieBreak'] })
  assert.match(computed.methodSha256, /^[0-9a-f]{64}$/)
})

test('unknown keys are rejected at every level', () => {
  assertInvalid({ ...completeMethod(), calibratedBy: 'x' }, { require: ALL_METHOD_FIELDS }, 'calibratedBy', 'unknown-field')
  assertInvalid({ ...completeMethod(), toString: 'x' }, { require: [] }, 'toString', 'unknown-field')
  assertInvalid(
    { ...completeMethod(), labelSources: { S: 'unlabelled', C: 'c-trajectory', N: 'unlabelled' } },
    { require: [] }, 'labelSources.N', 'unknown-key',
  )
  const extraTrigger = completeMethod()
  extraTrigger.triggerTable.workerEscalation = { enabled: true, threshold: 1 }
  assertInvalid(extraTrigger, { require: [] }, 'triggerTable.workerEscalation', 'unknown-key')
  const extraRowKey = completeMethod()
  extraRowKey.triggerTable.errorBurst.kind = 'burst'
  assertInvalid(extraRowKey, { require: [] }, 'triggerTable.errorBurst.kind', 'unknown-key')
  assertInvalid(
    { ...completeMethod(), coldPointBasis: { base: 'trial-own-route', ttl: 'route-base-counterfactual', ttlMs: 1 } },
    { require: [] }, 'coldPointBasis.ttlMs', 'unknown-key',
  )
})

test('unpinned fields are reported before unknown keys, and unknown keys before invalid values', () => {
  assertUnpinned({ junk: 1 }, { require: ['version'] }, ['version'])
  assertInvalid({ ...completeMethod(), junk: 1, eceBins: 0 }, { require: [] }, 'junk', 'unknown-field')
})

test('arm S never labels from c-trajectory', () => {
  assertInvalid(
    { ...completeMethod(), labelSources: { S: 'c-trajectory', C: 'c-trajectory' } },
    { require: LABELLER_METHOD_FIELDS }, 'labelSources.S', 'unsupported-for-arm',
  )
  assertInvalid(
    { ...completeMethod(), labelSources: { S: 'c-trajectory', C: 'unlabelled' } },
    { require: [] }, 'labelSources.S', 'unsupported-for-arm',
  )
})

test('the version is exactly the fixed row-semantics version, required or not', () => {
  assertInvalid({ ...completeMethod(), version: 'pr16-replay@2' }, { require: ALL_METHOD_FIELDS }, 'version', 'unsupported-version')
  assertInvalid({ ...completeMethod(), version: 'pr16-replay@1 ' }, { require: [] }, 'version', 'unsupported-version')
  assertInvalid({ ...completeMethod(), version: 1 }, { require: [] }, 'version', 'unsupported-version')
  const noVersion = completeMethod()
  delete noVersion.version
  assertUnpinned(noVersion, { require: ['version'] }, ['version'])
})

test('eceBins is a positive safe integer: 1 is accepted, 0 is refused', () => {
  for (const good of [1, 2, 10, 1024]) {
    const { method } = parseReplayMethod({ ...completeMethod(), eceBins: good }, { require: ['eceBins'] })
    assert.equal(method.eceBins, good)
  }
  assertInvalid({ ...completeMethod(), eceBins: 0 }, { require: [] }, 'eceBins', 'range')
  assertInvalid({ ...completeMethod(), eceBins: -3 }, { require: [] }, 'eceBins', 'range')
  for (const bad of [1.5, 2.5, '10', null, true, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertInvalid({ ...completeMethod(), eceBins: bad }, { require: [] }, 'eceBins', 'type')
  }
})

test('tieBreak is a non-empty array of distinct own tie-break keys', () => {
  parseReplayMethod({ ...completeMethod(), tieBreak: ['falseDowngrade'] }, { require: ['tieBreak'] })
  parseReplayMethod({ ...completeMethod(), tieBreak: ['downgradeMargin', 'falseDowngrade'] }, { require: [] })
  assertInvalid({ ...completeMethod(), tieBreak: [] }, { require: [] }, 'tieBreak', 'empty')
  assertInvalid({ ...completeMethod(), tieBreak: 'falseDowngrade' }, { require: [] }, 'tieBreak', 'type')
  assertInvalid({ ...completeMethod(), tieBreak: [42] }, { require: [] }, 'tieBreak', 'type')
  assertInvalid({ ...completeMethod(), tieBreak: ['falseDowngrade', 'falseDowngrade'] }, { require: [] }, 'tieBreak', 'duplicate')
  assertInvalid({ ...completeMethod(), tieBreak: ['coverage'] }, { require: [] }, 'tieBreak', 'unknown-key')
  assertInvalid({ ...completeMethod(), tieBreak: [''] }, { require: [] }, 'tieBreak', 'unknown-key')
  assertInvalid({ ...completeMethod(), tieBreak: ['toString'] }, { require: [] }, 'tieBreak', 'unknown-key')
  assertInvalid({ ...completeMethod(), tieBreak: ['constructor'] }, { require: [] }, 'tieBreak', 'unknown-key')
})

test('labelSources is exactly S and C, each from its closed set', () => {
  parseReplayMethod({ ...completeMethod(), labelSources: { S: 'unlabelled', C: 'unlabelled' } }, { require: ['labelSources'] })
  parseReplayMethod({ ...completeMethod(), labelSources: { C: 'c-trajectory', S: 'unlabelled' } }, { require: [] })
  assertInvalid({ ...completeMethod(), labelSources: null }, { require: [] }, 'labelSources', 'type')
  assertInvalid({ ...completeMethod(), labelSources: ['S'] }, { require: [] }, 'labelSources', 'type')
  assertInvalid({ ...completeMethod(), labelSources: 'c-trajectory' }, { require: [] }, 'labelSources', 'type')
  assertInvalid({ ...completeMethod(), labelSources: { C: 'c-trajectory' } }, { require: [] }, 'labelSources', 'missing-key')
  assertInvalid({ ...completeMethod(), labelSources: { S: 'unlabelled' } }, { require: [] }, 'labelSources', 'missing-key')
  assertInvalid({ ...completeMethod(), labelSources: { S: 'x', C: 'c-trajectory' } }, { require: [] }, 'labelSources.S', 'unsupported-for-arm')
  assertInvalid({ ...completeMethod(), labelSources: { S: 'unlabelled', C: 'both' } }, { require: [] }, 'labelSources.C', 'unsupported')
  assertInvalid({ ...completeMethod(), labelSources: { S: 'unlabelled', C: null } }, { require: [] }, 'labelSources.C', 'unsupported')
})

test('triggerTable is exactly the public trigger rows with enabled and threshold', () => {
  const full = { ...completeMethod(), triggerTable: Object.fromEntries(ESCALATION_TRIGGERS.map((name) => [name, { enabled: true, threshold: 1 }])) }
  parseReplayMethod(full, { require: ['triggerTable'] })
  for (const name of ESCALATION_TRIGGERS) {
    const missingTrigger = completeMethod()
    delete missingTrigger.triggerTable[name]
    assertInvalid(missingTrigger, { require: [] }, 'triggerTable', 'missing-key')
  }
  assertInvalid({ ...completeMethod(), triggerTable: null }, { require: [] }, 'triggerTable', 'type')
  assertInvalid({ ...completeMethod(), triggerTable: [true] }, { require: [] }, 'triggerTable', 'type')
  assertInvalid({ ...completeMethod(), triggerTable: { errorBurst: { enabled: true, threshold: 1 } } }, { require: [] }, 'triggerTable', 'missing-key')
  assertInvalid({ ...completeMethod(), triggerTable: { ...full.triggerTable, errorBurst: null } }, { require: [] }, 'triggerTable.errorBurst', 'type')
  assertInvalid({ ...completeMethod(), triggerTable: { ...full.triggerTable, errorBurst: 3 } }, { require: [] }, 'triggerTable.errorBurst', 'type')
  assertInvalid({ ...completeMethod(), triggerTable: { ...full.triggerTable, errorBurst: { enabled: true } } }, { require: [] }, 'triggerTable.errorBurst', 'missing-key')
  assertInvalid({ ...completeMethod(), triggerTable: { ...full.triggerTable, errorBurst: { threshold: 1 } } }, { require: [] }, 'triggerTable.errorBurst', 'missing-key')
  assertInvalid({ ...completeMethod(), triggerTable: { ...full.triggerTable, errorBurst: { enabled: 1, threshold: 1 } } }, { require: [] }, 'triggerTable.errorBurst.enabled', 'type')
  assertInvalid({ ...completeMethod(), triggerTable: { ...full.triggerTable, errorBurst: { enabled: true, threshold: 0 } } }, { require: [] }, 'triggerTable.errorBurst.threshold', 'range')
  assertInvalid({ ...completeMethod(), triggerTable: { ...full.triggerTable, errorBurst: { enabled: true, threshold: -1 } } }, { require: [] }, 'triggerTable.errorBurst.threshold', 'range')
  assertInvalid({ ...completeMethod(), triggerTable: { ...full.triggerTable, errorBurst: { enabled: true, threshold: 1.5 } } }, { require: [] }, 'triggerTable.errorBurst.threshold', 'type')
  assertInvalid({ ...completeMethod(), triggerTable: { ...full.triggerTable, errorBurst: { enabled: true, threshold: '2' } } }, { require: [] }, 'triggerTable.errorBurst.threshold', 'type')
})

test('triggerTableId is a slug of at most 64 allowed characters', () => {
  for (const good of ['a', 'worker-escalation-shipped-defaults', 'test.error.burst_1', 'a'.repeat(64)]) {
    parseReplayMethod({ ...completeMethod(), triggerTableId: good }, { require: ['triggerTableId'] })
  }
  for (const bad of ['', '-lead', '_x', 'Bad', 'sp ace', 'id/1', 'a'.repeat(65)]) {
    assertInvalid({ ...completeMethod(), triggerTableId: bad }, { require: [] }, 'triggerTableId', 'pattern')
  }
  assertInvalid({ ...completeMethod(), triggerTableId: 7 }, { require: [] }, 'triggerTableId', 'type')
})

test('finalWindow, coldPointBasis and cRowRequestConfig accept only their defined values', () => {
  parseReplayMethod({ ...completeMethod(), finalWindow: 'unlabelled' }, { require: ['finalWindow'] })
  for (const bad of ['whenever', 'to-trial-end ', 'TO-TRIAL-END', null, 7]) {
    assertInvalid({ ...completeMethod(), finalWindow: bad }, { require: [] }, 'finalWindow', 'unsupported')
  }
  parseReplayMethod({ ...completeMethod(), coldPointBasis: { ttl: 'route-base-counterfactual', base: 'trial-own-route' } }, { require: [] })
  assertInvalid({ ...completeMethod(), coldPointBasis: null }, { require: [] }, 'coldPointBasis', 'type')
  assertInvalid({ ...completeMethod(), coldPointBasis: 'trial-own-route' }, { require: [] }, 'coldPointBasis', 'type')
  assertInvalid({ ...completeMethod(), coldPointBasis: { base: 'trial-own-route' } }, { require: [] }, 'coldPointBasis', 'missing-key')
  assertInvalid({ ...completeMethod(), coldPointBasis: { ttl: 'route-base-counterfactual' } }, { require: [] }, 'coldPointBasis', 'missing-key')
  assertInvalid({ ...completeMethod(), coldPointBasis: { base: 'pooled', ttl: 'route-base-counterfactual' } }, { require: [] }, 'coldPointBasis.base', 'unsupported')
  assertInvalid({ ...completeMethod(), coldPointBasis: { base: 'trial-own-route', ttl: 'strong-ttl-only' } }, { require: [] }, 'coldPointBasis.ttl', 'unsupported')
  parseReplayMethod({ ...completeMethod(), cRowRequestConfig: 'route-base-composition' }, { require: ['cRowRequestConfig'] })
  for (const bad of ['strong-base', '', null, 7]) {
    assertInvalid({ ...completeMethod(), cRowRequestConfig: bad }, { require: [] }, 'cRowRequestConfig', 'unsupported')
  }
})

test('present fields are validated even when nothing is required', () => {
  assertInvalid({ eceBins: 0 }, { require: [] }, 'eceBins', 'range')
  assertInvalid({ labelSources: { C: 'c-trajectory' } }, { require: [] }, 'labelSources', 'missing-key')
  assertInvalid({ finalWindow: 'whenever' }, { require: [] }, 'finalWindow', 'unsupported')
  const parsed = parseReplayMethod({ version: REPLAY_ROW_SEMANTICS_VERSION }, { require: [] })
  assert.deepEqual(parsed.method, { version: REPLAY_ROW_SEMANTICS_VERSION })
})

test('a non-object method block is unpinned when absent and invalid when present', () => {
  assertUnpinned(undefined, { require: LABELLER_METHOD_FIELDS }, [...LABELLER_METHOD_FIELDS])
  assertUnpinned(null, { require: ['version'] }, ['version'])
  assert.throws(() => parseReplayMethod(undefined, { require: [] }), MethodUnpinnedError)
  assertInvalid(['version'], { require: [] }, 'method', 'type')
  assertInvalid('pr16-replay@1', { require: [] }, 'method', 'type')
  assertInvalid(42, { require: [] }, 'method', 'type')
})

test('requirement misuse fails loud as a caller error', () => {
  assert.throws(() => parseReplayMethod(completeMethod(), { require: 'version' }), TypeError)
  assert.throws(() => parseReplayMethod(completeMethod(), { require: ['bogus'] }), /bogus/)
  assert.throws(() => parseReplayMethod(completeMethod(), null), TypeError)
  assert.throws(() => parseReplayMethod(completeMethod(), { require: [42] }), TypeError)
})

test('the method errors keep their names and payload fields', () => {
  const unpinned = new MethodUnpinnedError(['version', 'eceBins'])
  assert.ok(unpinned instanceof TypeError)
  assert.equal(unpinned.name, 'MethodUnpinnedError')
  assert.deepEqual(unpinned.missing, ['version', 'eceBins'])
  assert.ok(Object.isFrozen(unpinned.missing))
  assert.match(unpinned.message, /method\.version/)
  assert.match(unpinned.message, /method\.eceBins/)
  const invalid = new MethodInvalidError('eceBins', 'range', 'must be a positive safe integer (>= 1)')
  assert.ok(invalid instanceof TypeError)
  assert.equal(invalid.name, 'MethodInvalidError')
  assert.equal(invalid.field, 'eceBins')
  assert.equal(invalid.reason, 'range')
  assert.match(invalid.message, /method\.eceBins/)
  const provenance = new MethodProvenanceError('registration.method does not match replay metrics method')
  assert.ok(provenance instanceof TypeError)
  assert.equal(provenance.name, 'MethodProvenanceError')
  assert.equal(provenance.message, 'registration.method does not match replay metrics method')
})
