import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import * as SettingsInvariant from '../src/invariant.ts'
import { settingsNamespace } from '../src/index.ts'
import { MemorySettings } from './memory.ts'

async function setup(withProvider: boolean): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SettingsInvariant)
  if (withProvider) await ctx.plugin(MemorySettings)
  return ctx
}

describe('settings invariants', () => {
  it('accepts the service registration events and fails forged ones', async () => {
    const ctx = await setup(true)
    const fiber = ctx.plugin({
      inject: ['settings'],
      apply: (child: Context) => {
        child.settings.register(settingsNamespace('ui-theme'), z.object({ theme: z.string().default('dark') }))
      },
    })
    await fiber
    expect(() => {
      ctx.emit('settings/registered', settingsNamespace('ui-theme'), { theme: 'forged' })
    }).toThrow(/authoritative/)
    expect(() => {
      ctx.emit('settings/registered', settingsNamespace('ghost'), {})
    }).toThrow(/unregistered/)
    expect(() => {
      ctx.emit('settings/unregistered', settingsNamespace('ui-theme'))
    }).toThrow(/still registered/)
    await fiber.dispose()
    expect(ctx.settings.get(settingsNamespace('ui-theme'))).toBeUndefined()
  })

  it('fails a settings/updated emission without a live settings service', async () => {
    const ctx = await setup(false)
    expect(() => {
      ctx.emit('settings/updated', settingsNamespace('ghost'), { a: 1 }, { a: 2 }, 'provider')
    }).toThrow(/without a live settings service/)
  })

  it('fails a settings/updated emission for an unregistered namespace', async () => {
    const ctx = await setup(true)
    expect(() => {
      ctx.emit('settings/updated', settingsNamespace('ghost'), { a: 1 }, { a: 2 }, 'provider')
    }).toThrow(/unregistered/)
  })

  it('fails a settings/updated emission without a resolved-value change', async () => {
    const ctx = await setup(true)
    ctx.settings.register(settingsNamespace('ui-theme'), z.object({
      theme: z.string().default('dark'),
    }))
    expect(() => {
      ctx.emit('settings/updated', settingsNamespace('ui-theme'), { theme: 'dark' }, { theme: 'dark' }, 'update')
    }).toThrow(/without a resolved-value change/)
  })

  it('fails a settings/updated emission whose value diverges from the authoritative state', async () => {
    const ctx = await setup(true)
    ctx.settings.register(settingsNamespace('ui-theme'), z.object({
      theme: z.string().default('dark'),
    }))
    // Fabricated next ≠ the service's current resolved value ({theme: 'dark'}).
    expect(() => {
      ctx.emit('settings/updated', settingsNamespace('ui-theme'), { theme: 'forged' }, { theme: 'dark' }, 'update')
    }).toThrow(/authoritative/)
  })
})
