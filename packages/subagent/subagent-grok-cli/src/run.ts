/**
 * One-shot Grok Build child: spawn `grok -p` through the subprocess seam,
 * parse one JSON object, and dispose to whole-tree quiescence.
 *
 * @module @roos-code/roos-code-subagent-grok-cli/run
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
import { parseGrokJson } from './parse.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** In-memory stdout cap for one Grok JSON object. */
export const STDOUT_COLLECT_MAX_BYTES = 8_000_000

/** Default executable name resolved from PATH when config omits `executable`. */
export const DEFAULT_EXECUTABLE = 'grok'

/** Fully resolved inputs for one Grok Build headless run. */
export interface GrokCliRunSpec {
  /** Parent Session workspace supplied as the child cwd. */
  readonly cwd: string
  /** Exact `grok` executable, or a test override. */
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
    throw new Error('subagent-grok-cli: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-grok-cli: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-grok-cli: the one-shot task must not be empty')
  }
  return texts.join('')
}

/**
 * Fixed headless argv for one Grok Build run.
 * @param executable - resolved `grok` path or name.
 * @param prompt - the one-shot task text.
 * @returns argv starting with the executable.
 */
export function grokHeadlessArgv(executable: string, prompt: string): string[] {
  return [
    executable,
    '-p',
    prompt,
    '--output-format',
    'json',
    '--always-approve',
    '--no-auto-update',
  ]
}

/**
 * Close stdin, terminate the managed process tree, and wait for exit.
 * @param child - shared-service handle that owns the process tree.
 */
export async function disposeGrokChild(child: SubprocessHandle): Promise<void> {
  if (child.pid <= 0) {
    await child.done.catch(function alreadySettledOrKilled() {
      // Teardown after the owner already settled or killed the child.
    })
    return
  }
  child.terminate()
  await child.waitForExit()
  await child.done
}

/**
 * Start the real `grok -p` child and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, environment, process service, and diagnostic policy.
 * @returns the published run after spawn.
 */
export async function startGrokCliRun(
  request: SubagentStartRequest,
  spec: GrokCliRunSpec,
): Promise<SubagentRun> {
  const prompt = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-grok-cli: request was aborted before Grok Build startup')
  }

  const child = spec.spawn({
    argv: grokHeadlessArgv(spec.executable, prompt),
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

  const disposeProcess = (): Promise<void> => disposeGrokChild(child)
  const runAbort = new AbortController()
  const requestCancel = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-grok-cli: run cancelled locally'))
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
        throw new Error('subagent-grok-cli: run cancelled locally')
      }
      if (outcome.exitCode !== 0) {
        throw new Error(
          `subagent-grok-cli: Grok Build exited with code ${String(outcome.exitCode)}`
          + ` signal ${String(outcome.signal)}`,
        )
      }
      const stdout = child.collected.stdout?.readFrom(0).text ?? ''
      return {
        output: [{ type: 'text', text: parseGrokJson(stdout) }],
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
