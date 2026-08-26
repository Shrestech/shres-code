/**
 * Discrimination bar: a check is credited only when nested bash fails after
 * a content mutation of a declared `reads` path, then restore succeeds.
 *
 * @module @shres-code/shres-code-tool-jspace/charter-probe
 */

import { unlink } from 'node:fs/promises'
import type { Context } from '@shres-code/cordis'
import type { FileSystem } from '@shres-code/shres-code-fs'
import type { ToolRunContext } from '@shres-code/shres-code-tools'
import type {
  CharterCheckInput,
  CharterEntryId,
  CharterFailProbe,
  CharterUnverifiedReason,
  JspaceCharterCheck,
} from '@shres-code/shres-code-jspace'
import { assertNever, CharterEntryId as brandCharterId } from '@shres-code/shres-code-jspace'
import { runCharterCheck, type CharterRunConfig } from './charter-run.ts'

/** Model-visible refuse when `ctx.fs` is missing under `required`. */
export const CHARTER_FS_REQUIRED
  = 'charter discrimination requires `ctx.fs`; load an fs provider such as `@shres-code/shres-code-fs-local`.'

/** Probe-infeasible copy when a glob-only check matches no files after mutation. */
const CHARTER_NO_SUBJECT_REFUSE
  = 'matched no files in `reads`. The workspace has no subject for this check.'

/** Discrimination mode from tool-jspace Config. */
export type CharterDiscriminationMode = 'off' | 'best-effort' | 'required'

/** Options for {@link discriminateCharterCheck}. */
export interface DiscriminateOptions {
  readonly mode: CharterDiscriminationMode
  readonly run: CharterRunConfig
}

/**
 * Run floor-already-passed discrimination for one check at registration.
 * @param ctx - context that may carry `fs`.
 * @param exec - parent open/amend execution.
 * @param entry - check with an assigned id.
 * @param options - mode and timeout.
 * @returns the folded check, or throws when `'required'` cannot demonstrate.
 */
export async function discriminateCharterCheck(
  ctx: Context,
  exec: ToolRunContext,
  entry: CharterCheckInput & { readonly id: CharterEntryId },
  options: DiscriminateOptions,
): Promise<JspaceCharterCheck> {
  if (options.mode === 'off') {
    return withStatus(entry, 'unverified', 'discrimination-off')
  }
  const fs = ctx.get('fs') as FileSystem | undefined
  if (fs === undefined) {
    if (options.mode === 'required') throw new Error(CHARTER_FS_REQUIRED)
    return withStatus(entry, 'unverified', 'probe-infeasible')
  }
  if (entry.failProbe === undefined) {
    const message
      = `charter entry "${entry.id}" has no failProbe; add a content mutation of a \`reads\` path that this command rejects.`
    if (options.mode === 'required') throw new Error(message)
    return withStatus(entry, 'unverified', 'probe-infeasible')
  }
  const cwd = exec.agent?.session.header.cwd ?? process.cwd()
  const probePath = entry.failProbe.path
  const target = await fs.resolve(probePath, { cwd, signal: exec.signal })
  const existed = (await fs.stat(target, exec.signal)) !== undefined
  let original: string | undefined
  if (existed) original = await fs.readText(target, exec.signal)
  const mutated = applyFailProbe(original, entry.failProbe.mutation)
  if (mutated === undefined) {
    const reason: CharterUnverifiedReason = 'probe-infeasible'
    const message = entry.failProbe.mutation.kind === 'replace'
      ? (original === undefined
        ? `charter entry "${entry.id}" failProbe.replace cannot run: ${probePath} is absent.`
        : `failProbe.replace.from not found in ${probePath}.`)
      : `charter entry "${entry.id}" failProbe is infeasible.`
    if (options.mode === 'required') throw new Error(message)
    return withStatus(entry, 'unverified', reason)
  }
  await fs.writeText(target, mutated, undefined, exec.signal)
  let demonstrated = false
  let unverifiedReason: CharterUnverifiedReason | undefined
  let refuse: string | undefined
  try {
    const folded = withStatus(entry, 'unverified', 'probe-infeasible')
    const outcome = await runCharterCheck(ctx, exec, folded, 'probe', options.run)
    if (outcome.deniedReason !== undefined && !outcome.deniedReason.startsWith('JSPACE_CHARTER_NO_SUBJECT')) {
      unverifiedReason = 'policy-denied'
      if (options.mode === 'required') {
        refuse = `charter entry "${entry.id}" discrimination probe was denied: ${outcome.deniedReason}`
      }
    } else if (outcome.deniedReason?.startsWith('JSPACE_CHARTER_NO_SUBJECT') === true) {
      unverifiedReason = 'probe-infeasible'
      if (options.mode === 'required') {
        refuse = `charter entry "${entry.id}" ${CHARTER_NO_SUBJECT_REFUSE}`
      }
    } else if (outcome.timedOut === true) {
      unverifiedReason = 'probe-timeout'
      if (options.mode === 'required') {
        refuse = `charter entry "${entry.id}" discrimination probe timed out.`
      }
    } else if (outcome.passed) {
      unverifiedReason = 'probe-infeasible'
      if (options.mode === 'required') {
        refuse
          = `charter entry "${entry.id}" (${entry.constraint}) still passed after the failProbe mutation of ${probePath}. `
            + 'The command does not detect this violation. Change the command so it fails when that constraint is broken.'
      }
    } else {
      demonstrated = true
    }
    exec.agent?.session.append('jspace/charter-probe', {
      entryId: entry.id,
      callId: outcome.callId,
      path: probePath,
      mutationKind: entry.failProbe.mutation.kind,
      demonstrated,
      ...demonstrated || unverifiedReason === undefined ? {} : { unverifiedReason },
    }, { ignorable: true })
    if (refuse !== undefined) throw new Error(refuse)
  } finally {
    await restoreProbe(fs, target, existed, original, exec)
  }
  if (demonstrated) return withStatus(entry, 'demonstrated')
  return withStatus(entry, 'unverified', unverifiedReason ?? 'probe-infeasible')
}

/**
 * Apply a content-only failProbe to existing text.
 * @param existing - current file text, or `undefined` when absent.
 * @param mutation - insert, prepend, or replace.
 * @returns new text, or `undefined` when replace cannot run.
 */
export function applyFailProbe(
  existing: string | undefined,
  mutation: CharterFailProbe,
): string | undefined {
  switch (mutation.kind) {
    case 'insert':
      return mutation.content
    case 'prepend':
      return `${mutation.content}${existing ?? ''}`
    case 'replace':
      if (existing === undefined) return undefined
      if (!existing.includes(mutation.from)) return undefined
      return existing.replace(mutation.from, mutation.to)
    default:
      return assertNever(mutation, 'applyFailProbe')
  }
}

/**
 * Restore the probe snapshot. Restore failure is harness I/O, not a charter refusal.
 * @param fs - filesystem.
 * @param target - resolved probe file.
 * @param existed - whether the file existed before the probe.
 * @param original - prior text when it existed.
 * @param exec - parent execution (signal).
 */
async function restoreProbe(
  fs: FileSystem,
  target: Parameters<FileSystem['writeText']>[0],
  existed: boolean,
  original: string | undefined,
  exec: ToolRunContext,
): Promise<void> {
  if (existed) {
    await fs.writeText(target, original ?? '', undefined, exec.signal)
    return
  }
  await unlink(fs.processPath(target))
}

/**
 * Attach discrimination status to a check input.
 * @param entry - input with id.
 * @param discrimination - demonstrated or unverified.
 * @param unverifiedReason - required when unverified.
 * @returns folded check.
 */
function withStatus(
  entry: CharterCheckInput & { readonly id: CharterEntryId },
  discrimination: 'demonstrated' | 'unverified',
  unverifiedReason?: CharterUnverifiedReason,
): JspaceCharterCheck {
  return {
    kind: 'check',
    id: brandCharterId(entry.id),
    constraint: entry.constraint,
    command: entry.command,
    reads: entry.reads,
    discrimination,
    ...entry.failProbe === undefined ? {} : { failProbe: entry.failProbe },
    ...discrimination === 'unverified' && unverifiedReason !== undefined
      ? { unverifiedReason }
      : {},
  }
}
