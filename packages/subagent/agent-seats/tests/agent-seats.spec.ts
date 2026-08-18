import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import SubagentRuntime from '@shres-code/shres-code-subagent'
import z from '@shres-code/schemastery'
import { SettingsProvider, settingsNamespace, type SettingsNamespace } from '@shres-code/shres-code-settings'
import * as seats from '../src/index.ts'
import { boundSeats, SEAT_ROSTER } from '../src/roster.ts'

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

function registerSpawn(ctx: Context): void {
  ctx.subagents.registerProvider({
    name: 'spawn',
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    start: async () => {
      throw new Error('agent-seats tests do not start children')
    },
    prepareContinuable: async () => ({}),
  })
}

async function boot(entry: seats.Config = {}): Promise<{ ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  registerSpawn(ctx)
  await ctx.plugin(seats, entry)
  return { ctx }
}

function toolNames(ctx: Context): string[] {
  return ctx.tools.schemas().map(schema => schema.name)
}

describe('boundSeats', () => {
  it('keeps a seat off until both provider and model are set', () => {
    expect(boundSeats({})).toEqual([])
    expect(boundSeats({ seats: { aegis: { provider: 'ollama-cloud' } } })).toEqual([])
    expect(boundSeats({ seats: { aegis: { provider: '  ', model: 'x' } } })).toEqual([])
    const [aegis] = boundSeats({
      seats: { aegis: { provider: 'ollama-cloud', model: 'kimi-k3' } },
    })
    expect(aegis?.entry.id).toBe('aegis')
    expect(aegis?.provider).toBe('ollama-cloud')
    expect(aegis?.model).toBe('kimi-k3')
  })
})

describe('agent-seats remount', () => {
  it('registers no tools while every seat is unbound', async () => {
    const { ctx } = await boot()
    expect(toolNames(ctx).filter(name => name === 'aegis' || name === 'stride' || name === 'ward')).toEqual([])
    await ctx.fiber.dispose()
  })

  it('remounts bound seats as named spawn tools and withdraws them when cleared', async () => {
    const { ctx } = await boot()
    await ctx.settings.replace(seats.AGENT_SEATS_SETTINGS_NAMESPACE, {
      seats: {
        aegis: { provider: 'ollama-cloud', model: 'kimi-k3' },
        ward: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      },
    })
    expect(toolNames(ctx)).toEqual(expect.arrayContaining(['aegis', 'ward']))
    expect(toolNames(ctx)).not.toContain('stride')
    const aegis = ctx.tools.schemas().find(schema => schema.name === 'aegis')
    expect(aegis?.description).toContain('Architect')
    expect(aegis?.description).toContain('does not implement')

    await ctx.settings.replace(seats.AGENT_SEATS_SETTINGS_NAMESPACE, { seats: {} })
    expect(toolNames(ctx).filter(name => name === 'aegis' || name === 'ward')).toEqual([])
    await ctx.fiber.dispose()
  })

  it('withdraws seat tools when the seats plugin fiber disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    registerSpawn(ctx)
    const fiber = await ctx.plugin(seats, {
      seats: { aegis: { provider: 'ollama-cloud', model: 'kimi-k3' } },
    })
    expect(toolNames(ctx)).toContain('aegis')
    await fiber.dispose()
    expect(toolNames(ctx)).not.toContain('aegis')
    await ctx.fiber.dispose()
  })

  it('one settings namespace tolerates one live registration, so seats stay host-plane', async () => {
    // `SettingsProvider.register` fails loud on a duplicate namespace, and the
    // duplicate lands on Cordis's async injection fiber, not the plugin load —
    // racy, not a clean rejection. A per-preset agent-seats row would apply
    // once per composed scope (a concurrent session, or every in-process
    // subagent child joining its parent's preset). This pins the constraint
    // that keeps the plugin in the base bundle, never in an agent preset.
    const { ctx } = await boot()
    const service = ctx.get('settings')
    expect(service).toBeDefined()
    const probe = settingsNamespace('agent-seats-duplicate-probe')
    service!.register(probe, z.object({}))
    expect(() => service!.register(probe, z.object({}))).toThrow(/already registered/)
  })

  it('keeps roster labels aligned with the three product seats', () => {
    expect(SEAT_ROSTER.map(entry => [entry.id, entry.label, entry.role])).toEqual([
      ['aegis', 'Aegis', 'Architect'],
      ['stride', 'Stride', 'Worker'],
      ['ward', 'Ward', 'Reviewer'],
    ])
    expect(seats.seatToolConfig({
      entry: SEAT_ROSTER[0]!,
      provider: 'p',
      model: 'm',
    })).toMatchObject({
      provider: 'spawn',
      toolName: 'aegis',
      backgroundMode: 'continuable',
      labelPrefix: 'Aegis',
      agentOptions: { provider: 'p', model: 'm' },
    })
  })
})
