/**
 * Host-seat entitlement and resolve: panic, missing engine, unlicensed
 * package-source, env-module entitle, and dispose of the paid apply.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context, FiberState } from '@shres-code/cordis'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import { remoteMethods } from '@shres-code/shres-code-typert-protocol'
import { SettingsProvider } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import * as ShieldSeat from '@shres-code/shres-code-shield'
import type { ShieldDecision } from '@shres-code/shres-code-shield/types'
import { Session, SessionId } from '@shres-code/shres-code-session'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'
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
  applied.throwOnApply = false
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
    expect(ctx.shield.snapshot().stats.screened).toBe(4)
  })

  it('stays inactive and does not apply the engine when SHRES_SHIELD=off', async () => {
    setEnv('SHRES_SHIELD', 'off')
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = await setup({ license: 'paid' }, 'panic')
    expect(ctx.shield.status).toEqual({ active: false, reason: 'panic' })
    expect(applied.count).toBe(0)
    expect(ctx.shield.snapshot().stats.screened).toBe(4)
  })

  it('passes the boot profile directory (ctx.baseUrl) into engine resolution', async () => {
    // Production boot anchors ctx.baseUrl at the profile directory; the seat
    // reads it to enable the profile-installed payload leg. The engine here
    // resolves via env (the fixture), but the baseUrl-defined branch runs.
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(dirname(fixtureUrl) + '/').href
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await provideApprovalAndJobs(ctx)
    await ctx.plugin(ShieldSeat, { license: 'paid' })
    await waitForReason(ctx, 'active')
    expect(ctx.shield.status.active).toBe(true)
    expect(applied.count).toBe(1)
  })

  it('returns persisted counts on a never-applied disabled seat', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = await setup({ enabled: false, license: 'paid' }, 'disabled')
    expect(applied.count).toBe(0)
    expect(ctx.shield.snapshot()).toMatchObject({
      status: { active: false, reason: 'disabled' },
      stats: { screened: 4, asked: 2, blocked: 1, observed: 1 },
    })
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
          byRule: {
            bad: 'no',
            empty: { observed: 'x', asked: 0, blocked: 0 },
            'sig.ok': { observed: 1, asked: 0, blocked: 2 },
          },
          otherRules: { observed: 0, asked: 1, blocked: 0 },
          recent: [
            null,
            { at: 'no', rule: 'x', channel: 'y', sha16: 'z', verdict: 'observe' },
            { at: 1, rule: 'x', channel: 'y', sha16: 'z', verdict: 'nope' },
            { at: 2, rule: 'ok', channel: 'user_message', sha16: '0123456789abcdef', verdict: 'observe' },
          ],
          definitions: { version: 'v1', stale: false, updatedAt: 'no' },
        }),
      },
    })
    const next = ctx.shield.snapshot()
    expect(next.stats.screened).toBe(1)
    expect(next.stats.recent).toHaveLength(1)
    expect(next.stats.byRule['sig.ok']).toEqual({ observed: 1, asked: 0, blocked: 2 })
    expect(next.stats.otherRules).toEqual({ observed: 0, asked: 1, blocked: 0 })
    expect(next.definitions).toBeUndefined()
  })

  it('drops a definition stamp whose version or stale field is the wrong type', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', '/no/such-shield-module.js')
    const ctx = await setup({ license: 'paid' }, 'engine-missing')
    ctx.shield.bindPayload({
      stats: {
        snapshot: () => ({
          stats: {
            screened: 1,
            observed: 0,
            asked: 0,
            blocked: 0,
          },
          definitions: { version: 1, stale: false, updatedAt: 0 },
        }),
      },
    })
    expect(ctx.shield.snapshot().definitions).toBeUndefined()
    ctx.shield.bindPayload({
      stats: {
        snapshot: () => ({
          stats: {
            screened: 2,
            observed: 0,
            asked: 0,
            blocked: 0,
          },
          definitions: { version: 'v1', stale: 'no', updatedAt: 0 },
        }),
      },
    })
    expect(ctx.shield.snapshot().definitions).toBeUndefined()
    expect(ctx.shield.snapshot().stats.screened).toBe(2)
  })

  it('drops a definition stamp whose updatedAt is not a number or null', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', '/no/such-shield-module.js')
    const ctx = await setup({ license: 'paid' }, 'engine-missing')
    ctx.shield.bindPayload({
      stats: {
        snapshot: () => ({
          stats: {
            screened: 1,
            observed: 0,
            asked: 0,
            blocked: 0,
          },
          definitions: { version: 'v1', stale: false, updatedAt: false },
        }),
      },
    })
    expect(ctx.shield.snapshot().definitions).toBeUndefined()
    expect(ctx.shield.snapshot().stats.screened).toBe(1)
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

  it('resolves cwd from list when get is absent', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', '/no/such-shield-module.js')
    const ctx = await setup({ license: 'paid' }, 'engine-missing')
    ctx.provide('sessions', {
      list: () => [{ header: { cwd: '/list-only' } }],
    })
    expect(ctx.shield.snapshot('no-get').stats.cwd).toBe('/list-only')
  })

  it('uses an empty session list when the store has no list method', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', '/no/such-shield-module.js')
    const ctx = await setup({ license: 'paid' }, 'engine-missing')
    ctx.provide('sessions', {
      get: () => undefined,
    })
    expect(ctx.shield.snapshot().stats.cwd).toBe(null)
  })

  it('keeps the last resolved cwd when listed sessions have none', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', '/no/such-shield-module.js')
    const ctx = await setup({ license: 'paid' }, 'engine-missing')
    let rows: Array<{ header: { cwd?: string } }> = [{ header: { cwd: '/list-only' } }]
    ctx.provide('sessions', { list: () => rows })
    expect(ctx.shield.snapshot().stats.cwd).toBe('/list-only')
    rows = [{ header: {} }]
    expect(ctx.shield.snapshot().stats.cwd).toBe('/list-only')
  })

  it('returns zeroed stats when SessionId resolution throws', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', '/no/such-shield-module.js')
    const ctx = await setup({ license: 'paid' }, 'engine-missing')
    ctx.provide('sessions', {
      get: () => {
        throw new Error('malformed session id')
      },
      list: () => [{ header: { cwd: '/listed' } }],
    })
    expect(ctx.shield.snapshot('!!!')).toEqual({
      status: { active: false, reason: 'engine-missing' },
      stats: ShieldSeat.emptyRepoStats(null),
    })
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

describe('shres-shield per-repo gate', () => {
  it('unmounts the engine when the only live session works in an exempt repo', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await provideApprovalAndJobs(ctx)
    ctx.provide('sessions', {
      get: () => undefined,
      list: () => [{ header: { cwd: '/exempt/repo' } }],
    })
    await ctx.plugin(ShieldSeat, { license: 'paid', repos: { '/exempt/repo': { enabled: false } } })
    await waitForReason(ctx, 'repo-disabled')
    expect(applied.count).toBe(0)
    expect(ctx.shield.status).toEqual({ active: false, reason: 'repo-disabled' })
    // Persisted counts survive the exemption exactly as a global disable.
    expect(ctx.shield.snapshot().stats.screened).toBe(4)
  })

  it('keeps the engine mounted while any live repo stays enabled', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await provideApprovalAndJobs(ctx)
    ctx.provide('sessions', {
      get: () => undefined,
      list: () => [{ header: { cwd: '/exempt/repo' } }, { header: { cwd: '/screened/repo' } }],
    })
    await ctx.plugin(ShieldSeat, {
      license: 'paid',
      repos: { '/exempt/repo': { enabled: false } },
    })
    await waitForReason(ctx, 'active')
    expect(applied.count).toBe(1)
  })

  it('keeps the global switch master over a repo entry', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await provideApprovalAndJobs(ctx)
    ctx.provide('sessions', { list: () => [{ header: { cwd: '/exempt/repo' } }] })
    await ctx.plugin(ShieldSeat, {
      license: 'paid',
      enabled: false,
      repos: { '/exempt/repo': { enabled: false } },
    })
    await waitForReason(ctx, 'disabled')
    expect(applied.count).toBe(0)
  })

  it('keeps diagnostics above the repo gate', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', '/no/such-shield-module.js')
    const ctx = await setup({ license: 'paid', repos: { '/exempt/repo': { enabled: false } } }, 'engine-missing')
    ctx.provide('sessions', { list: () => [{ header: { cwd: '/exempt/repo' } }] })
    expect(ctx.shield.snapshot().status).toEqual({ active: false, reason: 'engine-missing' })
  })

  it('unmounts through the snapshot pull when a disabled session appears late', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = await setup({ license: 'paid', repos: { '/exempt/repo': { enabled: false } } }, 'active')
    expect(applied.count).toBe(1)
    // No session/created push fires here; snapshot()'s pull re-evaluation
    // must flip the mount decision on its own.
    ctx.provide('sessions', { list: () => [{ header: { cwd: '/exempt/repo' } }] })
    ctx.shield.snapshot()
    await waitForReason(ctx, 'repo-disabled')
    expect(applied.disposed).toBe(1)
    expect(applied.count).toBe(1)
  })

  it('remounts through the snapshot pull when the exempt session goes away', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await provideApprovalAndJobs(ctx)
    let live = true
    ctx.provide('sessions', {
      list: () => live ? [{ header: { cwd: '/exempt/repo' } }] : [],
    })
    await ctx.plugin(ShieldSeat, { license: 'paid', repos: { '/exempt/repo': { enabled: false } } })
    await waitForReason(ctx, 'repo-disabled')
    expect(applied.count).toBe(0)
    live = false
    ctx.shield.snapshot()
    await waitForReason(ctx, 'active')
    expect(applied.count).toBe(1)
  })

  it('reports repo-disabled per repo in the snapshot while the engine screens others', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = await setup({
      license: 'paid',
      repos: { '/exempt/repo': { enabled: false } },
    }, 'active')
    expect(ctx.shield.status).toEqual({ active: true, reason: 'active' })
    // No live sessions: mount status is harness-wide truth, snapshot honest.
    expect(ctx.shield.snapshot().status).toEqual({ active: true, reason: 'active' })
    ctx.provide('sessions', {
      get: (id: SessionId) => id === SessionId('exempt') ? { header: { cwd: '/exempt/repo' } } : undefined,
      list: () => [{ header: { cwd: '/screened/repo' } }],
    })
    // The engine stays mounted for /screened/repo; the exempt session's
    // snapshot reports its own effective status.
    expect(ctx.shield.snapshot('exempt').status).toEqual({ active: false, reason: 'repo-disabled' })
    expect(ctx.shield.snapshot().status).toEqual({ active: true, reason: 'active' })
  })

  it('does not remount the engine on session events that leave the gate unchanged', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = await setup({ license: 'paid' }, 'active')
    expect(applied.count).toBe(1)
    ctx.emit('session/created', Session.create(SessionId('s-push')))
    ctx.emit('session/disposed', Session.create(SessionId('s-push')))
    await new Promise<void>((resolve) => { setTimeout(resolve, 80) })
    expect(applied.count).toBe(1)
    expect(applied.disposed).toBe(0)
    expect(ctx.shield.status).toEqual({ active: true, reason: 'active' })
  })

  it('remounts through the session-event push when the exempt sessions go away', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await provideApprovalAndJobs(ctx)
    let live = true
    ctx.provide('sessions', {
      list: () => live ? [{ header: { cwd: '/exempt/repo' } }] : [],
    })
    await ctx.plugin(ShieldSeat, { license: 'paid', repos: { '/exempt/repo': { enabled: false } } })
    await waitForReason(ctx, 'repo-disabled')
    expect(applied.count).toBe(0)
    live = false
    ctx.emit('session/disposed', Session.create(SessionId('s-exempt')))
    await waitForReason(ctx, 'active')
    expect(applied.count).toBe(1)
  })

  it('keeps diagnostics above the global switch when the engine is missing', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', '/no/such-shield-module.js')
    const ctx = await setup({ license: 'paid', enabled: false }, 'engine-missing')
    expect(ctx.shield.status).toEqual({ active: false, reason: 'engine-missing' })
    expect(applied.count).toBe(0)
  })

  it('refuses a repos write with a relative key through the settings service', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await provideApprovalAndJobs(ctx)
    const settingsFiber = ctx.plugin(MemorySettings)
    await settingsFiber.await()
    await ctx.plugin(ShieldSeat, { license: 'paid' })
    await waitForReason(ctx, 'active')
    await expect(ctx.settings.update(ShieldSeat.SHIELD_SETTINGS_NAMESPACE, {
      repos: { 'relative/path': { enabled: false } },
    })).rejects.toThrow(/absolute/)
    await ctx.settings.update(ShieldSeat.SHIELD_SETTINGS_NAMESPACE, { enabled: true })
    await ctx.fiber.dispose()
  })

  it('defaults omitted apply fields and an empty license string', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await provideApprovalAndJobs(ctx)
    ShieldSeat.apply(ctx, { license: '' })
    await waitForReason(ctx, 'active')
    expect(applied.config).toEqual({ posture: 'ask' })
    await ctx.fiber.dispose()
  })

  it('treats a throwing payload apply as a missing engine', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', fixtureUrl)
    applied.throwOnApply = true
    const ctx = await setup({ license: 'paid' }, 'engine-missing')
    expect(applied.count).toBe(0)
    expect(ctx.shield.status).toEqual({ active: false, reason: 'engine-missing' })
    await ctx.fiber.dispose()
  })

  it('disposes a seat that never mounted an engine instance', async () => {
    setEnv('SHRES_SHIELD', undefined)
    setEnv('SHRES_SHIELD_MODULE', '/no/such-shield-module.js')
    const ctx = await setup({ license: 'paid' }, 'engine-missing')
    await ctx.fiber.dispose()
    expect(applied.disposed).toBe(0)
  })
})

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}
