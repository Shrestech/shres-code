/**
 * Agent-scoped model selection shared by runtime entry points.
 *
 * Every root agent carries exactly one model-selection hook: a pair of
 * agent-scoped listeners on `system-prompt/assemble` and `agent/request`
 * that apply the agent's manual selection and then consult a composed
 * `ctx.modelRouting`. The agent registry installs it before it announces the
 * agent, so the consult reaches every root agent whichever front end created
 * it. Front ends own only the manual selection the hook applies, which they
 * provide with {@link provideModelSelection}. When routing runs a route other
 * than the manual one, the hook records the manual route beneath it as
 * `agent/route-base`, which {@link manualBaseOfLastHeader} reads back.
 *
 * @module @shres-code/shres-code-agent/model-selection
 */

import { ReasoningEffortId } from '@shres-code/shres-code-llm'
import type { LlmCallConfig } from '@shres-code/shres-code-llm'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
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

/** The provider/model/effort route of a request config or selection, as a detached selection. */
function routeOf(fields: Pick<LlmCallConfig, 'provider' | 'model' | 'reasoningEffort'>): ModelSelection {
  return {
    provider: fields.provider,
    model: fields.model,
    ...fields.reasoningEffort === undefined ? {} : { reasoningEffort: fields.reasoningEffort },
  }
}

/**
 * Whether a request config runs a route: the same provider and model, and the
 * same effort only when the route names one, because a request's effort may be
 * an adapter default the route never chose.
 */
function runsRoute(route: ModelSelection, config: Pick<LlmCallConfig, 'provider' | 'model' | 'reasoningEffort'>): boolean {
  return route.provider === config.provider && route.model === config.model
    && (route.reasoningEffort === undefined || route.reasoningEffort === config.reasoningEffort)
}

/**
 * Validate the owned payload when restoring a selection from durable history.
 * @param value - the durable payload.
 * @param label - the event and field named in a rejection.
 */
function restoredSelection(value: unknown, label: string): ModelSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} data must be an object`)
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'provider' && key !== 'model' && key !== 'reasoningEffort') {
      throw new Error(`${label} has an unknown field: ${key}`)
    }
  }
  if (typeof record['provider'] !== 'string' || record['provider'].trim().length === 0) {
    throw new Error(`${label} provider must be a nonempty string`)
  }
  if (typeof record['model'] !== 'string' || record['model'].trim().length === 0) {
    throw new Error(`${label} model must be a nonempty string`)
  }
  const effort = record['reasoningEffort']
  if (effort !== undefined && (typeof effort !== 'string' || effort.trim().length === 0)) {
    throw new Error(`${label} reasoningEffort must be a nonempty string when present`)
  }
  return {
    provider: record['provider'],
    model: record['model'],
    ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
  }
}

/** One `agent/route-base` record, validated. */
interface RouteBase {
  /** The manual route the request was routed from. */
  readonly manual: ModelSelection
  /** The route the request ran. */
  readonly routed: ModelSelection
}

/** Validate the owned `agent/route-base` payload when reading it from durable history. */
function restoredRouteBase(value: unknown): RouteBase {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('agent/route-base data must be an object')
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'manual' && key !== 'routed') throw new Error(`agent/route-base has an unknown field: ${key}`)
  }
  return {
    manual: restoredSelection(record['manual'], 'agent/route-base manual'),
    routed: restoredSelection(record['routed'], 'agent/route-base routed'),
  }
}

/**
 * The `agent/route-base` a request header running `target` reads: the latest
 * record at or before `end` whose `routed` route `target` runs, searched back
 * past request headers that run `target` and no further than the first header
 * that does not.
 * @param events - the session log.
 * @param end - the index the search starts at, inclusive.
 * @param target - the route of the header the record would describe.
 * @returns the record, or `undefined` when none precedes a header on another route.
 */
function routeBaseBefore(
  events: readonly SessionEvent[],
  end: number,
  target: Pick<LlmCallConfig, 'provider' | 'model' | 'reasoningEffort'>,
): RouteBase | undefined {
  const route = routeOf(target)
  for (let index = end; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'request/header') {
      if (!runsRoute(route, event.data.header.config)) return undefined
    } else if (event?.type === 'agent/route-base') {
      const record = restoredRouteBase(event.data)
      if (runsRoute(record.routed, target)) return record
    }
  }
  return undefined
}

/**
 * The manual route beneath the last logged request header, as the
 * model-selection hook recorded it in `agent/route-base`.
 *
 * The record read is the latest one logged since the last header on another
 * route whose `routed` route the last header runs: the same provider and model,
 * and the same effort only when the record names one, because a header's
 * effort may be an adapter default. A record that no header runs, left by a
 * request that was aborted or failed after the append, is never read. This
 * reads only the log, so it works with no router composed.
 * @param events - the session log to read.
 * @returns the recorded manual route; `undefined` when the last header runs
 *   the manual route, when no header is logged, or when the log predates the
 *   event.
 * @throws when the record read has invalid fields.
 */
export function manualBaseOfLastHeader(events: readonly SessionEvent[]): ModelSelection | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'request/header') return routeBaseBefore(events, index - 1, event.data.header.config)?.manual
  }
  return undefined
}

/**
 * Record the manual route beneath a routed request, unless the record a header
 * running `routed` would read already names the same two routes, as it does
 * for every held step after a streak's first request.
 */
function recordRouteBase(session: Session, manual: ModelSelection, routed: ModelSelection): void {
  const recorded = routeBaseBefore(session.events, session.events.length - 1, routed)
  if (recorded !== undefined && sameRoute(recorded.manual, manual) && sameRoute(recorded.routed, routed)) return
  session.append('agent/route-base', { manual: routeOf(manual), routed: routeOf(routed) })
}

/**
 * The model selection in force on one live Agent: the session's own selection,
 * which routing descends beneath rather than rewrites.
 *
 * An explicit `agent/model-selection` takes priority over routing and request
 * headers. Without one, a composed `ctx.modelRouting` reports the streak's
 * entry route, then the manual route recorded beneath the last header
 * ({@link manualBaseOfLastHeader}) applies, and only then the last header, which
 * a log written before that record existed can leave on a routed candidate.
 * The caller's default stays the caller's: an entry point that owns one
 * applies it on `undefined`.
 * @param agent - the agent whose selection is read.
 * @returns the selection in force, or `undefined` when the log records none.
 * @throws when the latest durable explicit selection or the route-base record
 *   read has invalid fields.
 */
export function selectionInForce(agent: Agent): ModelSelection | undefined {
  const events = agent.session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'agent/model-selection') return restoredSelection(event.data, 'agent/model-selection')
  }
  const routing = agent.ctx.get('modelRouting') as ModelRoutingConsult | undefined
  const base = routing?.stickySelection(agent) ?? manualBaseOfLastHeader(events)
  if (base !== undefined) return base
  const logged = agent.session.requestHeader()?.config
  return logged === undefined ? undefined : routeOf(logged)
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
 * front end that owns the agent's selection calls this once per agent and
 * registers the returned withdrawal as an effect of its own fiber, so a
 * reloaded provider leaves the slot empty for its replacement. The hook reads
 * the reference at every step, so the call may come before or after the hook
 * is installed; while the slot is empty the hook uses the manual route of an
 * agent with no provided selection. An agent the registry did not install the
 * hook for, such as a delegated child, gets it here.
 * @param agent - the agent whose selection the caller owns.
 * @param selection - mutable selection owned by the calling entry point.
 * @returns Withdrawal that empties the slot while it still holds this
 *   selection; it leaves the hook installed.
 * @throws Error when another selection is currently provided for the agent:
 *   two owners of one agent's selection would disagree about its route.
 */
export function provideModelSelection(agent: Agent, selection: ModelSelectionRef): () => void {
  const slot = slotOf(agent)
  if (slot.selection !== undefined && slot.selection !== selection) {
    throw new Error(`agent "${agent.id}" already has a model selection provider`)
  }
  slot.selection = selection
  if (slot.dispose === undefined) installModelSelection(agent)
  return () => {
    if (slot.selection === selection) slot.selection = undefined
  }
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
 * ({@link ModelRoutingConsult.stickySelection}), else the one the hook recorded
 * beneath the last header ({@link manualBaseOfLastHeader}), else the request's
 * resolved route; the hook rewrites the request only when the manual route
 * differs from the resolved one in provider, model, or effort, and applies it
 * as a selection does, so an absent effort clears the one the header carried.
 * After its first request a loop instance seeds each request from the last
 * logged header, so this is what returns a downgraded agent to its manual
 * route, including an agent whose router was removed after it routed a
 * request. A log written before the `agent/route-base` record existed has no
 * record to read, so with no router composed such a header stays in force
 * until a front end provides a selection.
 *
 * When the router runs a route that differs from the manual route in provider,
 * model, or effort, the hook appends `agent/route-base { manual, routed }` to
 * the session before the request's `request/header` is logged, after checking
 * the request's abort signal. It skips the append when the record a header on
 * the routed route would read already names the same two routes, so a held
 * streak records it once. No router, a router that keeps the manual route, and
 * a routed route equal to the manual one append nothing.
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
      const resolvedRoute = routeOf(resolved)
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
        // the manual route is the one a composed router reports beneath it, or
        // the one this hook recorded beneath it when no router reports one.
        const base = routing?.stickySelection(payload.agent) ?? manualBaseOfLastHeader(payload.agent.session.events)
        manual = base ?? resolvedRoute
        applied = base === undefined || sameRoute(base, resolvedRoute) ? resolved : applySelection(resolved, base)
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
      if (routed === undefined) return applied
      if (!sameRoute(routed, manual)) {
        payload.signal.throwIfAborted()
        recordRouteBase(payload.agent.session, manual, routed)
      }
      return applySelection(applied, routed)
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
