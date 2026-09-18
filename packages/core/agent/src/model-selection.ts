/**
 * Agent-scoped model selection shared by runtime entry points.
 * @module @shres-code/shres-code-agent/model-selection
 */

import type { Context } from '@shres-code/cordis'
import type { LlmCallConfig, ReasoningEffortId } from '@shres-code/shres-code-llm'
import type { Agent } from './runtime-types.ts'

/** Complete provider, model, and optional reasoning effort selected for one live Agent. */
export interface ModelSelection {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: ReasoningEffortId
}

/** Mutable model selection plus the value captured for the current step. */
export interface ModelSelectionRef {
  /** Model selected for the next step that enters prompt assembly. */
  current: ModelSelection | undefined
  /** Selection captured when the current step entered prompt assembly. */
  assembled: ModelSelection | undefined
}

/**
 * The optional routing consult reached through `ctx.get('modelRouting')`.
 *
 * Declared structurally rather than imported: the router is a plugin above this
 * package, and this package owns the request rewrite the consult has to fit. A
 * provider of the service satisfies this signature by construction — the router
 * package asserts conformance in its own compilation — and a deployment that
 * composes no router never reaches it.
 */
export interface ModelRoutingConsult {
  /**
   * Resolve the route one turn should run.
   * @param agent - the agent whose turn is being prepared.
   * @param turn - the turn number, as the loop dispatched it.
   * @param step - the step number within that turn.
   * @param base - the route the manual selection left in force.
   * @param signal - the request's cancellation signal.
   * @returns the route to run, or `undefined` to keep the manual route.
   */
  resolveRequest(
    agent: Agent,
    turn: number,
    step: number,
    base: ModelSelection,
    signal: AbortSignal,
  ): Promise<ModelSelection | undefined>
}

/**
 * Apply one selection to a request config, clearing any inherited effort first
 * so an absent selected effort restores the selected model's provider/default
 * behavior instead of keeping the previous route's.
 * @param config - the request config to rewrite.
 * @param selection - the provider/model/effort to apply.
 * @returns the rewritten config.
 */
function applySelection(config: LlmCallConfig, selection: ModelSelection): LlmCallConfig {
  const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = config
  return {
    ...withoutInheritedEffort,
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selection.reasoningEffort },
  }
}

/**
 * Couple one mutable selection to Agent-scoped prompt assembly and request
 * routing. Prompt assembly snapshots the selected model before delegating, then
 * applies its provider/model pair and effort to request config so a
 * concurrent switch takes effect on a later step instead of splitting the two
 * surfaces. An absent selected effort clears any inherited effort, restoring
 * the selected model's provider/default behavior.
 *
 * The manual selection stays authoritative for what it owns: it is what
 * assembly reports, what the request carries when no router is composed, and
 * the base a composed `ctx.modelRouting` consults. When that service resolves a
 * route, **the routing decision wins for this request** — the manual selection
 * remains the fallback it rewrites from and the route a resumed session
 * returns to once routing is off.
 *
 * @param agentCtx - The selected Agent's scoped context.
 * @param selection - Mutable selection owned by the calling entry point.
 * @returns Disposer for both scoped waterfall listeners.
 */
export function installModelSelection(agentCtx: Context, selection: ModelSelectionRef): () => void {
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    const assembled = await next()
    selection.assembled = selected
    if (selected === undefined) return assembled
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: selected.provider,
        model: selected.model,
      },
    }
  })
  const disposeRequest = agentCtx.on(
    'agent/request',
    async (payload, next): Promise<LlmCallConfig> => {
      const resolved = await next()
      const selected = selection.assembled
      const manual: ModelSelection = selected ?? {
        provider: resolved.provider,
        model: resolved.model,
        ...resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort },
      }
      const applied = selected === undefined ? resolved : applySelection(resolved, selected)
      // Optional service: a deployment that composes no router keeps the manual
      // route byte-for-byte.
      const routing = agentCtx.get('modelRouting') as ModelRoutingConsult | undefined
      if (routing === undefined) return applied
      const routed = await routing.resolveRequest(payload.agent, payload.turn, payload.step, manual, payload.signal)
      return routed === undefined ? applied : applySelection(applied, routed)
    },
  )
  return () => {
    disposeAssembly()
    disposeRequest()
  }
}
