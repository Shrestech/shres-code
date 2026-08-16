/**
 * Remount named `tool-subagent` spawn seats from the `agent-seats` settings
 * section. Each bound seat is one Roos child tool (`boomer`, `joey`, `flyer`)
 * with its own `agentOptions` provider/model. Unbound seats stay unmounted.
 * @module @roos-code/roos-code-agent-seats
 */

import type { Context } from '@roos-code/cordis'
import z from '@roos-code/schemastery'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@roos-code/roos-code-settings'
import * as ToolSubagent from '@roos-code/roos-code-tool-subagent'
import type { AgentSeatsSettings, BoundSeat, SeatBinding } from './roster.ts'
import { boundSeats } from './roster.ts'

export {
  boundSeats, SEAT_IDS, SEAT_ROSTER,
} from './roster.ts'
export type {
  AgentSeatsSettings, BoundSeat, SeatBinding, SeatId, SeatRosterEntry,
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
    boomer: seatBinding,
    joey: seatBinding,
    flyer: seatBinding,
  }),
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
 * Remount `boomer` / `joey` / `flyer` whenever the seats document changes.
 * @param ctx - host context that already has tools, subagents, and systemPrompt.
 * @param config - composition entry used as the settings base.
 */
export function apply(ctx: Context, config: Config): void {
  let source: () => AgentSeatsSettings = () => config
  let mounted: BoundSeat[] = []
  let disposeTools: (() => void) | undefined

  const remount = (): void => {
    const next = boundSeats(source())
    if (deepEqualJson(mounted, next)) return
    disposeTools?.()
    disposeTools = undefined
    mounted = next
    if (next.length === 0) return
    const fiber = ctx.plugin(function agentSeatsTools(child: Context) {
      for (const seat of next) {
        child.plugin(ToolSubagent, seatToolConfig(seat))
      }
    })
    disposeTools = () => { void fiber.dispose() }
  }

  installSettingsSection(ctx, AGENT_SEATS_SETTINGS_NAMESPACE, Config, { ...EMPTY_SEATS, ...config }, {
    setSource: (current) => { source = current },
    onChange: remount,
  })
  remount()
  ctx.effect(() => () => { disposeTools?.() }, 'agent-seats: withdraw tools')
}
