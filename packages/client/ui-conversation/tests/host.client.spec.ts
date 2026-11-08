import { Context } from '@shres-code/cordis'
import { describe, expect, it } from 'vitest'
import { SettingsProvider, settingsNamespace, type SettingsNamespace } from '@shres-code/shres-code-settings'
import {
  Config, apply,
} from '@shres-code/shres-code-client-ui-conversation'
import {
  CONVERSATION_SETTINGS_NAMESPACE, DEFAULT_BUSY_ENTER_BEHAVIOR,
  DEFAULT_ESTIMATED_ROW_HEIGHT, DEFAULT_INITIAL_VIEWPORT_HEIGHT, DEFAULT_OVERSCAN_ROWS,
} from '../src/submission-settings.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

describe('ui-conversation host', () => {
  it('registers, validates, and disposes the durable busy-Enter preference', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply, Config })
    await fiber.await()
    const ns = settingsNamespace(CONVERSATION_SETTINGS_NAMESPACE)
    expect(ctx.settings.get(ns)).toEqual({
      busyEnter: DEFAULT_BUSY_ENTER_BEHAVIOR,
      overscanRows: DEFAULT_OVERSCAN_ROWS,
      estimatedRowHeight: DEFAULT_ESTIMATED_ROW_HEIGHT,
      initialViewportHeight: DEFAULT_INITIAL_VIEWPORT_HEIGHT,
    })
    await ctx.settings.update(ns, { busyEnter: 'steer' })
    expect(ctx.settings.get(ns)).toEqual({
      busyEnter: 'steer',
      overscanRows: DEFAULT_OVERSCAN_ROWS,
      estimatedRowHeight: DEFAULT_ESTIMATED_ROW_HEIGHT,
      initialViewportHeight: DEFAULT_INITIAL_VIEWPORT_HEIGHT,
    })
    await expect(ctx.settings.update(ns, { busyEnter: 'invalid' })).rejects.toThrow()
    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(ns)
  })

  it('resolves Host Chat defaults through the settings base layer', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply, Config }, {
      overscanRows: 4,
      estimatedRowHeight: 72,
      initialViewportHeight: 480,
    })
    await fiber.await()
    expect(ctx.settings.get(settingsNamespace(CONVERSATION_SETTINGS_NAMESPACE))).toEqual({
      busyEnter: DEFAULT_BUSY_ENTER_BEHAVIOR,
      overscanRows: 4,
      estimatedRowHeight: 72,
      initialViewportHeight: 480,
    })
    await fiber.dispose()
  })

  it('rejects invalid Host Chat tunables at the config boundary', () => {
    for (const config of [
      { overscanRows: -1 },
      { estimatedRowHeight: 0 },
      { initialViewportHeight: 0 },
    ]) {
      expect(() => Config(config)).toThrow()
    }
  })
})
