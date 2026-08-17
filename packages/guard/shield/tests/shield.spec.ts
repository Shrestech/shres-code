/**
 * Host-seat entitlement and resolve: panic, missing engine, unlicensed
 * package-source, env-module entitle, and dispose of the paid apply.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context, FiberState } from '@shres-code/cordis'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import { remoteMethods } from '@shres-code/shres-code-typert-protocol'
import * as ShieldSeat from '@shres-code/shres-code-shield'
import type { ShieldDecision } from '@shres-code/shres-code-shield/types'
import { Session, SessionId } from '@shres-code/shres-code-session'
import { fileURLToPath } from 'node:url'
import { applied } from './fixtures/fake-shield-plugin.ts'

const fixtureUrl = fileURLToPath(new URL('./fixtures/fake-shield-plugin.ts', import.meta.url))

const saved = {
  SHRES_SHIELD: process.env.SHRES_SHIELD,
  SHRES_SHIELD_LICENSE: process.env.SHRES_SHIELD_LICENSE,
  SHRES_SHIELD_MODULE: process.env.SHRES_SHIELD_MODULE,
}

function setEnv(
  name: 'SHRES_SHIELD' | 'SHRES_SHIELD_LICENSE' | 'SHRES_SHIELD_MODULE',
  value: string | undefined,
): void {
  if (value === undefined) {
    if (name === 'SHRES_SHIELD') delete process.env.SHRES_SHIELD
    else if (name === 'SHRES_SHIELD_LICENSE') delete process.env.SHRES_SHIELD_LICENSE
    else delete process.env.SHRES_SHIELD_MODULE
    return
  }
  process.env[name] = value
}

afterEach(() => {
  if (saved.SHRES_SHIELD === undefined) delete process.env.SHRES_SHIELD
  else process.env.SHRES_SHIELD = saved.SHRES_SHIELD
  if (saved.SHRES_SHIELD_LICENSE === undefined) delete process.env.SHRES_SHIELD_LICENSE
  else process.env.SHRES_SHIELD_LICENSE = saved.SHRES_SHIELD_LICENSE
  if (saved.SHRES_SHIELD_MODULE === undefined) delete process.env.SHRES_SHIELD_MODULE
  else process.env.SHRES_SHIELD_MODULE = saved.SHRES_SHIELD_MODULE
  applied.count = 0
  applied.config = undefined
  applied.disposed = 0
  applied.approvalProbe = 'absent'
  applied.jobsProbe = 'absent'
})

/** Wait until the async resolve/apply effect has published a terminal reason. */
async function waitForReason(ctx: Context, reason: ShieldSeat.ShieldReason): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (ctx.shield.status.reason === reason) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
  throw new Error(`shield status stayed ${JSON.stringify(ctx.shield.status)}, wanted ${reason}`)
}

/**
 * Mount `approval` and `jobs` as sibling plugins, matching product Loader
 * topology. Root `ctx.provide` would make an uninjected seat read succeed.
 */
async function provideApprovalAndJobs(ctx: Context): Promise<void> {
  await ctx.plugin({
    name: 'approval-stub',
    apply: (c: Context) => {
      c.provide('approval', { request: async () => 'unavailable' })
    },
  })
  await ctx.plugin({
    name: 'jobs-stub',
    apply: (c: Context) => {
      c.provide('jobs', { enqueue: () => undefined })
    },
  })
}

/** Mount prompt + tools + sibling approval/jobs + the seat and wait for resolve. */
async function setup(config: ShieldSeat.Config = {}, reason?: ShieldSeat.ShieldReason): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await provideApprovalAndJobs(ctx)
  await ctx.plugin(ShieldSeat, config)
  if (reason !== undefined) await waitForReason(ctx, reason)
  return ctx
}

describe('shres-shield host seat', () => {
  it('lists approval and jobs so sibling services are readable from the seat ctx', async () => {
    expect(ShieldSeat.inject).toEqual(['systemPrompt', 'tools', 'approval', 'jobs'])
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = await setup({ license: 'paid' }, 'active')
    expect(ctx.shield.status.active).toBe(true)
    expect(applied.approvalProbe).toBe('ok')
    expect(applied.jobsProbe).toBe('ok')
  })

  it('stays pending and does not apply the engine without sibling approval and jobs', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // Do not await: a forever-PENDING fiber's thenable does not settle.
    const fiber = ctx.plugin(ShieldSeat, { license: 'paid' })
    await Promise.resolve()
    expect(fiber.state).toBe(FiberState.PENDING)
    expect(applied.count).toBe(0)
    expect(ctx.get('shield')).toBeUndefined()
    await fiber.dispose()
  })

  it('unloads the engine when the user switch is off', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = await setup({ enabled: false, license: 'paid' }, 'disabled')
    expect(ctx.shield.status).toEqual({ active: false, reason: 'disabled' })
    expect(applied.count).toBe(0)
  })

  it('stays inactive and does not apply the engine when SHRES_SHIELD=off', async () => {
    setEnv('SHRES_SHIELD', 'off')
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = await setup({ license: 'paid' }, 'panic')
    expect(ctx.shield.status).toEqual({ active: false, reason: 'panic' })
    expect(applied.count).toBe(0)
  })

  it('reports engine-missing when no payload resolves', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', '/no/such/shres-shield-module.js')
    const ctx = await setup({ license: 'paid' }, 'engine-missing')
    expect(ctx.shield.status).toEqual({ active: false, reason: 'engine-missing' })
    expect(applied.count).toBe(0)
  })

  it('entitles an env-resolved payload without a license and forwards posture', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_LICENSE', undefined)
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = await setup({ posture: 'observe' }, 'active')
    expect(ctx.shield.status).toEqual({ active: true, reason: 'active' })
    expect(applied.count).toBe(1)
    expect(applied.config).toEqual({ posture: 'observe' })
  })

  it('disposes the paid instance when the seat fiber unloads', async () => {
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = await setup({ license: 'paid' }, 'active')
    expect(ctx.shield.status.active).toBe(true)
    await ctx.fiber.dispose()
    expect(applied.disposed).toBe(1)
  })

  it('lets SHRES_SHIELD_LICENSE override an empty row license', () => {
    setEnv('SHRES_SHIELD_LICENSE', 'from-env')
    expect(ShieldSeat.readLicense({ license: '' })).toBe('from-env')
  })

  it('uses the temporary default license when the row and env are empty', () => {
    setEnv('SHRES_SHIELD_LICENSE', undefined)
    expect(ShieldSeat.readLicense({ license: '' })).toBe(ShieldSeat.DEFAULT_SHIELD_LICENSE)
    expect(ShieldSeat.isEntitled(ShieldSeat.DEFAULT_SHIELD_LICENSE, 'package')).toBe(true)
  })

  it('requires a license for a package-resolved payload and not for sibling or env', () => {
    expect(ShieldSeat.isEntitled('', 'package')).toBe(false)
    expect(ShieldSeat.isEntitled('key', 'package')).toBe(true)
    expect(ShieldSeat.isEntitled('', 'sibling')).toBe(true)
    expect(ShieldSeat.isEntitled('', 'env')).toBe(true)
  })

  it('publishes a direct snapshot remote and empty stats before the engine binds', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', '/no/such-shield-module.js')
    const ctx = await setup({ license: 'paid' }, 'engine-missing')
    expect(ctx.shield.typertRemote).toMatchObject({
      serviceKey: 'shield',
      namespace: 'shield',
    })
    expect(remoteMethods(ctx.shield)).toEqual([
      { method: 'snapshot', invocation: { kind: 'direct' } },
    ])
    expect(ctx.shield.snapshot()).toEqual({
      status: { active: false, reason: 'engine-missing' },
      stats: ShieldSeat.emptyRepoStats(null),
    })
  })

  it('copies engine stats onto the snapshot and keeps them after disable', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = await setup({ license: 'paid' }, 'active')
    const live = ctx.shield.snapshot()
    expect(live.status).toEqual({ active: true, reason: 'active' })
    expect(live.stats).toMatchObject({
      cwd: '/tmp/shield-fixture',
      screened: 4,
      asked: 2,
      askedGranted: 1,
      askedDenied: 1,
      blocked: 1,
      observed: 1,
    })
    expect(live.stats).not.toBe(applied.stats)

    ctx.shield.bindPayload(undefined)
    const { status } = ctx.shield
    status.active = false
    status.reason = 'disabled'
    const disabled = ctx.shield.snapshot()
    expect(disabled.status).toEqual({ active: false, reason: 'disabled' })
    expect(disabled.stats.screened).toBe(4)
    expect(disabled.stats.asked).toBe(2)
  })

  it('keys snapshot stats by a live session cwd', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = await setup({ license: 'paid' }, 'active')
    ctx.provide('sessions', {
      get: (id: SessionId) => id === SessionId('s1') ? { header: { cwd: '/from-id' } } : undefined,
      list: () => [{ header: { cwd: '/from-list' } }],
    })
    expect(ctx.shield.snapshot('s1').stats.cwd).toBe('/from-id')
    expect(ctx.shield.snapshot().stats.cwd).toBe('/from-list')
  })

  it('reads nested engine stats and keeps last counts when snapshot throws', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', '/no/such-shield-module.js')
    const ctx = await setup({ license: 'paid' }, 'engine-missing')
    ctx.shield.bindPayload({
      shield: {
        stats: {
          snapshot: () => ({
            cwd: '/nested',
            screened: 9,
            observed: 0,
            asked: 1,
            blocked: 2,
            byChannel: { tool_args: { screened: 9, observed: 0, asked: 1, blocked: 2 } },
            recent: [{
              at: 1,
              verdict: 'deny',
              rule: 'sig.x',
              channel: 'tool_args',
              sha16: '0123456789abcdef',
              host: 'example.com',
            }],
            definitions: { version: 'v1', updatedAt: 2, stale: false },
          }),
        },
      },
    })
    const live = ctx.shield.snapshot()
    expect(live.stats.screened).toBe(9)
    expect(live.stats.askedGranted).toBe(0)
    expect(live.stats.recent[0]).toMatchObject({ host: 'example.com' })
    expect(live.definitions).toEqual({ version: 'v1', updatedAt: 2, stale: false })

    ctx.shield.bindPayload({
      stats: {
        snapshot: () => {
          throw new Error('engine snapshot failed')
        },
      },
    })
    expect(ctx.shield.snapshot().stats.screened).toBe(9)
  })

  it('skips malformed engine stats and still returns last good counts', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', '/no/such-shield-module.js')
    const ctx = await setup({ license: 'paid' }, 'engine-missing')
    ctx.shield.bindPayload({ stats: { snapshot: () => 'nope' } })
    expect(ctx.shield.snapshot().stats).toEqual(ShieldSeat.emptyRepoStats(null))
    ctx.provide('sessions', {
      get: () => undefined,
      list: () => [{ header: { cwd: '/only-list' } }],
    })
    expect(ctx.shield.snapshot().stats.cwd).toBe('/only-list')
    ctx.shield.bindPayload({
      stats: {
        snapshot: () => ({
          screened: 1,
          observed: 0,
          asked: 0,
          blocked: 0,
          cwd: 1,
          byChannel: { bad: 'no', tool_args: { screened: 1, observed: 0, asked: 0, blocked: 0 } },
          recent: [
            null,
            { at: 1, rule: 'x', channel: 'y', sha16: 'z', verdict: 'nope' },
            { at: 2, rule: 'ok', channel: 'user_message', sha16: '0123456789abcdef', verdict: 'observe' },
          ],
          definitions: { version: 'v', updatedAt: 'no', stale: false },
        }),
      },
    })
    const next = ctx.shield.snapshot()
    expect(next.stats.screened).toBe(1)
    expect(next.stats.recent).toHaveLength(1)
    expect(next.definitions).toBeUndefined()
  })

  it('accepts wrapped engine stats, call ids, and a null definition stamp', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', '/no/such-shield-module.js')
    const ctx = await setup({ license: 'paid' }, 'engine-missing')
    ctx.shield.bindPayload(null)
    expect(ctx.shield.snapshot().stats.screened).toBe(0)
    ctx.shield.bindPayload({})
    ctx.shield.bindPayload({
      stats: {
        snapshot: () => ({
          stats: {
            screened: 3,
            observed: 0,
            asked: 0,
            blocked: 0,
            byChannel: null,
            recent: 'no',
            callId: 'ignored',
          },
          definitions: { version: 'seed', updatedAt: null, stale: true },
        }),
      },
    })
    const wrapped = ctx.shield.snapshot()
    expect(wrapped.stats.screened).toBe(3)
    expect(wrapped.stats.recent).toEqual([])
    expect(wrapped.definitions).toEqual({ version: 'seed', updatedAt: null, stale: true })
    ctx.shield.bindPayload({
      stats: {
        snapshot: () => ({
          screened: 1,
          observed: 0,
          asked: 0,
          blocked: 0,
          recent: [{
            at: 3,
            rule: 'sig.y',
            channel: 'tool_result',
            sha16: 'ffffffffffffffff',
            verdict: 'ask',
            callId: 'c1',
          }],
        }),
      },
    })
    expect(ctx.shield.snapshot().stats.recent[0]).toMatchObject({ callId: 'c1', verdict: 'ask' })
    ctx.provide('sessions', {
      get: (id: SessionId) => id === SessionId('empty') ? { header: {} } : undefined,
      list: () => [{ header: {} }, { header: { cwd: '/listed' } }],
    })
    expect(ctx.shield.snapshot('empty').stats.cwd).toBe('/listed')
    expect(ctx.shield.snapshot('missing').stats.cwd).toBe('/listed')
  })

  it('declares shield/decision as an ignorable session event', () => {
    const session = Session.create(SessionId('shield-decision'))
    const data: ShieldDecision = {
      verdict: 'deny',
      rule: 'sig.literal',
      reasonCode: 'deny-literal',
      channel: 'tool_result',
      sha16: '0123456789abcdef',
    }
    const event = session.append('shield/decision', data, { ignorable: true })
    expect(event.ignorable).toBe(true)
    expect(event.data).toEqual(data)
    expect(event.type).toBe('shield/decision')
  })
})
