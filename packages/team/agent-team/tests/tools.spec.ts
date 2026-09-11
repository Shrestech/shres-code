import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { CallId } from '@shres-code/shres-code-llm'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import { registerTeamTools } from '../src/tools.ts'

const SIGNAL = new AbortController().signal

describe('team tools', () => {
  it('fails loud when agentTeams is missing or the caller agent is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    registerTeamTools(ctx)
    const listed = await ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId('list-no-teams'),
      name: 'team_list',
      arguments: {},
      agent: { id: 'lead' } as never,
    })
    expect(listed.isError).toBe(true)
    expect(listed.content.map(block => 'text' in block ? block.text : '').join('')).toMatch(/agentTeams/)

    const sent = await ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId('send-no-agent'),
      name: 'team_send',
      arguments: { target: 'aegis', message: 'hi' },
    })
    expect(sent.isError).toBe(true)
    expect(sent.content.map(block => 'text' in block ? block.text : '').join('')).toMatch(/calling agent/)
    await ctx.fiber.dispose()
  })
})
