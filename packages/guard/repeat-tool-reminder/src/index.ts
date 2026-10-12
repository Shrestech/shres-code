/**
 * Per-agent repeat-call detector. It enriches post-execute decisions with
 * logged model context, and — only when a deployment opts in with
 * `vetoThreshold` — refuses the call itself past that run length.
 * Configuration and chain semantics live in the package README; rationale

 * @module @shres-code/shres-code-repeat-tool-reminder
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import type { Agent, PreStepDecision } from '@shres-code/shres-code-agent'
import { createUserMessage } from '@shres-code/shres-code-llm'
import type { MessageSource } from '@shres-code/shres-code-llm'
import type { UserMessage } from '@shres-code/shres-code-session'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@shres-code/shres-code-tools'

export const name = 'repeat-tool-reminder'

/**
 * The code this plugin stamps on a vetoed call's structured error, so a
 * retry, metrics, or transcript consumer can route on the refusal instead of
 * matching its prose.
 */
export const REPEAT_TOOL_VETO = 'REPEAT_TOOL_VETO'

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time checks in `apply` (misconfiguration fails loud: an empty
 * `thresholds` list, a non-integer, a value below 2, or a duplicate throws at
 * plugin load, never a silent fall-back). `include`/`exclude` entries are
 * `*`-wildcard predicates over tool names at call time, not references to
 * registry entries — a pattern matching no currently registered tool is valid
 * (`exclude: [mcp_*]` must stay legal in a deployment that loads no MCP tools).
 */
export interface Config {
  /** Consecutive-repeat counts that trigger a reminder (default `[3, 5, 8]`). */
  thresholds?: number[]
  /** Tool-name patterns to track; empty means every tool is tracked. */
  include?: string[]
  /** Tool-name patterns transparent to the chain (neither count nor reset). */
  exclude?: string[]
  /**
   * Maximum characters of canonical arguments quoted in the DETAILED reminder
   * (default 500). Large payloads (a `write` body, a long command) would
   * otherwise ride into the next request unbounded — precisely in a loop
   * scenario; the cap bounds the reminder, never the detection (the chain key
   * always compares the FULL canonical string).
   */
  argumentsPreviewChars?: number
  /**
   * Consecutive-repeat count at which the call is REFUSED instead of merely
   * reminded (default `0` — off, the shipped advisory-only behavior). From
   * this run length on, every further identical call is refused with a
   * structured {@link REPEAT_TOOL_VETO} result and the tool never runs. Fails
   * loud at load unless it is `0` or an integer >= 2.
   */
  vetoThreshold?: number
}

export const Config: z<Config> = z.object({
  thresholds: z.array(z.number()).default([3, 5, 8]),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  argumentsPreviewChars: z.number().default(500),
  vetoThreshold: z.number().default(0),
})

/**
 * The `{kind:'plugin'}` source stamped on every reminder this guard injects —
 * the label is load-bearing (an unlabeled context would render as a user
 * prompt in derived history).
 */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'repeat-tool-reminder' }

/**
 * The gentle first-threshold reminder. Keyed to `thresholds[0]`, not a literal
 * count, so a custom first threshold keeps the gentle-then-detailed escalation.
 */
const GENTLE_REMINDER =
  'You are repeating the exact same tool call with identical arguments. '
  + 'Carefully analyze the previous result before calling again: if the task is '
  + 'not complete, try a different approach or different arguments instead of '
  + 'repeating the call.'

/**
 * The structured result substituted for a vetoed call. `content` is the
 * model-facing refusal: it names the violation, states that repeating will not
 * help, and lists the ways out.
 * @param toolName - the repeated tool.
 * @param count - the run length this attempt reaches.
 * @returns the `isError` {@link ToolExecutionResult} carrying {@link REPEAT_TOOL_VETO}.
 */
function vetoResult(toolName: string, count: number): ToolExecutionResult {
  const message = `refused: ${toolName} has now been called ${count} times in a row with identical arguments`
  return {
    content: [{
      type: 'text',
      text: `Error: ${message} and is not making progress. `
        + 'This exact call will keep being refused. Re-read the last result from '
        + `${toolName}, then call it with different arguments, use a different tool, `
        + 'or finish with what you already know.',
    }],
    isError: true,
    error: { message, info: { name: 'RepeatToolVetoError', code: REPEAT_TOOL_VETO } },
  }
}

/** The detailed later-threshold reminder naming the tool, the run length, and the canonical arguments. */
function detailedReminder(toolName: string, count: number, canonicalArguments: string): string {
  return 'Repeated tool call detected:\n'
    + `- tool: ${toolName}\n`
    + `- consecutive_calls: ${count}\n`
    + `- arguments: ${canonicalArguments}\n`
    + 'The repeated calls are not making progress. Do not call this tool with '
    + 'these exact arguments again. Inspect the latest result and choose a '
    + 'different action, different arguments, or finish the task if enough '
    + 'evidence has been gathered.'
}

/**
 * Deep key-sort of a parsed-JSON value so two argument objects that differ
 * only in property order canonicalize identically. Arguments reach the guard
 * as the loop's `JSON.parse` output (or its raw-string fallback for malformed
 * argument JSON), so JSON's value domain is the whole input domain — no
 * bigint, cycle, or `undefined` handling exists because no input path can
 * produce them.
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key])
    }
    return sorted
  }
  return value
}

/** Canonical string form of a call's arguments: deep key-sort, then stringify. */
function canonicalize(argumentsValue: unknown): string {
  return JSON.stringify(sortJsonValue(argumentsValue))
}

/** Compile one `*`-wildcard pattern to an anchored RegExp (every other regex metacharacter is matched literally). */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/**
 * Head-truncate the canonical arguments for quoting in the detailed reminder,
 * marking how much was omitted. Bounds only the model-visible text — the
 * chain key always uses the full canonical string.
 */
function previewArguments(canonical: string, cap: number): string {
  if (canonical.length <= cap) return canonical
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`
}

/**
 * Validate `vetoThreshold` per the fail-loud contract and resolve the
 * off sentinel away.
 * @param value - the schema-defaulted config value.
 * @returns the run length at which calls are refused, or `undefined` when the veto is off.
 * @throws when the value is neither `0` nor an integer >= 2.
 */
function resolveVetoThreshold(value: number): number | undefined {
  if (value === 0) return undefined
  if (!Number.isInteger(value) || value < 2) {
    throw new Error(`repeat-tool-reminder: invalid vetoThreshold ${value} — must be 0 (off) or an integer >= 2`)
  }
  return value
}

/**
 * Validate `thresholds` per the fail-loud contract and return them sorted
 * ascending (the escalation rule reads `thresholds[0]` as the gentle tier, so
 * order is normalized here, once).
 */
function validateThresholds(values: number[]): number[] {
  if (values.length === 0) {
    throw new Error('repeat-tool-reminder: `thresholds` must not be empty')
  }
  for (const value of values) {
    if (!Number.isInteger(value) || value < 2) {
      throw new Error(`repeat-tool-reminder: invalid threshold ${value} — every threshold must be an integer >= 2`)
    }
  }
  if (new Set(values).size !== values.length) {
    throw new Error('repeat-tool-reminder: `thresholds` must not contain duplicates')
  }
  return [...values].sort((a, b) => a - b)
}

/**
 * Prepend the guard's reminder while preserving every downstream context's
 * source and metadata.
 */
function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
  return [ours, ...theirs ?? []]
}

/** One agent's consecutive-repeat chain: the last tracked call's identity key and its run length. */
interface Chain {
  key: string
  count: number
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; `thresholds` is re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the fields are set after validation.
  const thresholds = validateThresholds(config.thresholds as number[])
  const thresholdSet = new Set(thresholds)
  const includePatterns = (config.include as string[]).map(wildcardToRegExp)
  const excludePatterns = (config.exclude as string[]).map(wildcardToRegExp)
  const argumentsPreviewChars = config.argumentsPreviewChars as number
  if (!Number.isInteger(argumentsPreviewChars) || argumentsPreviewChars < 1) {
    throw new Error(`repeat-tool-reminder: invalid argumentsPreviewChars ${argumentsPreviewChars} — must be an integer >= 1`)
  }
  const vetoThreshold = resolveVetoThreshold(config.vetoThreshold as number)

  const chains = new WeakMap<Agent, Chain>()

  /** Whether a tool participates in the chain (untracked calls are transparent: they neither count nor reset). */
  function tracked(toolName: string): boolean {
    if (includePatterns.length > 0 && !includePatterns.some(pattern => pattern.test(toolName))) return false
    return !excludePatterns.some(pattern => pattern.test(toolName))
  }

  /** The chain identity of one tracked call, or `undefined` when the call is transparent to the chain. */
  function chainKey(exec: ToolExecution): string | undefined {
    // A direct `ctx.tools.execute()` caller has no model to remind and no id
    // to key on; only agent-loop calls participate.
    if (!exec.agent) return undefined
    if (!tracked(exec.name)) return undefined
    return JSON.stringify([exec.name, canonicalize(exec.arguments)])
  }

  /** The run length this attempt reaches, without advancing the chain. */
  function projectedCount(agent: Agent, key: string): number {
    const chain = chains.get(agent)
    return chain !== undefined && chain.key === key ? chain.count + 1 : 1
  }

  /**
   * Advance the calling agent's chain for one attempt and return the reminder
   * to deliver, if this attempt's run length hits a configured threshold.
   * Counting happens here — in post-execute — because denied calls also flow
   * through this waterfall (`ToolRuntime.execute` routes a deny through the
   * same pipeline), and a model hammering a denied call is exactly the loop
   * worth breaking. A call this plugin vetoed reaches post-execute too, so a
   * refused run keeps counting and stays refused.
   */
  function observe(exec: ToolExecution): UserMessage | undefined {
    const key = chainKey(exec)
    if (key === undefined || !exec.agent) return undefined
    const count = projectedCount(exec.agent, key)
    chains.set(exec.agent, { key, count })
    if (!thresholdSet.has(count)) return undefined
    const text = count === thresholds[0]
      ? GENTLE_REMINDER
      : detailedReminder(exec.name, count, previewArguments(canonicalize(exec.arguments), argumentsPreviewChars))
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary: `${exec.name} × ${count}` },
    })
  }

  // The opt-in escalation. It sits on `tools/execute` rather than the
  // `tools/pre-execute` deny gate because a refusal the model can route on
  // needs a structured error `code`, which a deny reason string cannot carry;
  // short-circuiting the dispatch waterfall keeps the tool from running at
  // all. The chain is READ here and still advanced in post-execute, which the
  // refused call also reaches.
  if (vetoThreshold !== undefined) {
    ctx.on('tools/execute', (exec, next): Promise<ToolExecutionResult> => {
      const key = chainKey(exec)
      if (key === undefined || !exec.agent) return next()
      const count = projectedCount(exec.agent, key)
      if (count < vetoThreshold) return next()
      return Promise.resolve(vetoResult(exec.name, count))
    })
  }

  // Observe-and-enrich, never veto: count first (state advances regardless of
  // the downstream outcome), DELEGATE so a later listener can still block or
  // replace, then fold the reminder onto whatever came back — additionalContexts
  // rides both decision variants, so a blocked call still gets the nudge.
  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const reminder = observe(exec)
    const downstream = await next()
    if (!reminder) return downstream
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts: prependContext(reminder, downstream.additionalContexts) }
    }
    return {
      ...downstream,
      additionalContexts: prependContext(reminder, downstream.additionalContexts),
    }
  })

  // A user interjection changes the context; repetition across it is not a
  // loop. Pure reset hook: always delegates (attaching nothing, vetoing
  // nothing).
  ctx.on('agent/pre-step', ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) chains.delete(agent)
    return next()
  })
}
