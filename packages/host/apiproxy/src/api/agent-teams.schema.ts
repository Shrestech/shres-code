/** Zod schemas for the browser-safe Agent Teams domain. */

import { z } from 'zod'
import { sessionIdSchema } from './sessions.schema.ts'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { AgentTeamsMemberRow } from './agent-teams.ts'

/** One roster row as the chat-header panel renders it. */
export const agentTeamsMemberRowSchema = z.object({
  name: z.string(),
  role: z.union([z.literal('lead'), z.literal('teammate')]),
  status: z.union([
    z.literal('running'),
    z.literal('idle'),
    z.literal('unstarted'),
    z.literal('inactive'),
    z.literal('provisioning'),
    z.literal('failed'),
  ]),
  id: z.string(),
  description: z.string().optional(),
  provider: z.string().optional(),
  agentProvider: z.string().optional(),
  model: z.string().optional(),
  diagnostics: z.array(z.string()),
}) satisfies z.ZodType<Wire<AgentTeamsMemberRow>>

/** agentTeams.view request payload. */
export const agentTeamsViewRequestSchema = z.object({
  sessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'agentTeams.view'>>>

/** agentTeams.view response value. */
export const agentTeamsViewValueSchema = z.object({
  sessionId: sessionIdSchema,
  isTeam: z.boolean(),
  members: z.array(agentTeamsMemberRowSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'agentTeams.view'>>>
