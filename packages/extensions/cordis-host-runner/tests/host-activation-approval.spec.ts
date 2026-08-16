import { describe, expect, it } from 'vitest'
import { Context } from '@roos-code/cordis'
import Timer from '@roos-code/cordis-plugin-timer'
import { CallId } from '@roos-code/roos-code-llm'
import SystemPrompt from '@roos-code/roos-code-system-prompt'
import ToolRegistry from '@roos-code/roos-code-tools'
import ApprovalService from '@roos-code/roos-code-user-approval'
import type { ApprovalOutcome, ApprovalRequest } from '@roos-code/roos-code-user-approval'
import DynamicCordisRunnerService from '../src/index.ts'
import { AGENT_A, CLIENT_CODE, setup } from './helpers.ts'

const HOST_CODE = `
  harness.handle('double', async (args) => args.value * 2)
  return {
    name: 'doubler',
    apply(ctx) {
      ctx.provide('dynDoubler', { ok: true })
    },
  }
`

function defineHost(runner: DynamicCordisRunnerService, prefix = 'dyn') {
  return runner.define({
    sessionId: AGENT_A.id,
    plugin: { kind: 'new', idPrefix: prefix },
    name: 'doubler',
    purpose: 'host activation fixture',
    code: { host: HOST_CODE },
  })
}

describe('host-half activation approval', () => {
  it('asks ctx.approval once per Plugin id with the tool call identity', async () => {
    const asked: ApprovalRequest[] = []
    const { ctx, runner } = await setup(undefined, 'none')
    ctx.on('approval/request', (req) => {
      asked.push(req)
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    const { pluginId, packageId } = defineHost(runner)
    const callId = CallId('call-host-1')

    const receipt = await runner.run(AGENT_A, pluginId, packageId, 'run', undefined, callId)
    const again = await runner.run(AGENT_A, pluginId, packageId, 'run', undefined, CallId('call-host-2'))

    expect(receipt).toMatchObject({ ok: true, status: 'running', pluginId })
    expect(again).toMatchObject({ ok: true, status: 'running', pluginId })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({
      agent: AGENT_A,
      toolName: 'cordis_run',
      callId,
    })
    expect(asked[0]?.reason).toContain(String(pluginId))
    expect(ctx.get('dynDoubler')).toEqual({ ok: true })
  })

  it('starts the Host half after allowed-once and records the Session grant', async () => {
    const { ctx, runner } = await setup(undefined, 'allowed-once')
    const { pluginId, packageId } = defineHost(runner)

    await expect(runner.run(AGENT_A, pluginId, packageId, 'run'))
      .resolves.toMatchObject({ ok: true, status: 'running' })
    expect(ctx.get('dynDoubler')).toEqual({ ok: true })
  })

  it('refuses a rejected Host half without evaluating it', async () => {
    const { ctx, runner } = await setup(undefined, 'rejected')
    const { pluginId, packageId } = defineHost(runner)

    await expect(runner.run(AGENT_A, pluginId, packageId, 'run')).resolves.toEqual({
      ok: false,
      reason: 'rejected',
      message: `The user rejected host activation of plugin "${pluginId}". Do not request the same activation again unless the user asks.`,
    })
    expect(ctx.get('dynDoubler')).toBeUndefined()
    expect(runner.inventory()[0]?.activeRun).toBeUndefined()
  })

  it('refuses a cancelled Host-activation ask without evaluating it', async () => {
    const { ctx, runner } = await setup(undefined, 'cancelled')
    const { pluginId, packageId } = defineHost(runner)

    await expect(runner.run(AGENT_A, pluginId, packageId, 'run')).resolves.toEqual({
      ok: false,
      reason: 'cancelled',
      message: `Host activation approval for plugin "${pluginId}" was cancelled. Do not retry the same activation.`,
    })
    expect(ctx.get('dynDoubler')).toBeUndefined()
  })

  it('fails closed when no approval answerer is composed', async () => {
    const { ctx, runner } = await setup(undefined, 'none')
    const { pluginId, packageId } = defineHost(runner)

    await expect(runner.run(AGENT_A, pluginId, packageId, 'run')).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
      message: `Host activation of plugin "${pluginId}" requires approval, but no approval channel is available. Do not retry the same activation.`,
    })
    expect(ctx.get('dynDoubler')).toBeUndefined()
  })

  it('skips the ask for an allowlisted Plugin id', async () => {
    const asked: string[] = []
    const { ctx, runner } = await setup({ hostActivationAllowlist: ['dyn-1'] }, 'none')
    ctx.on('approval/request', () => {
      asked.push('asked')
      return Promise.resolve<ApprovalOutcome>('rejected')
    })
    const { pluginId, packageId } = defineHost(runner)

    await expect(runner.run(AGENT_A, pluginId, packageId, 'run'))
      .resolves.toMatchObject({ ok: true, status: 'running', pluginId: 'dyn-1' })
    expect(asked).toEqual([])
    expect(ctx.get('dynDoubler')).toEqual({ ok: true })
  })

  it('does not ask for a Client-only Package', async () => {
    const asked: string[] = []
    const { ctx, runner } = await setup(undefined, 'none')
    ctx.on('approval/request', () => {
      asked.push('asked')
      return Promise.resolve<ApprovalOutcome>('rejected')
    })
    const defined = runner.define({
      sessionId: AGENT_A.id,
      plugin: { kind: 'new', idPrefix: 'uionly' },
      name: 'client-only',
      purpose: 'no host',
      code: { client: CLIENT_CODE },
    })

    const receipt = await runner.run(AGENT_A, defined.pluginId, defined.packageId, 'run')

    expect(receipt).toMatchObject({ ok: true, status: 'awaiting-approval' })
    expect(asked).toEqual([])
  })

  it('still emits the Client request-run after a Host-half grant', async () => {
    const { runner, gateway } = await setup(undefined, 'allowed-once')
    gateway.answer = 'approve'
    const defined = runner.define({
      sessionId: AGENT_A.id,
      plugin: { kind: 'new', idPrefix: 'both' },
      name: 'both',
      purpose: 'p',
      code: { host: HOST_CODE, client: CLIENT_CODE },
    })

    const receipt = await runner.run(AGENT_A, defined.pluginId, defined.packageId, 'run')

    expect(receipt).toMatchObject({ ok: true, status: 'awaiting-approval' })
    await gateway.answering
    expect(gateway.events.map(([name]) => name)).toEqual([
      'cordis/request-run', 'cordis/dynamic-package', 'cordis/request-run-resolved',
    ])
  })

  it('fails load when the allowlist contains an invalid Plugin id', async () => {
    const ctx = new Context()
    await ctx.plugin(Timer)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(ApprovalService)
    await expect(ctx.plugin(DynamicCordisRunnerService, {
      hostActivationAllowlist: ['not a plugin id'],
    })).rejects.toThrow(/invalid hostActivationAllowlist entry/)
  })

  it('fails closed when the Host-activation ask happens outside an open turn', async () => {
    const { runner } = await setup(undefined, 'allowed-once')
    const { pluginId, packageId } = defineHost(runner)
    AGENT_A.session.events.length = 0
    AGENT_A.session.append('turn/end', { turn: 1 })

    await expect(runner.run(AGENT_A, pluginId, packageId, 'run')).resolves.toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
  })
})
