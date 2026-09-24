/**
 * Shared in-process child composition: the delegation-depth budget, the
 * durable session metadata, the resolved child `AgentOptions`, the delegated
 * policy seed, and the scoped setup a child agent needs. Both the one-shot
 * provider driver and the continuation manager compose children this way, so
 * depth accounting, lineage stamping, and delegation policy have one home.
 *
 * @module @shres-code/shres-code-subagent/child-agent
 */

import type { Context } from '@shres-code/cordis'
import { selectionInForce } from '@shres-code/shres-code-agent'
import type { Agent, AgentOptions, CreateAgentOptions } from '@shres-code/shres-code-agent'
import type { SandboxMode } from '@shres-code/shres-code-sandbox'
import type { Session, SessionId } from '@shres-code/shres-code-session'
import type { ToolRestriction } from '@shres-code/shres-code-tools'
// Type-only: make `ctx.get('sandboxPolicy')` / `ctx.get('approval')` resolve
// to the policy services when composed — delegation consumes both
// opportunistically (the documented `ctx.get` pattern), never as a hard dep —
// and merge the `sandbox/mode` / `approval/policy` session-event payloads.
import type {} from '@shres-code/shres-code-sandbox-policy'
import type {} from '@shres-code/shres-code-user-approval'
// Type-only: make `ctx.get('agentPresets')` resolve to the preset roster when
// composed — a child inherits its parent's composition opportunistically (the
// documented `ctx.get` pattern), never as a hard dep. A rosterless deployment
// keeps its model-facing rows on the host plane, where the child already sees
// them through the tool registry's global layer.
import type {} from '@shres-code/shres-code-agent-presets'
// Type-only: make `ctx.get('agentDefaultModel')` resolve to the default-model
// service when composed — child route inheritance reads the parent's MANUAL
// selection (selection in force, else the live default) instead of the
// parent's creation-time AgentOptions, so a parent that switched models does
// not silently misroute every later child onto its original route. Opportunistic
// (the documented `ctx.get` pattern), never a hard dep; the read is
// non-installing, so it never attaches selection listeners to the parent.
import type {} from '@shres-code/shres-code-agent-default-model'
import type {} from '@shres-code/shres-code-system-prompt'
import { delegationDepthOf } from './depth.ts'
import { assertUsableCwd } from './out-of-process.ts'

/** Thrown when starting a child would exceed the requested depth cap. */
export class SubagentDepthError extends Error {
  constructor(public readonly attemptedDepth: number, public readonly maxDepth: number) {
    super(`subagent depth ${attemptedDepth} exceeds maxDepth ${maxDepth}`)
    this.name = 'SubagentDepthError'
  }
}

/**
 * Resolve the child's delegation depth from its parent and enforce an optional
 * cap. The persisted parent header is the monotone floor, so a resumed parent
 * cannot delegate as if it were top-level.
 * @param parent - the delegating parent agent.
 * @param maxDepth - optional absolute cap the resolved depth must not exceed.
 * @returns the child's non-negative safe-integer depth.
 * @throws {SubagentDepthError} when the resolved depth exceeds `maxDepth`.
 * @throws {RangeError} when the resolved depth leaves the safe-integer range.
 */
export function resolveChildDepth(parent: Agent, maxDepth: number | undefined): number {
  const childDepth = delegationDepthOf(parent) + 1
  if (!Number.isSafeInteger(childDepth)) {
    throw new RangeError('subagent child depth exceeds the safe-integer range')
  }
  if (maxDepth !== undefined && childDepth > maxDepth) {
    throw new SubagentDepthError(childDepth, maxDepth)
  }
  return childDepth
}

/**
 * An Agent's manual provider/model route, read without side effects: the
 * model selection in force on it (`selectionInForce`), else the live
 * default-model selection when that service is composed, else its
 * creation-time options. This is the route a delegating parent passes to new
 * children and the route the Team roster reports for the Lead. The selection
 * in force is the explicit `agent/model-selection`, else the manual base a
 * composed router reports beneath a routed request header, else that logged
 * header. It is therefore never a routed candidate: while a downgrade is held,
 * the header carries the candidate, and a child that inherited it would run
 * the cheaper route with no routing decision of its own.
 * @param agent - the loaded Agent to read.
 * @returns the known route fields.
 * @throws when the Agent's latest durable explicit selection has invalid fields.
 */
export function effectiveAgentRoute(agent: Agent): { provider?: string; model?: string } {
  const selected = selectionInForce(agent)
  if (selected !== undefined) {
    return { provider: selected.provider, model: selected.model }
  }
  const defaults = agent.ctx.get('agentDefaultModel')
  if (defaults !== undefined) {
    const picked = defaults.currentSelection()
    return { provider: picked.provider, model: picked.model }
  }
  return {
    ...agent.options.provider !== undefined ? { provider: agent.options.provider } : {},
    ...agent.options.model !== undefined ? { model: agent.options.model } : {},
  }
}

/**
 * The provider/model route a child of this parent would run: the parent's
 * manual route ({@link effectiveAgentRoute}) with any per-child request
 * overrides applied. Option
 * resolution and the model-facing spawn telemetry both read this, so the
 * logged route and the run route cannot drift.
 * @param parent - the delegating parent whose route the child inherits.
 * @param requested - per-child overrides, if any.
 * @returns the resolved route fields that are known.
 */
export function effectiveChildRoute(
  parent: Agent,
  requested: AgentOptions | undefined,
): { provider?: string; model?: string } {
  return {
    ...effectiveAgentRoute(parent),
    ...requested?.provider !== undefined ? { provider: requested.provider } : {},
    ...requested?.model !== undefined ? { model: requested.model } : {},
  }
}

/**
 * Resolve the child's `AgentOptions`: the parent's manual provider/model
 * route (selection in force, else live default, else creation options) and the
 * parent's maxTokens unless the request overrides them, stamped with the
 * child's own delegation depth.
 * @param parent - the delegating parent whose route the child inherits.
 * @param requested - per-child overrides, if any.
 * @param childDepth - the resolved delegation depth to stamp.
 * @returns the resolved options for `ctx.agents.create()`.
 */
export function resolveChildAgentOptions(
  parent: Agent,
  requested: AgentOptions | undefined,
  childDepth: number,
): AgentOptions {
  const route = effectiveChildRoute(parent, requested)
  const parentMaxTokens = parent.options.maxTokens
  return {
    ...route.provider !== undefined ? { provider: route.provider } : {},
    ...route.model !== undefined ? { model: route.model } : {},
    ...parentMaxTokens !== undefined ? { maxTokens: parentMaxTokens } : {},
    ...requested,
    subagentDepth: childDepth,
  }
}

/**
 * Build the child session's durable creation metadata: the parent's workspace,
 * its direct lineage, coarse product origin, the recursion budget that must
 * survive persistence, the seed boundary that separates inherited parent
 * history from child work, and the composition the child runs under.
 *
 * The preset is read from the parent's LIVE scope chain rather than from its
 * header, because a parent that switched preset while blank runs on the newer
 * composition and its header still names the older one. Recording it is what
 * makes a child's history reconstructable: without it a cold read of the child
 * resolves the deployment default and rebuilds turns under a tool set the
 * child never had.
 * @param parent - the delegating parent agent.
 * @param childDepth - the resolved delegation depth to persist.
 * @param lineageSeedLength - how many leading events came from the parent's log.
 * @param cwd - optional validated workspace override; omitted inherits the parent cwd.
 * @returns the `meta` for `ctx.agents.create()`.
 */
export function childSessionMeta(
  parent: Agent,
  childDepth: number,
  lineageSeedLength: number,
  cwd?: string,
): NonNullable<CreateAgentOptions['meta']> {
  const parentHeader = parent.session.header
  const workspace = cwd ?? parentHeader.cwd
  const agentPreset = parent.ctx.get('agentPresets')?.composedPreset(parent.ctx)
  return {
    ...workspace !== undefined ? { cwd: workspace } : {},
    ...agentPreset === undefined ? {} : { agentPreset },
    parentSession: parentHeader.id,
    // Navigation classification only; the descriptor remains the authority
    // for mode and continuation capability.
    origin: 'subagent',
    // Durable: the recursion budget must survive persistence and resume.
    delegationDepth: childDepth,
    ...lineageSeedLength > 0 ? { seedLength: lineageSeedLength } : {},
  }
}

/** Global `harness:source` name; children shadow it empty so they do not treat the checkout as the task. */
export const HARNESS_SOURCE_SECTION = 'harness:source'

/** Lead `tool:agent-seats` name; children shadow it empty because they are not the Lead. */
export const SEAT_GUIDANCE_SECTION = 'tool:agent-seats'

/** Teammate working-directory section after tool guidance. The role slot stays `deployment:persona`. */
export const ENVIRONMENT_SECTION = 'deployment:environment'

/** Prompt order of {@link ENVIRONMENT_SECTION}, after the 100–199 tool-guidance band. */
export const ENVIRONMENT_ORDER = 200

/**
 * Validate an optional in-process child workspace override. Whitespace is
 * omitted so the child inherits the parent session cwd.
 * @param requested - caller-supplied cwd, or undefined.
 * @returns the enterable absolute path, or undefined to inherit.
 */
export function resolveRequestedChildCwd(requested: string | undefined): string | undefined {
  if (requested === undefined) return undefined
  const cwd = requested.trim()
  if (cwd.length === 0) return undefined
  return assertUsableCwd('subagent', 'child cwd', cwd)
}

/** The scoped composition a child agent's creation window applies. */
export interface ChildComposition {
  /** Per-child persona shadowing the deployment persona. */
  readonly persona?: string | undefined
  /** Per-child tool scoping. */
  readonly toolFilter?: ToolRestriction | undefined
}

/**
 * Model-facing delegation-scope statement for every in-process child. A
 * runtime-context contribution rather than a system-prompt section, so the
 * deployment's system prompt stays uniform across parents and children.
 */
export const SUBAGENT_DELEGATION_CONTEXT
  = 'You are a delegated subagent: your permission scope was fixed when you were started and cannot be '
    + 'widened from inside this session — operations that require approval are rejected automatically. '
    + 'When the task needs access beyond that scope, do not retry the denied operation; state the '
    + 'limitation in your reply so the delegating agent can handle it.'

/**
 * Compose one child inside its creation window: join its parent's preset,
 * register the fixed delegation-scope statement, suppress Lead-only prompt
 * sections, then apply the child's own shadowing persona and tool
 * restriction, all owned by the child's scope and therefore
 * invisible to its parent and siblings. Creation and cold resume both pass
 * through here.
 *
 * The join comes first and the child's own registrations second, which is the
 * order the layering already implies — the nearest scope wins a name, and a
 * per-child restriction intersects with everything its chain admits — but
 * stating it here keeps the two steps from being read as independent.
 *
 * The join and the per-child registrations live in ONE call because a child
 * composed without the join is exactly the defect this function exists to
 * prevent: with every model-facing row on the agent plane, a child that joins
 * no preset sees an empty tool registry and none of its parent's prompt
 * sections. Taking the parent as a parameter is what makes that omission
 * unrepresentable at the call sites.
 * @param childCtx - the child agent's scoped creation context.
 * @param parent - the delegating parent whose composition the child joins.
 * @param composition - the per-child persona and tool filter to install.
 */
export function applyChildComposition(
  childCtx: Context,
  parent: Agent,
  composition: ChildComposition,
): void {
  childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)
  // Order 120: after the sandbox:policy (110) and approval:policy (115) sentences.
  childCtx.systemPrompt.context({ name: 'subagent:delegation', order: 120, text: SUBAGENT_DELEGATION_CONTEXT })
  childCtx.systemPrompt.section({ name: HARNESS_SOURCE_SECTION, order: -99, text: '' })
  childCtx.systemPrompt.section({ name: SEAT_GUIDANCE_SECTION, order: 115, text: '' })
  if (composition.persona !== undefined) {
    childCtx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: composition.persona })
  }
  if (composition.toolFilter !== undefined) childCtx.tools.restrict(composition.toolFilter)
}

/** Policy seeded onto a child session's log at the delegation boundary. */
export interface DelegatedPolicyOverrides {
  /** The parent session's explicit sandbox-mode override, or `undefined` without one. */
  readonly sandboxMode: SandboxMode | undefined
  /**
   * `'never'` whenever the approval capability is composed, `undefined`
   * otherwise: a delegated child acts only within the sandbox scope fixed at
   * delegation, so its asks are rejected deterministically.
   */
  readonly approvalPolicy: 'never' | undefined
}

/**
 * Capture the policy to seed into one delegation. Call synchronously before
 * the child start's first await: a later parent switch belongs to the
 * parent's future, not to this child. Only the parent session's explicit
 * sandbox override is captured — never deployment defaults or one-shot
 * grants — and the approval policy is pinned to `'never'` regardless of the
 * parent's own policy.
 * @param parent - the delegating parent agent.
 * @returns the sandbox override (or `undefined` without one) and the approval pin.
 */
export function captureDelegatedPolicyOverrides(parent: Agent): DelegatedPolicyOverrides {
  return {
    sandboxMode: parent.ctx.get('sandboxPolicy')?.overrideOf(parent.session),
    approvalPolicy: parent.ctx.get('approval') === undefined ? undefined : 'never',
  }
}

/**
 * Append the captured delegation policy onto the child's own log as
 * `source: 'delegation'` events inside the unpublished creation window, so the
 * child's effective policy is reconstructable from its log alone. Appends land
 * after any fork seed, so fresh policy wins stale seed state; later child
 * switches still win over these events.
 * @param childSession - the unpublished child's session.
 * @param overrides - the policy captured at delegation.
 */
export function appendDelegatedPolicyOverrides(
  childSession: Session,
  overrides: DelegatedPolicyOverrides,
): void {
  if (overrides.sandboxMode !== undefined) {
    childSession.append('sandbox/mode', { mode: overrides.sandboxMode, source: 'delegation' })
  }
  if (overrides.approvalPolicy !== undefined) {
    childSession.append('approval/policy', { policy: overrides.approvalPolicy, source: 'delegation' })
  }
}

/** Identity and lineage inputs shared by every in-process child creation. */
export interface ChildCreateInputs {
  /** The child's reserved session id. */
  readonly sessionId: SessionId
  /** The delegating parent agent. */
  readonly parent: Agent
  /** The resolved delegation depth. */
  readonly childDepth: number
  /** How many leading seed events came from the parent's log. */
  readonly lineageSeedLength: number
}
