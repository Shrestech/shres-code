/**
 * Agent Teams: durable vocabulary, Lead-log mailbox, continuable-child
 * provisioning, steer delivery, and `team_send` / `team_list` tools.
 *
 * @module @shres-code/shres-code-agent-team
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import type {} from '@shres-code/shres-code-session-projection'
import type {} from '@shres-code/shres-code-agent'
import type {} from '@shres-code/shres-code-session-persistence'
import type {} from '@shres-code/shres-code-subagent'
import type {} from '@shres-code/shres-code-tools'
import { TeamError } from './error.ts'
import { teamProjectionDefinition } from './projection.ts'
import { TeamService } from './service.ts'
import { registerTeamTools } from './tools.ts'

export type * from './types.ts'
export { TeamId, TeamMessageId, TeamTaskId } from './brand.ts'
export { TeamError, errorMessage } from './error.ts'
export type { TeamErrorCode } from './error.ts'
export { TeamJournal } from './journal.ts'
export {
  applyTeamEvent,
  emptyTeamFoldState,
  foldTeam,
  isTeamEvent,
  teamStateFromFold,
} from './fold.ts'
export type { TeamEventType, TeamFoldState, TeamSessionEvent } from './fold.ts'
export { teamProjectionDefinition } from './projection.ts'
export type { TeamProjectionState } from './projection.ts'
export { assertTaskGraphCandidate, TeamTaskGraphError } from './task-graph.ts'
export type { TeamTaskGraphViolation } from './task-graph.ts'
export { TeamService } from './service.ts'
export type { TeamMembership } from './roster.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'agent-team'

/** The projection registry is required; without it the fiber stays pending. */
export const inject = ['sessionProjections']

/**
 * Validate one positive safe-integer deployment limit.
 * @param field - config field name used in the error.
 * @param value - candidate value after schemastery defaulting.
 * @returns the same value when it is a positive safe integer.
 */
function positiveLimit(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TeamError(`${field} must be a positive safe integer`, 'TEAM_INVALID_CONFIG')
  }
  return value
}

/** Host-plugin config. Limits are deployment-varying; they are not module constants. */
export interface Config {
  /** Maximum immutable teammate names retained by one Team. */
  readonly maxMembers?: number
  /** Maximum non-deleted tasks retained by one Team. */
  readonly maxTasks?: number
  /** Maximum queued-minus-delivered messages for one target member. */
  readonly maxPendingMessagesPerMember?: number
  /** Maximum UTF-8 bytes in one complete sender-framed delivery. */
  readonly maxMessageBytes?: number
  /** Maximum milliseconds allowed for Team-owned runtime disposal. */
  readonly disposalTimeoutMs?: number
}

/** Schema-defaulted deployment limits. */
export type ResolvedConfig = Required<Config>

export const Config: z<Config> = z.object({
  maxMembers: z.number().step(1).min(1).default(8),
  maxTasks: z.number().step(1).min(1).default(256),
  maxPendingMessagesPerMember: z.number().step(1).min(1).default(64),
  maxMessageBytes: z.number().step(1).min(1).default(65_536),
  disposalTimeoutMs: z.number().step(1).min(1).default(5_000),
})

/**
 * Fail loud on a non-positive limit after schemastery defaulting.
 * @param config - schema-defaulted plugin config.
 * @returns the same object typed as fully populated limits.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved = config as ResolvedConfig
  positiveLimit('maxMembers', resolved.maxMembers)
  positiveLimit('maxTasks', resolved.maxTasks)
  positiveLimit('maxPendingMessagesPerMember', resolved.maxPendingMessagesPerMember)
  positiveLimit('maxMessageBytes', resolved.maxMessageBytes)
  positiveLimit('disposalTimeoutMs', resolved.disposalTimeoutMs)
  return resolved
}

/**
 * Register the `agentTeam` unit and fail loud on invalid limits. The
 * registration is an effect on this plugin's fiber, so unloading removes the
 * key. Limits are validated now so later Team operations can read them from
 * Config without introducing module constants.
 * @param ctx - registrant context carrying the projection registry.
 * @param config - schema-defaulted deployment limits.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.sessionProjections.register(teamProjectionDefinition)
  ctx.plugin(TeamService, resolved)
  ctx.inject(['tools', 'agentTeams'], (toolsCtx) => {
    registerTeamTools(toolsCtx)
  })
}
