/**
 * Host-seat entitlement and resolve: panic, missing engine, unlicensed
 * package-source, env-module entitle, and dispose of the paid apply.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import * as ShieldSeat from '@shres-code/shres-code-shield'
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
})

/** Wait until the async resolve/apply effect has published a terminal reason. */
async function waitForReason(ctx: Context, reason: ShieldSeat.ShieldReason): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (ctx.shield.status.reason === reason) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
  throw new Error(`shield status stayed ${JSON.stringify(ctx.shield.status)}, wanted ${reason}`)
}

/** Mount prompt + tools + the seat and wait for resolve to settle. */
async function setup(config: ShieldSeat.Config = {}, reason?: ShieldSeat.ShieldReason): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ShieldSeat, config)
  if (reason !== undefined) await waitForReason(ctx, reason)
  return ctx
}

describe('shres-shield host seat', () => {
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
})
