/** Execution-time authority checks for the model-facing goal tools. */

import type { Context } from '@shres-code/cordis'
import type { Agent } from '@shres-code/shres-code-agent'
import type { GoalView } from '@shres-code/shres-code-goal'
import { HarnessError } from '@shres-code/shres-code-llm'
import type { SessionEvent } from '@shres-code/shres-code-session'
import type { ToolRunContext } from '@shres-code/shres-code-tools'

type TurnStartEvent = Extract<SessionEvent, { type: 'turn/start' }>

/** Current open turn plus the events accepted after its start boundary. */
export interface GoalToolExecution {
  readonly agent: Agent
  readonly start: TurnStartEvent
  readonly events: readonly SessionEvent[]
}

/** Hard authority granted to one state-changing call. */
export type GoalToolAuthority =
  | { readonly kind: 'direct-human' }
  | { readonly kind: 'goal-round'; readonly goal: GoalView }
  | { readonly kind: 'disarmed'; readonly goal: GoalView }

/** Throw one structured tool-policy failure. */
function reject(message: string, code = 'GOAL_TOOL_AUTHORITY_REQUIRED'): never {
  throw new HarnessError(message, code)
}

/** Locate the open turn enclosing a model tool call. */
function openTurn(agent: Agent): { start: TurnStartEvent; events: readonly SessionEvent[] } {
  const events = agent.session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const boundary = events[index]
    if (boundary?.type === 'turn/end') {
      reject('goal tools require an open model turn', 'GOAL_TOOL_DRIVER_REQUIRED')
    }
    if (boundary?.type === 'turn/start') {
      return { start: boundary, events: events.slice(index + 1) }
    }
  }
  return reject('goal tools require an open model turn', 'GOAL_TOOL_DRIVER_REQUIRED')
}

/**
 * Resolve and authenticate the calling agent and its driver boundary.
 * @param ctx - Context carrying the live agent registry.
 * @param exec - Tool execution metadata supplied by the registry.
 * @returns The authenticated agent and its current turn window.
 */
export function goalToolExecution(ctx: Context, exec: ToolRunContext): GoalToolExecution {
  const agent = exec.agent
  if (agent === undefined) {
    return reject('goal tools require a calling agent', 'GOAL_TOOL_AGENT_REQUIRED')
  }
  if (ctx.agents.get(agent.id) !== agent || agent.status !== 'running'
    || ctx.agents.currentInitiator() !== agent) {
    return reject(
      'goal tools require the exact live calling agent inside its active driver',
      'GOAL_TOOL_DRIVER_REQUIRED',
    )
  }
  return { agent, ...openTurn(agent) }
}

/**
 * Whether host-attested human input appears in the current root-agent turn.
 * An omitted `Agent.followup()` / `steer()` source resolves to `user`, so non-human
 * producers must supply their own source rather than inheriting this authority.
 */
function hasDirectHumanInput(ctx: Context, execution: GoalToolExecution): boolean {
  if (!isRuntimeRoot(ctx, execution)) return false
  return execution.events.some(event =>
    event.type === 'user/message' && event.data.source.kind === 'user')
}

/** Whether the executing agent is a runtime root, not a scoped subagent. */
function isRuntimeRoot(ctx: Context, execution: GoalToolExecution): boolean {
  return ctx.agents.roots().includes(execution.agent)
}

/** Whether this turn is the current goal's exact admitted round. */
function isMatchingGoalRound(execution: GoalToolExecution, goal: GoalView): boolean {
  return execution.events.some(event => event.type === 'user/message'
    && event.data.source.kind === 'goal'
    && event.data.source.goalId === goal.id
    && event.data.source.revision === goal.revision
    && event.data.source.round === goal.roundsStarted)
}

/**
 * Require authority originating in a human message accepted by a runtime root.
 * @param ctx - Context carrying the live agent graph.
 * @param execution - Authenticated current tool execution.
 */
export function requireDirectHuman(ctx: Context, execution: GoalToolExecution): void {
  if (hasDirectHumanInput(ctx, execution)) return
  reject('this goal operation requires a direct human turn on a top-level agent')
}

/**
 * Resolve completion authority from direct human input, the exact goal round,
 * or — for `complete` only — a disarmed goal on a runtime root.
 *
 * The disarmed grant is bookkeeping-only: `goal-round-driver` reserves rounds
 * exclusively while `activation === 'armed'`, so completing a disarmed goal
 * cuts short no continuation. It exists so an agent whose finishing turn was
 * not human-driven (a background-notification or plugin-sourced turn) can
 * still close the goal instead of leaving an active-but-idle goal the runtime
 * refuses to settle from that turn. The roots check keeps a subagent session
 * seeded with a parent's goal events from closing the parent's goal.
 * `blocked` never takes this grant: its persisted-rounds threshold is
 * untestable without admitted rounds.
 *
 * @param ctx - Context carrying live agents and goal state.
 * @param execution - Authenticated current tool execution.
 * @param action - terminal action the caller is reporting.
 * @returns The direct-human, exact-goal-round, or disarmed-goal authority grant.
 */
export function completionAuthority(
  ctx: Context,
  execution: GoalToolExecution,
  action: 'complete' | 'blocked',
): GoalToolAuthority {
  if (hasDirectHumanInput(ctx, execution)) return { kind: 'direct-human' }
  const goal = ctx.goals.get(execution.agent)
  if (goal !== undefined && isMatchingGoalRound(execution, goal)) {
    return { kind: 'goal-round', goal }
  }
  if (action === 'complete' && goal !== undefined && goal.activation === 'disarmed'
    && isRuntimeRoot(ctx, execution)) {
    return { kind: 'disarmed', goal }
  }
  return reject('complete and blocked require a direct human turn or the current goal round; '
    + 'complete additionally admits a disarmed goal on a runtime root')
}
