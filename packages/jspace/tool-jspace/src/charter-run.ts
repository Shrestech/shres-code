/**
 * Nested `bash` dispatch for registered charter checks via `ctx.tools.execute`.
 *
 * @module @shres-code/shres-code-tool-jspace/charter-run
 */

import { glob, stat as nodeStat } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@shres-code/cordis'
import type { CallId } from '@shres-code/shres-code-llm/brand'
import { CallId as brandCallId } from '@shres-code/shres-code-llm/brand'
import type { ToolExecutionResult, ToolRunContext } from '@shres-code/shres-code-tools'
import type {
  JspaceCharterCheck,
  JspaceCharterEntry,
} from '@shres-code/shres-code-jspace'
import { isGlobPattern, resolveInsideCwd } from './floor.ts'

/** Max stdout+stderr preview stored on `jspace/charter-run`. */
export const CHARTER_OUTPUT_PREVIEW_BYTES = 2048

/** Model-visible refuse when the bash tool is missing. */
export const CHARTER_CHECKS_REQUIRE_BASH
  = 'charter checks require the bash tool; load `@shres-code/shres-code-tool-bash` (and a `ctx.shell` provider).'

/** Vacuous glob success is treated as failure. */
export const CHARTER_NO_SUBJECT
  = 'matched no files in `reads`. The workspace has no subject for this check.'

/** One expanded-reads fingerprint record. */
export interface CharterReadsFingerprint {
  readonly path: string
  readonly mtimeMs: number
  readonly size: number
}

/** Outcome of one nested charter bash run. */
export interface CharterRunOutcome {
  readonly entry: JspaceCharterCheck
  readonly callId: CallId
  readonly passed: boolean
  readonly exitCode?: number | null
  readonly deniedReason?: string
  readonly timedOut?: boolean
  readonly outputPreview: string
  readonly readsFingerprint: readonly CharterReadsFingerprint[]
}

/** Config the nested runner reads. */
export interface CharterRunConfig {
  readonly charterCheckTimeoutMs: number
}

/** Why this nested run executed. */
export type CharterRunPhase = 'checkpoint' | 'ship' | 'probe'

/**
 * Run every `kind: 'check'` entry sequentially. First failure throws a named Error.
 * @param ctx - context with tools and sessions.
 * @param exec - parent jspace_* execution.
 * @param entries - folded charter.
 * @param phase - checkpoint, ship, or probe.
 * @param config - timeout.
 * @returns the last successful check outcome, or `undefined` when there are no checks.
 */
export async function runCharter(
  ctx: Context,
  exec: ToolRunContext,
  entries: readonly JspaceCharterEntry[],
  phase: CharterRunPhase,
  config: CharterRunConfig,
): Promise<CharterRunOutcome | undefined> {
  let last: CharterRunOutcome | undefined
  for (const entry of entries) {
    if (entry.kind === 'prose') continue
    const outcome = await runCharterCheck(ctx, exec, entry, phase, config)
    if (!outcome.passed) throw new Error(formatCharterFailure(phase, outcome))
    last = outcome
  }
  return last
}

/**
 * Dispatch one check through nested `bash`.
 * @param ctx - context with tools.
 * @param exec - parent execution.
 * @param entry - folded check.
 * @param phase - why it ran.
 * @param config - timeout.
 * @returns the outcome (caller logs and decides whether to throw).
 */
export async function runCharterCheck(
  ctx: Context,
  exec: ToolRunContext,
  entry: JspaceCharterCheck,
  phase: CharterRunPhase,
  config: CharterRunConfig,
): Promise<CharterRunOutcome> {
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error('charter checks require an owning agent session')
  }
  if (ctx.tools.get('bash', agent) === undefined) {
    throw new Error(CHARTER_CHECKS_REQUIRE_BASH)
  }
  const cwd = agent.session.header.cwd ?? process.cwd()
  const callId = brandCallId(`${String(exec.callId)}:charter:${entry.id}`)
  const result = await ctx.tools.execute({
    callId,
    rootCallId: exec.rootCallId,
    name: 'bash',
    arguments: {
      command: entry.command,
      description: `Run charter check ${entry.id}`,
      timeoutMs: config.charterCheckTimeoutMs,
    },
    agent,
    parent: exec.token,
    signal: exec.signal,
  })
  const classified = classifyBashResult(result)
  const expanded = await expandReads(cwd, entry.reads)
  const globReads = entry.reads.filter(spec => isGlobPattern(spec))
  const literalReads = entry.reads.filter(spec => !isGlobPattern(spec))
  const globMatches = expanded.filter(item => globReads.some(spec => item.glob === spec))
  const fingerprint = await fingerprintReads(cwd, expanded.map(item => item.path))
  const outcome: CharterRunOutcome = classified.passed
    && literalReads.length === 0
    && globReads.length > 0
    && globMatches.length === 0
    ? {
      entry,
      callId,
      passed: false,
      ...classified.exitCode === undefined ? {} : { exitCode: classified.exitCode },
      outputPreview: clipPreview(`${classified.outputPreview}\nJSPACE_CHARTER_NO_SUBJECT: ${CHARTER_NO_SUBJECT}`),
      readsFingerprint: fingerprint,
      deniedReason: `JSPACE_CHARTER_NO_SUBJECT: charter entry "${entry.id}" ${CHARTER_NO_SUBJECT}`,
    }
    : {
      entry,
      callId,
      passed: classified.passed,
      ...classified.exitCode === undefined ? {} : { exitCode: classified.exitCode },
      ...classified.deniedReason === undefined ? {} : { deniedReason: classified.deniedReason },
      ...classified.timedOut === true ? { timedOut: true } : {},
      outputPreview: classified.outputPreview,
      readsFingerprint: fingerprint,
    }
  logCharterRun(exec, outcome, phase)
  return outcome
}

/** Classified nested bash result. */
interface ClassifiedBash {
  readonly passed: boolean
  readonly exitCode?: number | null
  readonly deniedReason?: string
  readonly timedOut?: boolean
  readonly outputPreview: string
}

/**
 * Map a tool result onto charter pass/fail.
 * Non-zero exit is a failed check, not `isError`.
 * @param result - nested bash settle.
 * @returns classified bits.
 */
export function classifyBashResult(result: ToolExecutionResult): ClassifiedBash {
  const outputPreview = clipPreview(textOf(result))
  if (result.isError) {
    return {
      passed: false,
      deniedReason: result.error.message,
      outputPreview,
    }
  }
  const value = result.value as {
    kind?: string
    exitCode?: number | null
    timedOut?: boolean
    aborted?: boolean
  } | undefined
  if (value?.kind !== 'foreground') {
    return { passed: false, outputPreview }
  }
  if (value.timedOut === true || value.aborted === true) {
    return {
      passed: false,
      ...value.exitCode === undefined ? {} : { exitCode: value.exitCode },
      timedOut: value.timedOut === true,
      outputPreview,
    }
  }
  const exitCode = value.exitCode ?? null
  return {
    passed: exitCode === 0,
    exitCode,
    outputPreview,
  }
}

/**
 * Expand `reads` against session cwd via `fs.glob`. Literals are kept even when missing.
 * @param cwd - session cwd.
 * @param reads - declared specs.
 * @returns expanded relative paths tagged with the originating spec.
 */
export async function expandReads(
  cwd: string,
  reads: readonly string[],
): Promise<ReadonlyArray<{ path: string; glob: string }>> {
  const out: Array<{ path: string; glob: string }> = []
  const seen = new Set<string>()
  for (const spec of reads) {
    const relative = resolveInsideCwd(cwd, spec) ?? spec.replaceAll('\\', '/')
    if (isGlobPattern(spec)) {
      for await (const match of glob(spec, { cwd })) {
        const rel = match.replaceAll('\\', '/')
        if (seen.has(rel)) continue
        seen.add(rel)
        out.push({ path: rel, glob: spec })
      }
      continue
    }
    if (seen.has(relative)) continue
    seen.add(relative)
    out.push({ path: relative, glob: spec })
  }
  return out
}

/**
 * Best-effort `{ path, mtimeMs, size }` for expanded reads. Missing files are omitted.
 * @param cwd - session cwd.
 * @param paths - workspace-relative paths.
 * @returns fingerprint records.
 */
export async function fingerprintReads(
  cwd: string,
  paths: readonly string[],
): Promise<readonly CharterReadsFingerprint[]> {
  const records: CharterReadsFingerprint[] = []
  for (const rel of paths) {
    try {
      const info = await nodeStat(path.resolve(cwd, rel))
      records.push({ path: rel, mtimeMs: info.mtimeMs, size: info.size })
    } catch {
      // Best-effort: missing files are omitted and never gate a skip.
    }
  }
  return records
}

/**
 * Named refusal for a failed checkpoint/ship run.
 * @param phase - outer tool.
 * @param outcome - failed check.
 * @returns model-visible text.
 */
export function formatCharterFailure(phase: CharterRunPhase, outcome: CharterRunOutcome): string {
  const prefix = phase === 'ship' ? 'jspace_ship refused' : 'jspace_checkpoint refused'
  const exit = outcome.deniedReason !== undefined
    ? (outcome.deniedReason.startsWith('JSPACE_CHARTER_NO_SUBJECT') ? 'no-subject' : 'denied')
    : outcome.timedOut === true
      ? 'timeout'
      : String(outcome.exitCode ?? 'error')
  const denied = outcome.deniedReason !== undefined && !outcome.deniedReason.startsWith('JSPACE_CHARTER_NO_SUBJECT')
    ? `\ndenied: ${outcome.deniedReason}`
    : ''
  return [
    `${prefix}: charter entry "${outcome.entry.id}" failed.`,
    `constraint: ${outcome.entry.constraint}`,
    `command: ${outcome.entry.command}`,
    `exit: ${exit}${denied}`,
    `output: ${outcome.outputPreview}`,
    'fix: change the workspace so this command exits 0, or call jspace_charter_amend to replace this entry.',
  ].join('\n')
}

/**
 * Synthesize the Checked `check` line for a passing charter run.
 * @param entries - folded charter.
 * @returns `charter id1,id2,…`.
 */
export function synthesizedCharterCheck(entries: readonly JspaceCharterEntry[]): string {
  const ids = entries.filter(entry => entry.kind === 'check').map(entry => entry.id)
  return `charter ${ids.join(',')}`
}

/**
 * Synthesize the Checked `by` line for a passing charter run.
 * @param count - number of checks run.
 * @returns coverage claim.
 */
export function synthesizedCharterBy(count: number): string {
  return `charter-run of ${String(count)} checks`
}

/**
 * Append `jspace/charter-run` for one nested settle.
 * @param exec - parent execution (owns the session).
 * @param outcome - classified run.
 * @param phase - why it ran.
 */
function logCharterRun(exec: ToolRunContext, outcome: CharterRunOutcome, phase: CharterRunPhase): void {
  const session = exec.agent?.session
  if (session === undefined) return
  session.append('jspace/charter-run', {
    entryId: outcome.entry.id,
    callId: outcome.callId,
    parentCallId: exec.callId,
    phase,
    command: outcome.entry.command,
    passed: outcome.passed,
    outputPreview: outcome.outputPreview,
    ...outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode },
    ...outcome.deniedReason === undefined ? {} : { deniedReason: outcome.deniedReason },
    ...outcome.timedOut === true ? { timedOut: true } : {},
    ...outcome.readsFingerprint.length === 0 ? {} : { readsFingerprint: outcome.readsFingerprint },
  }, { ignorable: true })
}

/**
 * Concatenate text blocks from a tool result.
 * @param result - nested result.
 * @returns joined text.
 */
function textOf(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Clip a preview to {@link CHARTER_OUTPUT_PREVIEW_BYTES} from the tail.
 * @param text - stdout+stderr render.
 * @returns clipped text.
 */
function clipPreview(text: string): string {
  if (text.length <= CHARTER_OUTPUT_PREVIEW_BYTES) return text
  return text.slice(-CHARTER_OUTPUT_PREVIEW_BYTES)
}
