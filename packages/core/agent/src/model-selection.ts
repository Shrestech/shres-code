/**
 * Agent-scoped model selection shared by runtime entry points.
 *
 * Every root agent carries exactly one model-selection hook: a pair of
 * agent-scoped listeners on `system-prompt/assemble` and `agent/request`
 * that apply the agent's manual selection and then consult a composed
 * `ctx.modelRouting`. The agent registry installs it before it announces the
 * agent, so the consult reaches every root agent whichever front end created
 * it. Front ends own only the manual selection the hook applies, which they
 * provide with {@link provideModelSelection}.
 *
 * @module @shres-code/shres-code-agent/model-selection
 */

import { ReasoningEffortId } from '@shres-code/shres-code-llm'
import type { LlmCallConfig } from '@shres-code/shres-code-llm'
import type { Agent, AgentRequestContent } from './runtime-types.ts'

/** Immutable request facts a routing consult may inspect after config assembly. */
export interface ModelRoutingRequest {
  /** Config after downstream request listeners and manual selection are applied. */
  readonly config: LlmCallConfig
  /** The detached model content assembled for this request. */
  readonly content: AgentRequestContent
}

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
   * Resolve the route one request should run.
   * @param agent - the agent whose turn is being prepared.
   * @param turn - the turn number, as the loop dispatched it.
   * @param step - the step number within that turn.
   * @param base - the route the manual selection left in force.
   * @param signal - the request's cancellation signal.
   * @param request - the resolved manual config and detached assembled content.
   * @returns the route to run, or `undefined` to keep the manual route.
   */
  resolveRequest(
    agent: Agent,
    turn: number,
    step: number,
    base: ModelSelection,
    signal: AbortSignal,
    request: ModelRoutingRequest,
  ): Promise<ModelSelection | undefined>

  /**
   * Report the selection a held downgrade descends beneath.
   *
   * A held streak rewrites the consumed `request/header` to the candidate, so
   * the last logged header no longer reports the route the session is pointed
   * at; a reader that reports that route asks this first. Reporting is its only
   * purpose — the routing gate keeps its own provider/model comparison — and the
   * answer is the router's own fold, never a mirrored copy.
   * @param agent - the agent whose selection is being read.
   * @returns the manual route behind an active streak or the last routed header
   *   awaiting replacement; `undefined` when the logged header is already manual.
   */
  stickySelection(agent: Agent): ModelSelection | undefined
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

/** Whether two selections name the same provider, model, and effort. */
function sameRoute(left: ModelSelection, right: ModelSelection): boolean {
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}

/** Validate the owned payload when restoring a selection from durable history. */
function restoredSelection(value: unknown): ModelSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('agent/model-selection data must be an object')
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'provider' && key !== 'model' && key !== 'reasoningEffort') {
      throw new Error(`agent/model-selection has an unknown field: ${key}`)
    }
  }
  if (typeof record['provider'] !== 'string' || record['provider'].trim().length === 0) {
    throw new Error('agent/model-selection provider must be a nonempty string')
  }
  if (typeof record['model'] !== 'string' || record['model'].trim().length === 0) {
    throw new Error('agent/model-selection model must be a nonempty string')
  }
  const effort = record['reasoningEffort']
  if (effort !== undefined && (typeof effort !== 'string' || effort.trim().length === 0)) {
    throw new Error('agent/model-selection reasoningEffort must be a nonempty string when present')
  }
  return {
    provider: record['provider'],
    model: record['model'],
    ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
  }
}

/**
 * The model selection in force on one live Agent: the session's own selection,
 * which routing descends beneath rather than rewrites.
 *
 * An explicit `agent/model-selection` takes priority over routing and request
 * headers. Without one, a composed `ctx.modelRouting` reports the streak's
 * entry route before the last header, which can carry a routed candidate. The
 * caller's default stays the caller's: an entry point that owns one applies it
 * on `undefined`.
 * @param agent - the agent whose selection is read.
 * @returns the selection in force, or `undefined` when the log records none.
 * @throws when the latest durable explicit selection has invalid fields.
 */
export function selectionInForce(agent: Agent): ModelSelection | undefined {
  const events = agent.session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'agent/model-selection') return restoredSelection(event.data)
  }
  const routing = agent.ctx.get('modelRouting') as ModelRoutingConsult | undefined
  const sticky = routing?.stickySelection(agent)
  if (sticky !== undefined) return sticky
  const logged = agent.session.requestHeader()?.config
  if (logged === undefined) return undefined
  return {
    provider: logged.provider,
    model: logged.model,
    ...logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort },
  }
}

/** One agent's model-selection hook and the manual selection it applies. */
interface ModelSelectionSlot {
  /** The manual selection a front end provided; absent while none has. */
  selection: ModelSelectionRef | undefined
  /** Disposer of the installed hook; absent until it is installed. */
  dispose: (() => void) | undefined
}

/** Hook state per live agent. */
const slots = new WeakMap<Agent, ModelSelectionSlot>()

/** The slot of one agent, created empty on first use. */
function slotOf(agent: Agent): ModelSelectionSlot {
  let slot = slots.get(agent)
  if (slot === undefined) {
    slot = { selection: undefined, dispose: undefined }
    slots.set(agent, slot)
  }
  return slot
}

/**
 * Whether an agent carries its model-selection hook, and so can be routed.
 * @param agent - the agent to check.
 * @returns `true` once {@link installModelSelection} ran for it and until the hook is disposed.
 */
export function modelSelectionInstalled(agent: Agent): boolean {
  return slots.get(agent)?.dispose !== undefined
}

/**
 * Provide the manual selection an agent's model-selection hook applies. A
 * front end that owns the agent's selection calls this once per agent; the
 * hook reads the reference at every step, so the call may come before or
 * after the hook is installed. An agent the registry did not install the hook
 * for, such as a delegated child, gets it here.
 * @param agent - the agent whose selection the caller owns.
 * @param selection - mutable selection owned by the calling entry point.
 * @throws Error when another selection was already provided for the agent:
 *   two owners of one agent's selection would disagree about its route.
 */
export function provideModelSelection(agent: Agent, selection: ModelSelectionRef): void {
  const slot = slotOf(agent)
  if (slot.selection !== undefined && slot.selection !== selection) {
    throw new Error(`agent "${agent.id}" already has a model selection provider`)
  }
  slot.selection = selection
  if (slot.dispose === undefined) installModelSelection(agent)
}

/**
 * Install one agent's model-selection hook: listeners on the agent's scoped
 * `system-prompt/assemble` and `agent/request`. The agent registry installs
 * it for every root agent before announcing it; {@link provideModelSelection}
 * installs it for any other agent it is given. Prompt assembly snapshots the
 * provided selection before delegating, and the request applies that snapshot's
 * provider/model pair and effort, so a concurrent switch takes effect on a later
 * step instead of splitting the two surfaces. An absent selected effort clears
 * any inherited effort, restoring the selected model's provider/default
 * behavior.
 *
 * Without a provided selection the manual route is the one a composed
 * `ctx.modelRouting` reports beneath a routed header
 * ({@link ModelRoutingConsult.stickySelection}), else the request's resolved
 * route; the hook rewrites the request only when the two differ. The loop
 * seeds each request from the last logged header, so this is what returns a
 * downgraded agent to its manual route. With no router composed nothing is
 * rewritten, and a header a router left on a candidate before it was removed
 * stays in force until a front end provides a selection.
 *
 * The manual selection stays authoritative for what it owns: it is what
 * assembly reports, what the request carries when no router is composed, and
 * the base a composed `ctx.modelRouting` consults. When that service resolves a
 * route, **the routing decision wins for this request** — the manual selection
 * remains the fallback it rewrites from and the route a resumed session
 * returns to once routing is off.
 *
 * @param agent - the agent whose scoped context receives the listeners.
 * @returns Disposer for both scoped waterfall listeners.
 * @throws Error when the agent already carries the hook: a second hook would
 *   consult the router twice for each request.
 */
export function installModelSelection(agent: Agent): () => void {
  const slot = slotOf(agent)
  if (slot.dispose !== undefined) throw new Error(`agent "${agent.id}" already has a model selection hook`)
  const agentCtx = agent.ctx
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selection = slot.selection
    const selected = selection?.current
    const assembled = await next()
    if (selection !== undefined) selection.assembled = selected
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
      const resolvedRoute: ModelSelection = {
        provider: resolved.provider,
        model: resolved.model,
        ...resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort },
      }
      // Optional service: a deployment that composes no router keeps the manual
      // route byte-for-byte.
      const routing = agentCtx.get('modelRouting') as ModelRoutingConsult | undefined
      let manual: ModelSelection
      let applied: LlmCallConfig
      if (slot.selection !== undefined) {
        const selected = slot.selection.assembled
        manual = selected ?? resolvedRoute
        applied = selected === undefined ? resolved : applySelection(resolved, selected)
      } else {
        // No front end owns this agent's selection. The request is seeded from
        // the last logged header, which a downgrade leaves on the candidate, so
        // the manual route is the one a composed router reports beneath it.
        const sticky = routing?.stickySelection(payload.agent)
        manual = sticky ?? resolvedRoute
        applied = sticky === undefined || sameRoute(sticky, resolvedRoute) ? resolved : applySelection(resolved, sticky)
      }
      if (routing === undefined) return applied
      const routed = await routing.resolveRequest(
        payload.agent,
        payload.turn,
        payload.step,
        manual,
        payload.signal,
        { config: applied, content: payload.content },
      )
      return routed === undefined ? applied : applySelection(applied, routed)
    },
  )
  const dispose = (): void => {
    disposeAssembly()
    disposeRequest()
    if (slot.dispose === dispose) slot.dispose = undefined
  }
  slot.dispose = dispose
  return dispose
}
