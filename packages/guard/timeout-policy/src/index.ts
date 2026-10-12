/**
 * Cooperative tool-call timeout enforcer. A tool declares `timeoutMs` and
 * promises to honor `exec.signal`; this wrapper arms that deadline and maps its
 * own expiry to `TOOL_TIMEOUT` without racing or abandoning the tool promise.
 * A deployment may add `defaultTimeoutMs` to cover the tools that declare
 * none.
 *
 * FIXME: settle the intended `@shres-code/shres-code-timeout-guard` rename before the
 * first tagged release — suggestion only, aligning the name with its `guard/`
 * home; decide at resolution time
 *
 * @module @shres-code/shres-code-tool-call-timeout-policy
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { deadline, timeoutOf } from '@shres-code/shres-code-timeout'
import type { ToolExecutionResult } from '@shres-code/shres-code-tools'

/**
 * The code owned by this plugin, used BOTH as the internal {@link deadline}
 * classification code AND as the structured error `code` on the replacement
 * tool result. Scoping {@link timeoutOf} to it keeps a nested outer deadline
 * (another `tools/execute` wrapper's timer that fired first) from being misread
 * as this plugin's own timeout — it reads as an ordinary upstream cancel.
 */
export const TOOL_TIMEOUT = 'TOOL_TIMEOUT'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'timeout-policy'

/** The tool registry service this plugin wraps (`tools/execute`) and reads (`get`). */
export const inject = ['tools']

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time check in `apply` (misconfiguration fails loud: a non-integer or
 * non-positive `defaultTimeoutMs` throws at plugin load, never a silent
 * fall-back).
 */
export interface Config {
  /**
   * Deadline armed for a tool whose `ToolDefinition` declares no `timeoutMs`.
   * Absent by default, which leaves undeclared tools with no deadline. A
   * tool's own declaration always wins, in either direction: this is a floor
   * for the unstated, never a ceiling over the stated.
   */
  defaultTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  defaultTimeoutMs: z.number(),
})

/**
 * The structured result substituted when this plugin's deadline wins. `content`
 * is the model-facing message; `error.code` is the same {@link TOOL_TIMEOUT}
 * this plugin owns, so a retry/sandbox plugin (and replay) can route on it.
 *
 * @param timeoutMs - the elapsed budget, rendered into the model-facing message.
 * @returns the `isError` {@link ToolExecutionResult} with a `TOOL_TIMEOUT` error.
 */
function toolTimeoutResult(timeoutMs: number): ToolExecutionResult {
  const message = `tool call timed out after ${timeoutMs}ms`
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, info: { name: 'ToolTimeoutError', code: TOOL_TIMEOUT } },
  }
}

/**
 * Resolve the budget for one dispatch. The tool's own declaration wins in
 * either direction: the configured fallback is a floor for tools that state
 * nothing, never a ceiling over a tool that states its own.
 * @param declared - `ToolDefinition.timeoutMs` for the dispatched tool, when it declares one.
 * @param fallback - the deployment's `defaultTimeoutMs`, when configured.
 * @returns the deadline to arm, or `undefined` when this call gets none.
 */
function resolveTimeoutMs(declared: number | undefined, fallback: number | undefined): number | undefined {
  return declared ?? fallback
}

/**
 * Validate `defaultTimeoutMs` per the fail-loud contract.
 * @param value - the configured fallback, or `undefined` when unset.
 * @returns the fallback unchanged.
 * @throws when the value is present but not a positive integer.
 */
function validateDefaultTimeoutMs(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw new Error(`timeout-policy: invalid defaultTimeoutMs ${value} — must be an integer >= 1`)
  }
  return value
}

/**
 * Register the timeout wrapper. It resolves the caller-visible tool definition,
 * temporarily replaces `exec.signal`, delegates, restores the upstream signal,
 * and replaces the result only when this wrapper's own timer fired.
 * @param ctx - plugin context; the listener is scoped to it and disposed with it.
 * @param config - validated {@link Config}; `defaultTimeoutMs` is re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  const defaultTimeoutMs = validateDefaultTimeoutMs(config.defaultTimeoutMs)

  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const timeoutMs = resolveTimeoutMs(ctx.tools.get(exec.name, exec.agent)?.timeoutMs, defaultTimeoutMs)
    // No declared budget and no configured fallback: no deadline, delegate unchanged.
    if (timeoutMs === undefined) return next()

    using d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)
    // Swap the derived deadline onto exec for dispatch, then restore the
    // caller's own signal so post-execute listeners never see this plugin's
    // (possibly already-aborted) timeout signal.
    const upstream = exec.signal
    exec.signal = d.signal
    try {
      const result = await next()
      // If OUR timer fired (scoped by code — a nested outer deadline reads as
      // undefined here), the tool/capability saw the abort and reached
      // quiescence; replace whatever it returned (its own abort result) with the
      // structured TOOL_TIMEOUT the model sees.
      if (timeoutOf(d.signal, TOOL_TIMEOUT) !== undefined) {
        return toolTimeoutResult(timeoutMs)
      }
      return result
    } finally {
      exec.signal = upstream
    }
  })
}
