/**
 * Resolve `jspace_open` / `jspace_charter_amend` charter arguments: expand
 * accept-proposal, assign ids, run floor and discrimination.
 *
 * @module @shres-code/shres-code-tool-jspace/charter-resolve
 */

import type { Context } from '@shres-code/cordis'
import type { ToolRunContext } from '@shres-code/shres-code-tools'
import {
  CharterEntryId,
  nextCharterEntryId,
  type CharterCheckInput,
  type CharterEntryId as CharterId,
  type CharterEntryInput,
  type CharterFailProbe,
  type JspaceCharterEntry,
  type JspaceCharterProse,
} from '@shres-code/shres-code-jspace'
import { discriminateCharterCheck, type CharterDiscriminationMode } from './charter-probe.ts'
import { evaluateCharterFloor } from './floor.ts'
import type { CharterRunConfig } from './charter-run.ts'

/** Open/amend charter item as inferred from the tool schema. */
export type CharterToolItem =
  | CharterCheckInput
  | { readonly kind: 'prose'; readonly id?: string; readonly constraint: string }
  | { readonly kind: 'accept-proposal'; readonly ids?: readonly string[] }

/** Replace row from `jspace_charter_amend`. */
export interface CharterReplaceRow {
  readonly id: string
  readonly entry: CharterCheckInput | { readonly kind: 'prose'; readonly id?: string; readonly constraint: string }
}

/** Config used while resolving a charter list. */
export interface CharterResolveConfig extends CharterRunConfig {
  readonly charterDiscrimination: CharterDiscriminationMode
  readonly charterChecksMustBeReadOnly: boolean
  readonly requireCharter: boolean
  readonly requireExecutableCharter: boolean
}

/** Model-visible refuse when `requireCharter` finds an empty list at first registration. */
export const OPEN_REQUIRES_CHARTER
  = 'jspace_open requires a charter. Pass kind=accept-proposal to confirm the harness proposal, or send kind=check entries.'

/** Model-visible refuse when `requireExecutableCharter` finds no check. */
export const OPEN_REQUIRES_EXECUTABLE_CHARTER
  = 'jspace_open requires at least one kind=check charter entry the harness can run at checkpoint and ship.'

/** Model-visible refuse when checkpoint finds no charter under `requireCharter`. */
export const CHECKPOINT_REQUIRES_CHARTER
  = 'no charter is registered; call jspace_open with a charter or jspace_charter_amend.'

/** Model-visible refuse when `jspace_open` carries a charter onto a non-empty card charter. */
export const CHARTER_ALREADY_REGISTERED
  = 'a charter is already registered on this card; call jspace_charter_amend to drop, replace, or add entries. jspace_open does not replace a non-empty charter.'

/**
 * Model-visible refuse when the resulting list would exceed `maxCharterEntries`.
 * @param count - resulting entry count.
 * @param cap - configured cap.
 * @returns refusal text, or `undefined` when within cap.
 */
export function refuseCharterCap(count: number, cap: number): string | undefined {
  if (count <= cap) return undefined
  return `jspace charter would have ${count} entries; maxCharterEntries is ${cap}. Drop or replace entries, or raise the cap.`
}

/**
 * Latest `jspace/charter-proposal` entries in this session.
 * @param exec - parent tool execution (owns the session).
 * @returns the newest proposal entries, or `undefined` when none exist.
 */
export function latestCharterProposal(
  exec: ToolRunContext,
): readonly CharterEntryInput[] | undefined {
  const events = exec.agent?.session.events
  if (events === undefined) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'jspace/charter-proposal') return event.data.entries
  }
  return undefined
}

/**
 * Expand accept-proposal rows first, then append explicit adds. Refuse on
 * unknown proposal ids or id collisions.
 * @param items - raw tool charter array.
 * @param proposal - latest proposal entries, when any.
 * @returns check/prose inputs in registration order.
 */
export function expandCharterItems(
  items: readonly CharterToolItem[] | undefined,
  proposal: readonly CharterEntryInput[] | undefined,
): CharterEntryInput[] {
  if (items === undefined || items.length === 0) return []
  const accepted: CharterEntryInput[] = []
  const explicit: CharterEntryInput[] = []
  for (const item of items) {
    if (item.kind === 'accept-proposal') {
      if (proposal === undefined) {
        throw new Error('jspace_open kind=accept-proposal requires a jspace/charter-proposal in this session.')
      }
      if (item.ids === undefined || item.ids.length === 0) {
        accepted.push(...proposal)
        continue
      }
      for (const rawId of item.ids) {
        const found = proposal.find(entry => entry.id === rawId)
        if (found === undefined) {
          throw new Error(`jspace_open accept-proposal id ${JSON.stringify(rawId)} is not in the harness proposal.`)
        }
        accepted.push(found)
      }
      continue
    }
    explicit.push(item as CharterEntryInput)
  }
  const combined = [...accepted, ...explicit]
  const seen = new Set<string>()
  for (const entry of combined) {
    if (entry.id === undefined) continue
    if (seen.has(entry.id)) {
      throw new Error(`jspace charter id ${JSON.stringify(entry.id)} collides with another entry in this call.`)
    }
    seen.add(entry.id)
  }
  return combined
}

/**
 * Assign omitted ids (`e1`, `e2`, … skipping taken).
 * @param entries - inputs, some without ids.
 * @param taken - ids already on the card.
 * @returns entries with ids assigned.
 */
export function assignCharterIds(
  entries: readonly CharterEntryInput[],
  taken: ReadonlySet<string> = new Set(),
): Array<CharterEntryInput & { readonly id: CharterId }> {
  const used = new Set(taken)
  return entries.map((entry) => {
    if (entry.id !== undefined) {
      const id = CharterEntryId(entry.id)
      if (used.has(id)) {
        throw new Error(`jspace charter id ${JSON.stringify(id)} is already taken.`)
      }
      used.add(id)
      return { ...entry, id }
    }
    const id = nextCharterEntryId(used)
    used.add(id)
    return { ...entry, id }
  })
}

/**
 * Run floor then discrimination on every check. Prose is copied through.
 * @param ctx - context.
 * @param exec - parent execution.
 * @param entries - id-assigned inputs.
 * @param config - floor and discrimination.
 * @returns folded charter list.
 */
export async function foldCharterEntries(
  ctx: Context,
  exec: ToolRunContext,
  entries: ReadonlyArray<CharterEntryInput & { readonly id: CharterId }>,
  config: CharterResolveConfig,
): Promise<JspaceCharterEntry[]> {
  const cwd = exec.agent?.session.header.cwd ?? process.cwd()
  const folded: JspaceCharterEntry[] = []
  for (const entry of entries) {
    if (entry.kind === 'prose') {
      folded.push({
        kind: 'prose',
        id: entry.id,
        constraint: entry.constraint,
      } satisfies JspaceCharterProse)
      continue
    }
    const check = normalizeCheck(entry)
    const floor = evaluateCharterFloor(check, {
      cwd,
      readOnly: config.charterChecksMustBeReadOnly,
      id: check.id,
    })
    if (!floor.ok) throw new Error(floor.message)
    folded.push(await discriminateCharterCheck(ctx, exec, check, {
      mode: config.charterDiscrimination,
      run: { charterCheckTimeoutMs: config.charterCheckTimeoutMs },
    }))
  }
  return folded
}

/**
 * Whether a folded list satisfies `requireExecutableCharter`.
 * @param entries - folded charter.
 * @param mode - discrimination mode.
 * @returns true when at least one credited check remains.
 */
export function hasExecutableCharter(
  entries: readonly JspaceCharterEntry[],
  mode: CharterDiscriminationMode,
): boolean {
  return entries.some((entry) => {
    if (entry.kind !== 'check') return false
    if (mode === 'required') return entry.discrimination === 'demonstrated'
    return true
  })
}

/**
 * Refuse a first charter registration that does not meet charter requirements.
 * @param entries - resolved folded list.
 * @param config - requirements.
 * @returns refusal message, or `undefined`.
 */
export function charterOpenRefusal(
  entries: readonly JspaceCharterEntry[],
  config: Pick<CharterResolveConfig, 'requireCharter' | 'requireExecutableCharter' | 'charterDiscrimination'>,
): string | undefined {
  if (config.requireCharter && entries.length === 0) return OPEN_REQUIRES_CHARTER
  if (config.requireExecutableCharter && !hasExecutableCharter(entries, config.charterDiscrimination)) {
    return OPEN_REQUIRES_EXECUTABLE_CHARTER
  }
  return undefined
}

/**
 * Compute the next charter list for amend: drop, then replace, then add.
 * @param current - folded card charter.
 * @param drop - ids to remove.
 * @param replace - rows to replace.
 * @param add - entries to append.
 * @returns next id-assigned inputs (checks still need floor + discrimination).
 */
export function planCharterAmend(
  current: readonly JspaceCharterEntry[],
  drop: readonly string[] | undefined,
  replace: readonly CharterReplaceRow[] | undefined,
  add: readonly CharterToolItem[] | undefined,
): {
  readonly dropped: readonly CharterId[]
  readonly replaced: readonly CharterId[]
  readonly added: ReadonlyArray<CharterEntryInput & { readonly id: CharterId }>
  readonly kept: readonly JspaceCharterEntry[]
} {
  const dropped: CharterId[] = []
  let kept = [...current]
  for (const raw of drop ?? []) {
    const id = CharterEntryId(raw)
    const index = kept.findIndex(entry => entry.id === id)
    if (index < 0) throw new Error(`jspace_charter_amend drop id ${JSON.stringify(raw)} is not on the card.`)
    dropped.push(id)
    kept = kept.filter(entry => entry.id !== id)
  }
  const replaced: CharterId[] = []
  const replacementInputs: Array<CharterEntryInput & { readonly id: CharterId }> = []
  for (const row of replace ?? []) {
    const id = CharterEntryId(row.id)
    const index = kept.findIndex(entry => entry.id === id)
    if (index < 0) throw new Error(`jspace_charter_amend replace id ${JSON.stringify(row.id)} is not on the card.`)
    replaced.push(id)
    kept = kept.filter(entry => entry.id !== id)
    replacementInputs.push({ ...asEntryInput(row.entry), id })
  }
  const taken = new Set<string>([
    ...kept.map(entry => entry.id),
    ...replacementInputs.map(entry => entry.id),
  ])
  const added = assignCharterIds(
    (add ?? []).map((item) => {
      if (item.kind === 'accept-proposal') {
        throw new Error('jspace_charter_amend add does not accept kind=accept-proposal.')
      }
      return asEntryInput(item)
    }),
    taken,
  )
  return { dropped, replaced, added: [...replacementInputs, ...added], kept }
}

/**
 * Narrow a tool check/prose object to {@link CharterEntryInput}.
 * @param item - tool argument.
 * @returns typed input.
 */
function asEntryInput(
  item: CharterCheckInput | { readonly kind: 'prose'; readonly id?: string; readonly constraint: string },
): CharterEntryInput {
  if (item.kind === 'prose') {
    return {
      kind: 'prose',
      constraint: item.constraint,
      ...item.id === undefined ? {} : { id: CharterEntryId(item.id) },
    }
  }
  return normalizeCheckInput(item)
}

/**
 * Copy a check input, branding an id when present.
 * @param entry - tool check object.
 * @returns branded check input.
 */
function normalizeCheckInput(entry: CharterCheckInput): CharterCheckInput {
  return {
    kind: 'check',
    constraint: entry.constraint,
    command: entry.command,
    reads: entry.reads,
    ...entry.id === undefined ? {} : { id: CharterEntryId(entry.id) },
    ...entry.failProbe === undefined ? {} : { failProbe: entry.failProbe as { path: string; mutation: CharterFailProbe } },
  }
}

/**
 * Require a branded id on a check.
 * @param entry - id-assigned check.
 * @returns check with branded id.
 */
function normalizeCheck(
  entry: CharterEntryInput & { readonly id: CharterId },
): CharterCheckInput & { readonly id: CharterId } {
  if (entry.kind !== 'check') {
    throw new Error('jspace charter expected a check entry')
  }
  return {
    kind: 'check',
    id: entry.id,
    constraint: entry.constraint,
    command: entry.command,
    reads: entry.reads,
    ...entry.failProbe === undefined ? {} : { failProbe: entry.failProbe },
  }
}
