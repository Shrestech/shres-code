/**
 * Runtime factories and decode helpers for charter entry ids.
 *
 * @module @shres-code/shres-code-jspace/charter
 */

import type { Branded } from '@shres-code/shres-code-brand'
import type {
  CharterFailProbe,
  CharterUnverifiedReason,
  JspaceCharterEntry,
} from './types.ts'

const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

/** Stable per-card charter entry id. Not a `CallId`. */
export type CharterEntryId = Branded<'CharterEntryId'>

/**
 * Brand a kebab-case charter entry id.
 * @param id - candidate token.
 * @returns the branded id.
 * @throws TypeError when the token is empty, has surrounding whitespace, or is not kebab-case.
 */
export function CharterEntryId(id: string): CharterEntryId {
  if (id.trim().length === 0 || id !== id.trim() || !ID_PATTERN.test(id)) {
    throw new TypeError(`charter entry id must be a kebab-case token, got ${JSON.stringify(id)}`)
  }
  return id as CharterEntryId
}

/**
 * Assign `e1`, `e2`, … skipping ids already taken.
 * @param taken - ids already on the card or earlier in this batch.
 * @returns the next unused harness id.
 */
export function nextCharterEntryId(taken: ReadonlySet<string>): CharterEntryId {
  let n = 1
  while (taken.has(`e${String(n)}`)) n += 1
  return CharterEntryId(`e${String(n)}`)
}

/**
 * Mark an unreachable closed-union branch.
 * @param value - the impossible value.
 * @param context - optional label prefixed into the throw message.
 * @returns never.
 */
export function assertNever(value: never, context?: string): never {
  const rendered = (JSON.stringify(value) as string | undefined) ?? String(value)
  throw new Error(`unreachable variant${context ? ` in ${context}` : ''}: ${rendered}`)
}

/** Whether a value is a JSON record rather than an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Require a non-empty trimmed string.
 * @param value - candidate.
 * @param field - field name for the error.
 * @returns the string.
 */
function requiredLine(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`jspace ${field} must be a non-empty trimmed string`)
  }
  return value
}

/**
 * Require a non-empty string. Surrounding whitespace is allowed: failProbe
 * mutation text is file content, not a card line.
 * @param value - candidate.
 * @param field - field name for the error.
 * @returns the string.
 */
function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`jspace ${field} must be a non-empty string`)
  }
  return value
}

/**
 * Decode one failProbe mutation.
 * @param value - candidate mutation.
 * @returns the mutation.
 */
function decodeFailProbeMutation(value: unknown): CharterFailProbe {
  if (!isRecord(value)) throw new Error('jspace charter failProbe.mutation must be a record')
  const kind = value['kind']
  if (kind === 'insert' || kind === 'prepend') {
    return { kind, content: requiredText(value['content'], 'failProbe.mutation.content') }
  }
  if (kind === 'replace') {
    return {
      kind,
      from: requiredText(value['from'], 'failProbe.mutation.from'),
      to: requiredText(value['to'], 'failProbe.mutation.to'),
    }
  }
  throw new Error('jspace charter failProbe.mutation.kind must be insert, prepend, or replace')
}

const UNVERIFIED_REASONS: ReadonlySet<CharterUnverifiedReason> = new Set([
  'discrimination-off',
  'policy-denied',
  'probe-timeout',
  'probe-infeasible',
])

/**
 * Decode one folded charter entry. Throws on shape failure.
 * @param value - candidate entry.
 * @returns the entry.
 */
export function decodeJspaceCharterEntry(value: unknown): JspaceCharterEntry {
  if (!isRecord(value)) throw new Error('jspace charter entry must be a record')
  const id = CharterEntryId(requiredLine(value['id'], 'charter.id'))
  const kind = value['kind']
  const constraint = requiredLine(value['constraint'], 'charter.constraint')
  if (kind === 'prose') {
    return { kind: 'prose', id, constraint }
  }
  if (kind !== 'check') {
    throw new Error('jspace charter entry kind must be check or prose')
  }
  const command = requiredLine(value['command'], 'charter.command')
  if (!Array.isArray(value['reads']) || value['reads'].length === 0) {
    throw new Error('jspace charter reads must be a non-empty array')
  }
  const reads = value['reads'].map((item, index) => requiredLine(item, `charter.reads[${String(index)}]`))
  const discrimination = value['discrimination']
  if (discrimination !== 'demonstrated' && discrimination !== 'unverified') {
    throw new Error('jspace charter discrimination must be demonstrated or unverified')
  }
  const failProbeRaw = value['failProbe']
  const failProbe = failProbeRaw === undefined
    ? undefined
    : (() => {
      if (!isRecord(failProbeRaw)) throw new Error('jspace charter failProbe must be a record')
      return {
        path: requiredLine(failProbeRaw['path'], 'charter.failProbe.path'),
        mutation: decodeFailProbeMutation(failProbeRaw['mutation']),
      }
    })()
  const reasonRaw = value['unverifiedReason']
  let unverifiedReason: CharterUnverifiedReason | undefined
  if (reasonRaw !== undefined) {
    if (typeof reasonRaw !== 'string' || !UNVERIFIED_REASONS.has(reasonRaw as CharterUnverifiedReason)) {
      throw new Error('jspace charter unverifiedReason is not a known reason')
    }
    unverifiedReason = reasonRaw as CharterUnverifiedReason
  }
  if (discrimination === 'unverified' && unverifiedReason === undefined) {
    throw new Error('jspace charter unverifiedReason is required when discrimination is unverified')
  }
  return {
    kind: 'check',
    id,
    constraint,
    command,
    reads,
    discrimination,
    ...failProbe === undefined ? {} : { failProbe },
    ...discrimination === 'unverified' && unverifiedReason !== undefined
      ? { unverifiedReason }
      : {},
  }
}

/**
 * Decode a card `charter` field. Missing becomes `[]` so older snapshots stay readable.
 * @param value - candidate list, or `undefined` when the field is absent.
 * @returns the list.
 */
export function decodeJspaceCharter(value: unknown): readonly JspaceCharterEntry[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('jspace charter must be an array')
  const entries = value.map(decodeJspaceCharterEntry)
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`jspace charter id ${entry.id} is reused`)
    seen.add(entry.id)
  }
  return entries
}

/**
 * Reprint one charter entry: id, status mark, truncated constraint. Commands are omitted.
 * @param entry - folded entry.
 * @returns one semicolon-list item.
 */
export function formatCharterEntrySummary(entry: JspaceCharterEntry): string {
  const text = entry.constraint.length > 40 ? entry.constraint.slice(0, 40) : entry.constraint
  if (entry.kind === 'prose') return `${entry.id} prose ${text}`
  if (entry.kind === 'check') {
    if (entry.discrimination === 'demonstrated') return `${entry.id} ✓ ${text}`
    return `${entry.id} ? ${text} [unverified]`
  }
  return assertNever(entry, 'formatCharterEntrySummary')
}
