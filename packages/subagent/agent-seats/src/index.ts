/**
 * Remount named product seats from the `agent-seats` settings section. Each
 * bound seat is one Shres child tool (`aegis`, `stride`, `ward`) with its own
 * `agentOptions` provider/model. When `ctx.agentTeams` is present the tools
 * provision then Team-steer; otherwise they remount as `tool-subagent`.
 * Unbound seats stay unmounted.
 * @module @shres-code/shres-code-agent-seats
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@shres-code/shres-code-settings'
import type {} from '@shres-code/shres-code-system-prompt'
import * as ToolSubagent from '@shres-code/shres-code-tool-subagent'
import type { AgentSeatsSettings, BoundSeat, SeatBinding } from './roster.ts'
import { assertExtras, boundSeats, boundSubagentSeat, seatUseGuidance } from './roster.ts'
import type { TeamRosterTemplateEntry } from '@shres-code/shres-code-agent-team'
import type { TeamService } from '@shres-code/shres-code-agent-team'
import { registerTeamSeatTool } from './team-seat-tool.ts'

export {
  assertExtras, boundSeats, boundSubagentSeat, SEAT_IDS, SEAT_ROSTER, seatUseGuidance,
} from './roster.ts'
export type {
  AgentSeatsSettings, BoundSeat, ExtraSeat, SeatBinding, SeatId, SeatRosterEntry,
} from './roster.ts'

export const name = 'agent-seats'
export const inject = ['tools', 'subagents', 'systemPrompt']

/** Settings namespace the Models seats card writes. */
export const AGENT_SEATS_SETTINGS_NAMESPACE = settingsNamespace('agent-seats')

const seatBinding: z<SeatBinding> = z.object({
  provider: z.string(),
  model: z.string(),
})

/** Plugin config and `agent-seats` settings schema. Seats default unbound. */
export interface Config extends AgentSeatsSettings {}

/** Runtime schema for the seats section. */
export const Config: z<Config> = z.object({
  seats: z.object({
    aegis: seatBinding,
    stride: seatBinding,
    ward: seatBinding,
    subagent: seatBinding,
  }),
  extras: z.array(z.object({
    name: z.string(),
    persona: z.string(),
    provider: z.string(),
    model: z.string(),
    role: z.string(),
  })),
})

/** Composition entry used as the settings base: every seat starts unbound. */
const EMPTY_SEATS: Config = {}

/**
 * Build the `tool-subagent` config for one bound seat.
 * @param seat - roster row plus the stored provider/model pair.
 * @returns a spawn tool instance config.
 */
export function seatToolConfig(seat: BoundSeat): ToolSubagent.Config {
  return {
    provider: 'spawn',
    toolName: seat.entry.id,
    backgroundMode: 'continuable',
    persona: seat.entry.persona,
    description: seat.entry.description,
    labelPrefix: seat.entry.label,
    agentOptions: { provider: seat.provider, model: seat.model },
  }
}

/**
 * Remount `aegis` / `stride` / `ward` whenever the seats document changes.
 * @param ctx - host context that already has tools, subagents, and systemPrompt.
 * @param config - composition entry used as the settings base.
 */
export function apply(ctx: Context, config: Config): void {
  let source: () => AgentSeatsSettings = () => config
  let mounted: BoundSeat[] = []
  let lastGeneric: SeatBinding | undefined
  let teamsPresent = false
  let disposeTools: (() => void) | undefined
  let disposeGeneric: (() => void) | undefined
  let disposeGuidance: (() => void) | undefined
  let lastGuidance = ''

  const syncGuidance = (bound: readonly BoundSeat[]): void => {
    const text = seatUseGuidance(bound)
    if (text === lastGuidance) return
    disposeGuidance?.()
    disposeGuidance = undefined
    lastGuidance = text
    if (text.length === 0) return
    disposeGuidance = ctx.systemPrompt.section({
      name: 'tool:agent-seats',
      order: 115,
      text,
    })
  }

  const remountGeneric = (generic: SeatBinding | undefined): void => {
    disposeGeneric?.()
    disposeGeneric = undefined
    const fiber = ctx.plugin(ToolSubagent, {
      provider: 'spawn',
      toolName: 'subagent',
      backgroundMode: 'continuable',
      ...generic?.provider !== undefined && generic.model !== undefined
        ? { agentOptions: { provider: generic.provider, model: generic.model } }
        : {},
    })
    disposeGeneric = () => { void fiber.dispose() }
  }

  const remount = (): void => {
    const settings = source()
    assertExtras(settings.extras)
    const next = boundSeats(settings)
    syncGuidance(next)
    const generic = boundSubagentSeat(settings)
    const teams = ctx.get('agentTeams') as TeamService | undefined
    const teamsReady = teams !== undefined
    if (
      deepEqualJson(mounted, next)
      && deepEqualJson(lastGeneric, generic)
      && teamsReady === teamsPresent
      && disposeGeneric !== undefined
      && (next.length === 0 || disposeTools !== undefined)
    ) {
      syncTemplate(settings)
      return
    }
    if (!deepEqualJson(lastGeneric, generic) || disposeGeneric === undefined) {
      remountGeneric(generic)
      lastGeneric = generic
    }
    if (deepEqualJson(mounted, next) && teamsReady === teamsPresent && disposeTools !== undefined) {
      syncTemplate(settings)
      return
    }
    disposeTools?.()
    disposeTools = undefined
    mounted = next
    teamsPresent = teamsReady
    if (next.length === 0) {
      syncTemplate(settings)
      return
    }
    const fiber = ctx.plugin(function agentSeatsTools(child: Context) {
      for (const seat of next) {
        if (teamsReady && teams !== undefined) registerTeamSeatTool(child, seat, teams)
        else child.plugin(ToolSubagent, seatToolConfig(seat))
      }
    })
    disposeTools = () => { void fiber.dispose() }
    syncTemplate(settings)
  }

  const syncTemplate = (settings: AgentSeatsSettings): void => {
    const teams = ctx.get('agentTeams')
    if (teams === undefined) return
    const entries: TeamRosterTemplateEntry[] = [
      ...boundSeats(settings).map(seat => ({
        name: seat.entry.id,
        description: seat.entry.role,
        persona: seat.entry.persona,
        provider: seat.provider,
        model: seat.model,
      })),
      ...assertExtras(settings.extras).map(extra => ({
        name: extra.name.trim(),
        description: extra.role ?? extra.name,
        persona: extra.persona,
        provider: extra.provider,
        model: extra.model,
      })),
    ]
    teams.setRosterTemplate(() => entries)
  }

  installSettingsSection(ctx, AGENT_SEATS_SETTINGS_NAMESPACE, Config, Object.assign({}, EMPTY_SEATS, config), {
    setSource: (current) => { source = current },
    onChange: () => { void remount() },
  })
  remount()
  ctx.inject(['agentTeams'], () => { remount() })
  ctx.effect(() => () => {
    disposeTools?.()
    disposeGeneric?.()
    disposeGuidance?.()
    lastGuidance = ''
  }, 'agent-seats: withdraw tools')
}
