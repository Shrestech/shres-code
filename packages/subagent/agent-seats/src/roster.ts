/**
 * Product roster for the three named Roos child seats. Tool names, labels,
 * and personas live here so the remount plugin and its tests share one table.
 * @module @roos-code/roos-code-agent-seats/roster
 */

/** Stable seat ids; each is also the model-facing tool name. */
export const SEAT_IDS = ['boomer', 'joey', 'flyer'] as const

/** One named seat the conductor can delegate to. */
export type SeatId = (typeof SEAT_IDS)[number]

/** Stored provider/model pair for one seat. Omitted fields leave the seat unbound. */
export interface SeatBinding {
  /** Live `ctx.llm` route id. */
  provider?: string
  /** Provider-owned model id on that route. */
  model?: string
}

/** User and composition document for the `agent-seats` settings section. */
export interface AgentSeatsSettings {
  /** Per-seat bindings; an omitted or empty seat stays unmounted. */
  seats?: Partial<Record<SeatId, SeatBinding>>
}

/** Fixed product copy and child defaults for one seat. */
export interface SeatRosterEntry {
  /** Seat id and tool name. */
  readonly id: SeatId
  /** Kangaroo display name written into child labels. */
  readonly label: string
  /** Role gloss shown next to the kangaroo name. */
  readonly role: string
  /** Short settings-page description of the role. */
  readonly hint: string
  /** Child `deployment:persona` text. */
  readonly persona: string
  /** Model-facing tool description before the shared background appendix. */
  readonly description: string
}

/** The three product seats in display order. */
export const SEAT_ROSTER: readonly SeatRosterEntry[] = [
  {
    id: 'boomer',
    label: 'Boomer',
    role: 'Architect',
    hint: 'Designs the approach and a concrete plan. Does not implement.',
    persona:
      'You are Boomer, the Architect. Design the approach, name the trade-offs, and return a concrete plan. '
      + 'Do not implement unless the parent explicitly asks you to. Stay in this workspace.',
    description:
      'Delegate design work to Boomer, the Architect seat — a separate Roos child with its own model in this workspace. '
      + 'Use it for architecture, trade-offs, and a concrete plan. Boomer does not implement. '
      + 'Give a complete standalone prompt; it does not see this conversation.',
  },
  {
    id: 'joey',
    label: 'Joey',
    role: 'Worker',
    hint: 'Implements a bounded piece of work in this workspace.',
    persona:
      'You are Joey, the Worker. Implement the assigned work in this workspace. Stay inside the given bound. '
      + 'Do not redesign the plan unless it is blocked.',
    description:
      'Delegate bounded implementation work to Joey, the Worker seat — a separate Roos child with its own model in this workspace. '
      + 'Use it to write or change code inside a stated bound. Give a complete standalone prompt; it does not see this conversation.',
  },
  {
    id: 'flyer',
    label: 'Flyer',
    role: 'Reviewer',
    hint: 'Reviews work and reports findings. Does not rewrite unless asked.',
    persona:
      'You are Flyer, the Reviewer. Review the assigned work for correctness, regressions, and missed cases. '
      + 'Report findings; do not rewrite unless the parent asks.',
    description:
      'Delegate review work to Flyer, the Reviewer seat — a separate Roos child with its own model in this workspace. '
      + 'Use it to review diffs, tests, and missed cases. Flyer reports findings and does not rewrite unless asked. '
      + 'Give a complete standalone prompt; it does not see this conversation.',
  },
]

/** A seat that has both a provider and a model, ready to remount. */
export interface BoundSeat {
  /** Roster row. */
  readonly entry: SeatRosterEntry
  /** Live provider route. */
  readonly provider: string
  /** Model id on that route. */
  readonly model: string
}

/**
 * Collect seats whose stored binding names both a provider and a model.
 * @param settings - resolved `agent-seats` document.
 * @returns bound seats in roster order.
 */
export function boundSeats(settings: AgentSeatsSettings): BoundSeat[] {
  const seats = settings.seats
  if (seats === undefined) return []
  const bound: BoundSeat[] = []
  for (const entry of SEAT_ROSTER) {
    const binding = seats[entry.id]
    const provider = binding?.provider?.trim()
    const model = binding?.model?.trim()
    if (provider === undefined || provider.length === 0) continue
    if (model === undefined || model.length === 0) continue
    bound.push({ entry, provider, model })
  }
  return bound
}
