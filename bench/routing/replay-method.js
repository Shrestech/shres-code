/**
 * The replay method record: the owner-gated inputs of the PR 16 routing
 * replay, and the one validator every stage parses them with. A method is
 * pinned, never defaulted: a stage names the fields it requires through
 * `require`, and absent required fields raise MethodUnpinnedError naming all
 * of them. Every present field is validated whether or not it is required, so
 * no consumer inherits another stage's malformed value; an unknown key at any
 * level, or a present field whose representation the DTO below does not
 * define, raises MethodInvalidError naming the field and reason.
 *
 * The accepted representations (unknown keys rejected at every level):
 * - `version`: exactly REPLAY_ROW_SEMANTICS_VERSION; the value is fixed by
 *   code, not chosen by the owner.
 * - `eceBins`: a positive safe integer (>= 1), the acceptance of the
 *   metrics `ece()` bin grid.
 * - `tieBreak`: a non-empty array of distinct TIE_BREAK_KEYS keys, applied in
 *   caller order; the directions are fixed by TIE_BREAK_KEYS.
 * - `labelSources`: an object with exactly the keys `S` and `C`, each
 *   "c-trajectory" or "unlabelled"; "c-trajectory" is defined for `C` only,
 *   so `S` pins "unlabelled".
 * - `triggerTable`: an object with exactly one `{ enabled, threshold }` row
 *   per entry of the public ESCALATION_TRIGGERS of the built progress-signals
 *   lib (imported below; the names are not restated here), `enabled` a
 *   boolean and `threshold` a positive integer.
 * - `triggerTableId`: a slug matching `^[a-z0-9][a-z0-9._-]{0,63}$`.
 * - `finalWindow`: "to-trial-end" or "unlabelled".
 * - `coldPointBasis`: exactly `{ base: "trial-own-route",
 *   ttl: "route-base-counterfactual" }`.
 * - `cRowRequestConfig`: exactly "route-base-composition".
 *
 * `methodSha256` is SHA-256 over the canonical JSON of the whole method,
 * arrays in order and object keys sorted recursively: it is the provenance
 * identity stamped on every labelled row and verified against the method a
 * metric or the registration writer receives. A changed method is a different
 * experiment. The parser reads JSON data only: it evaluates nothing, sets no
 * default, never mutates its input, and returns a deep clone.
 *
 * @module bench/routing/replay-method
 */

import { createHash } from 'node:crypto'
import { canonicalize } from '../canonical-json.js'
import { ESCALATION_TRIGGERS } from '../../packages/team/progress-signals/lib/index.js'

/** The row-semantics version every method block pins; fixed by this code. */
export const REPLAY_ROW_SEMANTICS_VERSION = 'pr16-replay@1'

/**
 * The supported operating-point tie-break keys and their direction, applied in
 * caller order after the primary objective (maximum coverage): a lower value
 * wins for `falseDowngrade`, a higher value wins for the two gate quantities.
 */
export const TIE_BREAK_KEYS = Object.freeze({
  falseDowngrade: 'asc',
  downgradeThreshold: 'desc',
  downgradeMargin: 'desc',
})

/** Every method field, in DTO order: the version plus the seven owner pins. */
export const ALL_METHOD_FIELDS = Object.freeze([
  'version',
  'eceBins',
  'tieBreak',
  'labelSources',
  'triggerTable',
  'triggerTableId',
  'finalWindow',
  'coldPointBasis',
  'cRowRequestConfig',
])

/** The method fields the labeller needs to stamp rows with labels and identity. */
export const LABELLER_METHOD_FIELDS = Object.freeze([
  'version',
  'labelSources',
  'triggerTable',
  'triggerTableId',
  'finalWindow',
])

/** The method fields the consult frontend needs before calling replayConsultInput. */
export const FRONTEND_METHOD_FIELDS = Object.freeze([
  'version',
  'coldPointBasis',
  'cRowRequestConfig',
])

/** The label source each arm may pin; "c-trajectory" is defined for C only. */
const ARM_LABEL_SOURCES = Object.freeze({
  S: Object.freeze(['unlabelled']),
  C: Object.freeze(['c-trajectory', 'unlabelled']),
})

/** The final-window policies a method may pin. */
const FINAL_WINDOWS = Object.freeze(['to-trial-end', 'unlabelled'])

/** The slug form of a trigger table id. */
const TRIGGER_TABLE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** The exact cold-point basis values; the field's presence is the owner's pin. */
const COLD_POINT_BASIS_VALUES = Object.freeze({
  base: 'trial-own-route',
  ttl: 'route-base-counterfactual',
})

/** The C-row request-config rule; the field's presence is the owner's pin. */
const C_ROW_REQUEST_CONFIG_VALUE = 'route-base-composition'

/** The trigger row keys of one resolved `ResolvedEscalationTrigger` row. */
const TRIGGER_ROW_KEYS = Object.freeze(['enabled', 'threshold'])

/**
 * Raised when required method fields are absent: the owner has not pinned
 * them. Carries every missing field name on `missing`, in DTO order.
 */
export class MethodUnpinnedError extends TypeError {
  /**
   * @param {string[]} missing - every required field that is absent or undefined.
   */
  constructor(missing) {
    super(missing.length === 0
      ? 'the replay method block is absent'
      : `the replay method is unpinned; the owner must pin: ${missing.map((field) => `method.${field}`).join(', ')}`)
    this.name = 'MethodUnpinnedError'
    this.missing = Object.freeze([...missing])
  }
}

/**
 * Raised when a present method field, or a key at any level, carries a
 * representation the method DTO does not define. Carries the offending
 * field path on `field` and a stable slug for the failure on `reason`.
 */
export class MethodInvalidError extends TypeError {
  /**
   * @param {string} field - the method field path that is invalid.
   * @param {string} reason - a stable slug for why it is invalid.
   * @param {string} [detail] - the exact expectation and the value received.
   */
  constructor(field, reason, detail) {
    super(`method.${field} rejected (${reason})${detail ? `: ${detail}` : ''}`)
    this.name = 'MethodInvalidError'
    this.field = field
    this.reason = reason
  }
}

/** Raised when a row's recorded method does not match the method under evaluation. */
export class MethodProvenanceError extends TypeError {
  /**
   * @param {string} message - the provenance mismatch.
   */
  constructor(message) {
    super(message)
    this.name = 'MethodProvenanceError'
  }
}

/**
 * Whether a value is a plain JSON object: not null, not an array.
 * @param {unknown} value - the value to check.
 * @returns {boolean} whether it is a plain object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Render a received value for an error message.
 * @param {unknown} value - the value to render.
 * @returns {string} the JSON form, or the string form when not JSON.
 */
function render(value) {
  return JSON.stringify(value) ?? String(value)
}

/**
 * Throw MethodInvalidError for one field.
 * @param {string} field - the method field path.
 * @param {string} reason - the stable failure slug.
 * @param {string} detail - the expectation and the value received.
 * @returns {never} never; it always throws.
 */
function reject(field, reason, detail) {
  throw new MethodInvalidError(field, reason, detail)
}

/**
 * Validate the version pin: exactly the row-semantics version this code fixes.
 * @param {unknown} value - the version value.
 * @returns {void}
 */
function validateVersion(value) {
  if (value !== REPLAY_ROW_SEMANTICS_VERSION) {
    reject('version', 'unsupported-version', `must be ${REPLAY_ROW_SEMANTICS_VERSION}, got ${render(value)}`)
  }
}

/**
 * Validate the ECE bin count: a positive safe integer, the acceptance of the
 * metrics `ece()` bin grid.
 * @param {unknown} value - the bin count.
 * @returns {void}
 */
function validateEceBins(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    reject('eceBins', 'type', `must be a safe integer, got ${render(value)}`)
  }
  if (/** @type {number} */ (value) < 1) {
    reject('eceBins', 'range', `must be a positive safe integer (>= 1), got ${render(value)}`)
  }
}

/**
 * Validate the tie-break: a non-empty array of distinct TIE_BREAK_KEYS keys;
 * own keys only, so prototype names are not keys.
 * @param {unknown} value - the tie-break array.
 * @returns {void}
 */
function validateTieBreak(value) {
  if (!Array.isArray(value)) reject('tieBreak', 'type', `must be an array of tie-break keys, got ${render(value)}`)
  if (value.length === 0) reject('tieBreak', 'empty', 'must name at least one tie-break key')
  value.forEach((/** @type {unknown} */ key, /** @type {number} */ index) => {
    if (typeof key !== 'string') reject('tieBreak', 'type', `element ${index} must be a string, got ${render(key)}`)
    if (!Object.hasOwn(TIE_BREAK_KEYS, key)) {
      reject('tieBreak', 'unknown-key', `element ${index} ${render(key)} is not one of ${Object.keys(TIE_BREAK_KEYS).join(', ')}`)
    }
  })
  if (new Set(value).size !== value.length) reject('tieBreak', 'duplicate', 'must not repeat a tie-break key')
}

/**
 * Validate the label sources: exactly the arms S and C, each from its closed
 * set; arm S has no "c-trajectory" source.
 * @param {unknown} value - the labelSources object.
 * @returns {void}
 */
function validateLabelSources(value) {
  if (!isPlainObject(value)) reject('labelSources', 'type', 'must be an object with exactly the keys S and C')
  for (const key of Object.keys(value)) {
    if (key !== 'S' && key !== 'C') {
      reject(`labelSources.${key}`, 'unknown-key', `only the arms S and C are defined, got key ${render(key)}`)
    }
  }
  for (const arm of Object.keys(ARM_LABEL_SOURCES)) {
    if (value[arm] === undefined) reject('labelSources', 'missing-key', `arm ${arm} is absent; both S and C must be pinned`)
  }
  for (const [arm, sources] of Object.entries(ARM_LABEL_SOURCES)) {
    if (!sources.includes(/** @type {string} */ (value[arm]))) {
      reject(
        `labelSources.${arm}`,
        arm === 'S' ? 'unsupported-for-arm' : 'unsupported',
        `must be one of ${sources.join(', ')}${arm === 'S' ? ' (arm S has no c-trajectory source)' : ''}, got ${render(value[arm])}`,
      )
    }
  }
}

/**
 * Validate the trigger table: exactly one `{ enabled, threshold }` row per
 * public ESCALATION_TRIGGERS entry, no other key at either level.
 * @param {unknown} value - the triggerTable object.
 * @returns {void}
 */
function validateTriggerTable(value) {
  if (!isPlainObject(value)) reject('triggerTable', 'type', 'must be an object with one resolved row per trigger')
  for (const key of Object.keys(value)) {
    if (!ESCALATION_TRIGGERS.includes(key)) {
      reject(`triggerTable.${key}`, 'unknown-key', `is not an ESCALATION_TRIGGERS entry; the triggers are ${ESCALATION_TRIGGERS.join(', ')}`)
    }
  }
  for (const trigger of ESCALATION_TRIGGERS) {
    const row = value[trigger]
    if (row === undefined) reject('triggerTable', 'missing-key', `trigger ${trigger} has no row; every ESCALATION_TRIGGERS entry must be pinned`)
    if (!isPlainObject(row)) reject(`triggerTable.${trigger}`, 'type', `must be a { enabled, threshold } row, got ${render(row)}`)
    for (const key of Object.keys(row)) {
      if (!TRIGGER_ROW_KEYS.includes(key)) {
        reject(`triggerTable.${trigger}.${key}`, 'unknown-key', `a trigger row has exactly the keys ${TRIGGER_ROW_KEYS.join(' and ')}`)
      }
    }
    for (const key of TRIGGER_ROW_KEYS) {
      if (row[key] === undefined) reject(`triggerTable.${trigger}`, 'missing-key', `the row has no ${key}`)
    }
    if (typeof row.enabled !== 'boolean') {
      reject(`triggerTable.${trigger}.enabled`, 'type', `must be a boolean, got ${render(row.enabled)}`)
    }
    if (typeof row.threshold !== 'number' || !Number.isSafeInteger(row.threshold)) {
      reject(`triggerTable.${trigger}.threshold`, 'type', `must be a safe integer, got ${render(row.threshold)}`)
    } else if (row.threshold < 1) {
      reject(`triggerTable.${trigger}.threshold`, 'range', `must be a positive integer, got ${render(row.threshold)}`)
    }
  }
}

/**
 * Validate the trigger table id: a slug matching TRIGGER_TABLE_ID_PATTERN.
 * @param {unknown} value - the id.
 * @returns {void}
 */
function validateTriggerTableId(value) {
  if (typeof value !== 'string') reject('triggerTableId', 'type', `must be a string, got ${render(value)}`)
  if (!TRIGGER_TABLE_ID_PATTERN.test(value)) {
    reject('triggerTableId', 'pattern', `must match ${TRIGGER_TABLE_ID_PATTERN.source}, got ${render(value)}`)
  }
}

/**
 * Validate the final-window pin against its closed set.
 * @param {unknown} value - the finalWindow value.
 * @returns {void}
 */
function validateFinalWindow(value) {
  if (!FINAL_WINDOWS.includes(value)) {
    reject('finalWindow', 'unsupported', `must be one of ${FINAL_WINDOWS.map((window) => render(window)).join(', ')}, got ${render(value)}`)
  }
}

/**
 * Validate the cold-point basis: exactly the base and ttl keys, each with its
 * one defined value.
 * @param {unknown} value - the coldPointBasis object.
 * @returns {void}
 */
function validateColdPointBasis(value) {
  if (!isPlainObject(value)) reject('coldPointBasis', 'type', 'must be an object with exactly the keys base and ttl')
  for (const key of Object.keys(value)) {
    if (!(key in COLD_POINT_BASIS_VALUES)) {
      reject(`coldPointBasis.${key}`, 'unknown-key', `a cold-point basis has exactly the keys ${Object.keys(COLD_POINT_BASIS_VALUES).join(' and ')}`)
    }
  }
  for (const key of Object.keys(COLD_POINT_BASIS_VALUES)) {
    if (value[key] === undefined) reject('coldPointBasis', 'missing-key', `${key} is absent; both base and ttl must be pinned`)
  }
  for (const [key, defined] of Object.entries(COLD_POINT_BASIS_VALUES)) {
    if (value[key] !== defined) {
      reject(`coldPointBasis.${key}`, 'unsupported', `the only defined value is ${render(defined)}, got ${render(value[key])}`)
    }
  }
}

/**
 * Validate the C-row request-config rule: exactly its one defined value.
 * @param {unknown} value - the cRowRequestConfig value.
 * @returns {void}
 */
function validateCRowRequestConfig(value) {
  if (value !== C_ROW_REQUEST_CONFIG_VALUE) {
    reject('cRowRequestConfig', 'unsupported', `the only defined value is ${render(C_ROW_REQUEST_CONFIG_VALUE)}, got ${render(value)}`)
  }
}

/**
 * Validate one present field against its DTO representation.
 * @param {string} field - the method field name.
 * @param {unknown} value - the field's value.
 * @returns {void}
 */
function validateField(field, value) {
  switch (field) {
    case 'version': return validateVersion(value)
    case 'eceBins': return validateEceBins(value)
    case 'tieBreak': return validateTieBreak(value)
    case 'labelSources': return validateLabelSources(value)
    case 'triggerTable': return validateTriggerTable(value)
    case 'triggerTableId': return validateTriggerTableId(value)
    case 'finalWindow': return validateFinalWindow(value)
    case 'coldPointBasis': return validateColdPointBasis(value)
    case 'cRowRequestConfig': return validateCRowRequestConfig(value)
    default: throw new TypeError(`method.${field} is not a known replay-method field`)
  }
}

/**
 * Validate the replay method and hash it into the provenance identity every
 * labelled row carries and every metric verifies. Nothing is defaulted, the
 * input is never mutated, and the returned method is a deep clone of it.
 * @param {unknown} value - the method block, a plain JSON object.
 * @param {{ require?: string[] }} [options] - the fields this consumer
 *   requires; defaults to none.
 * @returns {{ method: Record<string, unknown>, methodSha256: string }} the
 *   deep-cloned method and the canonical SHA-256 over it.
 * @throws {MethodUnpinnedError} naming every required field that is absent or
 *   undefined; an absent method block names all of them.
 * @throws {MethodInvalidError} on a non-object method block, an unknown key at
 *   any level, or a present field whose representation the DTO does not
 *   define. Unpinned fields are reported before unknown keys, and unknown
 *   keys before invalid representations.
 * @throws {TypeError} when `options.require` is not an array of known field names.
 */
export function parseReplayMethod(value, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object carrying require')
  }
  const required = options.require ?? []
  if (!Array.isArray(required)) throw new TypeError('options.require must be an array of method field names')
  for (const name of required) {
    if (!ALL_METHOD_FIELDS.includes(name)) {
      throw new TypeError(`options.require names ${render(name)}, which is not a replay-method field; the fields are ${ALL_METHOD_FIELDS.join(', ')}`)
    }
  }
  if (value === undefined || value === null) {
    throw new MethodUnpinnedError(ALL_METHOD_FIELDS.filter((field) => required.includes(field)))
  }
  if (!isPlainObject(value)) {
    throw new MethodInvalidError('method', 'type', `the method block must be a JSON object, got ${render(value)}`)
  }
  const missing = ALL_METHOD_FIELDS.filter((field) => required.includes(field) && value[field] === undefined)
  if (missing.length > 0) throw new MethodUnpinnedError(missing)
  for (const key of Object.keys(value)) {
    if (!ALL_METHOD_FIELDS.includes(key)) {
      throw new MethodInvalidError(key, 'unknown-field', `is not a replay-method field; the fields are ${ALL_METHOD_FIELDS.join(', ')}`)
    }
  }
  for (const field of ALL_METHOD_FIELDS) {
    if (value[field] !== undefined) validateField(field, value[field])
  }
  const method = structuredClone(value)
  const methodSha256 = createHash('sha256').update(canonicalize(method)).digest('hex')
  return { method, methodSha256 }
}
