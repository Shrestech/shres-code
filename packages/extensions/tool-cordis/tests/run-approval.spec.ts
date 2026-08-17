import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import Timer from '@shres-code/cordis-plugin-timer'
import type { Agent } from '@shres-code/shres-code-agent'
import { CallId } from '@shres-code/shres-code-llm'
import type { SessionId } from '@shres-code/shres-code-session/types'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRegistry from '@shres-code/shres-code-tools'
import type { ToolExecutionResult } from '@shres-code/shres-code-tools'
import ApprovalService from '@shres-code/shres-code-user-approval'
import type { ApprovalOutcome } from '@shres-code/shres-code-user-approval'
import DynamicCordisRunnerService from '@shres-code/shres-code-cordis-host-runner'
import * as ToolCordis from '../src/index.ts'

const HOST_CODE = 'return { name: \'probe\', apply() {} }'

function agentOf(id: string): Agent {
  const events: Array<{ type: string; data?: unknown }> = [{ type: 'turn/start' }]
  return {
    id: id as SessionId,
    steer() {},
    inject() {},
    session: {
      events,
      append(type: string, data?: unknown) {
        events.push({ type, data })
      },
    },
  } as unknown as Agent
}

async function mounted(hostApproval: ApprovalOutcome | 'none' = 'allowed-once'): Promise<{
  ctx: Context
  agent: Agent
}> {
  const ctx = new Context()
  const agent = agentOf('S-cordis-run')
  await ctx.plugin(Timer)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(ApprovalService)
  if (hostApproval !== 'none') {
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>(hostApproval))
  }
  await ctx.plugin(DynamicCordisRunnerService)
  await ctx.plugin(ToolCordis)
  return { ctx, agent }
}

let calls = 0

function execute(
  ctx: Context,
  agent: Agent,
  name: string,
  args: unknown,
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`cordis-call-${++calls}`),
    name,
    arguments: args,
    agent,
  })
}

function text(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('cordis_run Host-activation denial', () => {
  it('returns a structured non-error result when the user rejects Host activation', async () => {
    const { ctx, agent } = await mounted('rejected')
    const defined = await execute(ctx, agent, 'cordis_define', {
      plugin: { kind: 'new', idPrefix: 'deny' },
      name: 'denied',
      purpose: 'must not run',
      code: { host: HOST_CODE },
    })
    expect(defined.isError).toBe(false)
    const pluginId = (defined.value as { pluginId: string }).pluginId
    const packageId = (defined.value as { packageId: string }).packageId

    const result = await execute(ctx, agent, 'cordis_run', {
      pluginId, packageId, mode: 'run',
    })

    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      status: 'rejected',
      pluginId,
      packageId,
      message: `The user rejected host activation of plugin "${pluginId}". Do not request the same activation again unless the user asks.`,
    })
    expect(text(result)).toContain('Do not request the same activation again')
  })

  it('returns a structured unavailable result when no answerer is composed', async () => {
    const { ctx, agent } = await mounted('none')
    const defined = await execute(ctx, agent, 'cordis_define', {
      plugin: { kind: 'new', idPrefix: 'miss' },
      name: 'missing-answerer',
      purpose: 'must not run',
      code: { host: HOST_CODE },
    })
    const pluginId = (defined.value as { pluginId: string }).pluginId
    const packageId = (defined.value as { packageId: string }).packageId

    const result = await execute(ctx, agent, 'cordis_run', {
      pluginId, packageId, mode: 'run',
    })

    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ status: 'unavailable', pluginId, packageId })
    expect(text(result)).toContain('Do not retry the same activation')
  })

  it('still starts a granted Host-only Package', async () => {
    const { ctx, agent } = await mounted('allowed-once')
    const defined = await execute(ctx, agent, 'cordis_define', {
      plugin: { kind: 'new', idPrefix: 'okay' },
      name: 'granted',
      purpose: 'runs',
      code: { host: HOST_CODE },
    })
    const pluginId = (defined.value as { pluginId: string }).pluginId
    const packageId = (defined.value as { packageId: string }).packageId

    const result = await execute(ctx, agent, 'cordis_run', {
      pluginId, packageId, mode: 'run',
    })

    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      status: 'running',
      pluginId,
      packageId,
    })
  })
})
