import { describe, expect, it } from 'vitest'
import { Context } from '@roos-code/cordis'
import SystemPrompt from '@roos-code/roos-code-system-prompt'
import ToolRuntime from '@roos-code/roos-code-tools'
import SubagentRuntime from '@roos-code/roos-code-subagent'
import { SettingsProvider, type SettingsNamespace } from '@roos-code/roos-code-settings'
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
    expect(boundSeats({ seats: { boomer: { provider: 'ollama-cloud' } } })).toEqual([])
    expect(boundSeats({ seats: { boomer: { provider: '  ', model: 'x' } } })).toEqual([])
    const [boomer] = boundSeats({
      seats: { boomer: { provider: 'ollama-cloud', model: 'kimi-k3' } },
    })
    expect(boomer?.entry.id).toBe('boomer')
    expect(boomer?.provider).toBe('ollama-cloud')
    expect(boomer?.model).toBe('kimi-k3')
  })
})

describe('agent-seats remount', () => {
  it('registers no tools while every seat is unbound', async () => {
    const { ctx } = await boot()
    expect(toolNames(ctx).filter(name => name === 'boomer' || name === 'joey' || name === 'flyer')).toEqual([])
    await ctx.fiber.dispose()
  })

  it('remounts bound seats as named spawn tools and withdraws them when cleared', async () => {
    const { ctx } = await boot()
    await ctx.settings.replace(seats.AGENT_SEATS_SETTINGS_NAMESPACE, {
      seats: {
        boomer: { provider: 'ollama-cloud', model: 'kimi-k3' },
        flyer: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      },
    })
    expect(toolNames(ctx)).toEqual(expect.arrayContaining(['boomer', 'flyer']))
    expect(toolNames(ctx)).not.toContain('joey')
    const boomer = ctx.tools.schemas().find(schema => schema.name === 'boomer')
    expect(boomer?.description).toContain('Architect')
    expect(boomer?.description).toContain('does not implement')

    await ctx.settings.replace(seats.AGENT_SEATS_SETTINGS_NAMESPACE, { seats: {} })
    expect(toolNames(ctx).filter(name => name === 'boomer' || name === 'flyer')).toEqual([])
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
      seats: { boomer: { provider: 'ollama-cloud', model: 'kimi-k3' } },
    })
    expect(toolNames(ctx)).toContain('boomer')
    await fiber.dispose()
    expect(toolNames(ctx)).not.toContain('boomer')
    await ctx.fiber.dispose()
  })

  it('keeps roster labels aligned with the three product seats', () => {
    expect(SEAT_ROSTER.map(entry => [entry.id, entry.label, entry.role])).toEqual([
      ['boomer', 'Boomer', 'Architect'],
      ['joey', 'Joey', 'Worker'],
      ['flyer', 'Flyer', 'Reviewer'],
    ])
    expect(seats.seatToolConfig({
      entry: SEAT_ROSTER[0]!,
      provider: 'p',
      model: 'm',
    })).toMatchObject({
      provider: 'spawn',
      toolName: 'boomer',
      backgroundMode: 'continuable',
      labelPrefix: 'Boomer',
      agentOptions: { provider: 'p', model: 'm' },
    })
  })
})
