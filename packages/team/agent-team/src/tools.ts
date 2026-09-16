/** Model-facing `team_send` and `team_list` tools. */

import type { Context } from '@shres-code/cordis'
import { defineTool } from '@shres-code/shres-code-tools'
import type { ContentBlock } from '@shres-code/shres-code-llm'
import type { TeamService } from './service.ts'

function teamsOf(ctx: Context): TeamService {
  const teams = ctx.get('agentTeams')
  if (teams === undefined) throw new Error('team tools require ctx.agentTeams')
  return teams
}

/**
 * Register Team mail tools on Lead and teammate scopes (global registry).
 * @param ctx - context carrying tools and the Team service.
 */
export function registerTeamTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'team_list',
    description:
      'List this Agent Team: the Lead, bound seats, and YAML extras (including teammates not yet started). '
      + 'Generic subagent children and the J-Space Advisor are not teammates and do not appear here. '
      + 'Use team_send to mail a listed name. This call returns no reply from anyone.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          self: { type: 'string', required: true },
          members: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                role: { type: 'string', required: true },
                status: { type: 'string', required: true },
                id: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `you are ${value.self}; members: ${value.members.map(row => `${row.name} (${row.status})`).join(', ')}`,
      }],
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_list requires a calling agent (exec.agent was undefined)')
      const membership = teamsOf(ctx).membership(agent)
      return {
        self: membership.name,
        members: teamsOf(ctx).listMembers(agent).map(row => ({
          name: row.name,
          role: row.role,
          status: row.status,
          id: String(row.id),
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'team_send',
    description:
      'Send a message to a named teammate or to lead. A running teammate is steered at the next step; '
      + 'an idle teammate starts a turn. Only the Lead provisions an unstarted listed name; a teammate '
      + 'can mail a name that is already active or still being created. This is not send_message: it '
      + 'cannot address a generic subagent child. The call returns no reply from the target. Failure '
      + 'means the mailbox did not accept the message.',
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: 'Teammate name (aegis, stride, ward, or a YAML extra) or lead.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The message to deliver to that teammate.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `team message ${value.messageId} ${value.status} for ${args.target}`,
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_send requires a calling agent (exec.agent was undefined)')
      const content: ContentBlock[] = [{ type: 'text', text: args.message }]
      const result = await teamsOf(ctx).sendMessage(agent, {
        target: args.target,
        content,
        signal: exec.signal,
      })
      return { messageId: String(result.messageId), status: result.status }
    },
  }))
}
