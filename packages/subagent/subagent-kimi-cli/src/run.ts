/**
 * One-shot Kimi Code CLI child: spawn `kimi -p` through the subprocess seam,
 * parse stream-json, and dispose to whole-tree quiescence.
 *
 * @module @roos-code/roos-code-subagent-kimi-cli/run
 */

import { randomUUID } from 'node:crypto'
import type { ContentBlock } from '@roos-code/roos-code-llm'
import { SessionId } from '@roos-code/roos-code-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@roos-code/roos-code-subagent'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@roos-code/roos-code-subprocess'
import { parseKimiStreamJson } from './parse.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** In-memory stdout cap for one Kimi stream-json transcript. */
export const STDOUT_COLLECT_MAX_BYTES = 8_000_000

/** Default executable name resolved from PATH when config omits `executable`. */
export const DEFAULT_EXECUTABLE = 'kimi'

/** Fully resolved inputs for one Kimi Code CLI headless run. */
export interface KimiCliRunSpec {
  /** Parent Session workspace supplied as the child cwd. */
  readonly cwd: string
  /** Exact `kimi` executable, or a test override. */
  readonly executable: string
  /** Explicit deployment/test environment layered after the shared scrub. */
  readonly env: Record<string, string>
  /** Subprocess termination grace passed to the shared process-tree owner. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

/**
 * Validate and preserve the one-shot task before crossing the process boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact joined non-empty text.
 */
export function textTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) {
    throw new Error('subagent-kimi-cli: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-kimi-cli: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-kimi-cli: the one-shot task must not be empty')
  }
  return texts.join('')
}

/**
 * Fixed headless argv for one Kimi Code CLI run.
 * @param executable - resolved `kimi` path or name.
 * @param prompt - the one-shot task text.
 * @returns argv starting with the executable.
 */
export function kimiHeadlessArgv(executable: string, prompt: string): string[] {
  return [
    executable,
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--yolo',
  ]
}

/**
 * Close stdin, terminate the managed process tree, and wait for exit.
 * @param child - shared-service handle that owns the process tree.
 */
export async function disposeKimiChild(child: SubprocessHandle): Promise<void> {
  if (child.pid <= 0) {
    await child.done.catch(() => {})
    return
  }
  child.terminate()
  await child.waitForExit()
  await child.done
}

/**
 * Start the real `kimi -p` child and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, environment, process service, and diagnostic policy.
 * @returns the published run after spawn.
 */
export async function startKimiCliRun(
  request: SubagentStartRequest,
  spec: KimiCliRunSpec,
): Promise<SubagentRun> {
  const prompt = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-kimi-cli: request was aborted before Kimi CLI startup')
  }

  const child = spec.spawn({
    argv: kimiHeadlessArgv(spec.executable, prompt),
    cwd: spec.cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: STDOUT_COLLECT_MAX_BYTES },
      stderr: 'inherit',
    },
    graceMs: spec.disposeGraceMs,
    env: spec.env,
    signal: request.signal,
  })

  const disposeProcess = (): Promise<void> => disposeKimiChild(child)
  const runAbort = new AbortController()
  const requestCancel = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-kimi-cli: run cancelled locally'))
    child.terminate()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  const collectOutput = (): ContentBlock[] => {
    const text = child.collected.stdout?.readFrom(0).text ?? ''
    return text.length === 0 ? [] : [{ type: 'text', text }]
  }

  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async () => {
      const outcome = await child.done
      if (runAbort.signal.aborted) {
        throw new Error('subagent-kimi-cli: run cancelled locally')
      }
      if (outcome.exitCode !== 0) {
        throw new Error(
          `subagent-kimi-cli: Kimi CLI exited with code ${String(outcome.exitCode)}`
          + ` signal ${String(outcome.signal)}`,
        )
      }
      const stdout = child.collected.stdout?.readFrom(0).text ?? ''
      return {
        output: [{ type: 'text', text: parseKimiStreamJson(stdout) }],
        stopReason: 'completed',
      }
    },
    collectOutput,
    cancelled: () => runAbort.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: SessionId(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: disposeProcess,
  })
}
