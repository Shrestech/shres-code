/** Named product-seat tools that provision a teammate then Team-steer. */

import type { Context } from '@shres-code/cordis'
import { defineTool } from '@shres-code/shres-code-tools'
import type { TeamService } from '@shres-code/shres-code-agent-team'
import type { BoundSeat } from './roster.ts'

/**
 * Register one named seat as Team mail rather than a generic subagent hire.
 * @param ctx - host with tools.
 * @param seat - bound product seat.
 * @param teams - live Agent Teams service.
 */
export function registerTeamSeatTool(ctx: Context, seat: BoundSeat, teams: TeamService): void {
  ctx.tools.register(defineTool({
    name: seat.entry.id,
    description:
      `${seat.entry.description} This teammate is part of the Agent Team: the Lead's first call `
      + 'provisions it, later calls steer the current turn at the next step via Team mail. A teammate '
      + 'can mail this name only after it is active or while it is being created. It does not see this conversation.',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'Short label for this assignment.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'Complete standalone instructions for this teammate.',
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
      render: (_args, value) => [{
        type: 'text',
        text: `team message ${value.messageId} ${value.status} for ${seat.entry.id}`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error(`${seat.entry.id} requires a calling agent`)
      await teams.ensureTemplateMember(parent, seat.entry.id)
      const result = await teams.sendMessage(parent, {
        target: seat.entry.id,
        content: [{ type: 'text', text: args.prompt }],
        signal: exec.signal,
      })
      return { messageId: String(result.messageId), status: result.status }
    },
  }))
}
