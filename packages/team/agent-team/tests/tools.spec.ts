import { describe, expect, it } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
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

  it('forwards an optional first-provision cwd on team_send', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const seen: unknown[] = []
    class FakeTeams extends Service {
      constructor(host: Context) {
        super(host, 'agentTeams')
      }

      async sendMessage(_agent: unknown, request: unknown) {
        seen.push(request)
        return { messageId: 'team-message-1', status: 'accepted' }
      }
    }
    await ctx.plugin(FakeTeams)
    registerTeamTools(ctx)
    const sent = await ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId('send-cwd'),
      name: 'team_send',
      arguments: { target: 'aegis', message: 'hi', cwd: '/tmp/ws' },
      agent: { id: 'lead' } as never,
    })
    expect(sent.isError).toBe(false)
    expect(seen).toEqual([expect.objectContaining({
      target: 'aegis',
      persona: 'hi',
      cwd: '/tmp/ws',
    })])
    const later = await ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId('send-later'),
      name: 'team_send',
      arguments: { target: 'aegis', message: 'later' },
      agent: { id: 'lead' } as never,
    })
    expect(later.isError).toBe(false)
    expect(seen[1]).toEqual(expect.objectContaining({
      target: 'aegis',
      persona: 'later',
    }))
    expect(seen[1]).not.toHaveProperty('cwd')
    await ctx.fiber.dispose()
  })

  it('renders reserved seats as unstarted, not inactive', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    class FakeTeams extends Service {
      constructor(host: Context) {
        super(host, 'agentTeams')
      }

      membership() {
        return { name: 'lead' }
      }

      listMembers() {
        return [
          { name: 'lead', role: 'lead', status: 'running', id: 'lead-id', diagnostics: [] },
          { name: 'aegis', role: 'teammate', status: 'unstarted', id: 'unprovisioned:aegis', diagnostics: [] },
        ]
      }
    }
    await ctx.plugin(FakeTeams)
    registerTeamTools(ctx)
    const listed = ctx.tools.schemas().find(schema => schema.name === 'team_list')
    expect(listed?.description).toMatch(/unstarted means the name is reserved/)
    expect(listed?.description).toMatch(/not crashed or stopped/)
    expect(listed?.description).not.toMatch(/not yet started/)
    const result = await ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId('list-unstarted'),
      name: 'team_list',
      arguments: {},
      agent: { id: 'lead' } as never,
    })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{
      type: 'text',
      text: 'you are lead; members: lead (running), aegis (unstarted)',
    }])
    await ctx.fiber.dispose()
  })
})
