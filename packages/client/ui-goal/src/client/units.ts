/**
 * Discrete remaining-work units for the Goal fight strip. Incomplete todos
 * are the army when any exist. An absent, empty, or all-completed list
 * still draws a standing army so Game mode is not a girl in an empty box.
 * Remaining goal rounds stay unused: the default cap is 256, not unfinished work.
 */

/** Hard cap so the 36px strip stays readable. */
export const MAX_FIGHT_UNITS = 6

/** Placeholder army while the session has no incomplete todos. */
export const STANDING_ARMY = 4

/** Sprite family for one remaining unit. */
export type FightKind = 'zombie' | 'zombie-2' | 'zombie-lunge'

/** One remaining discrete unit drawn as a zombie. */
export interface FightUnit {
  /** Stable within one todo list rewrite. */
  readonly id: string
  /** Sprite variant. */
  readonly kind: FightKind
}

/**
 * Cycle sprite variants by remaining-unit index.
 * @param index - current remaining count before this push.
 * @returns the sprite family for that slot.
 */
function fightKindAt(index: number): FightKind {
  switch (index % 3) {
    case 0: return 'zombie'
    case 1: return 'zombie-2'
    default: return 'zombie-lunge'
  }
}

/**
 * Map the current todo list to at most {@link MAX_FIGHT_UNITS} remaining units.
 * Completed items are skipped. An absent, empty, or all-completed list
 * returns {@link STANDING_ARMY} placeholder units with stable `standing#`
 * ids so the arena stays populated until a real incomplete item exists.
 * @param todos - latest `todos` projection, or undefined/null when none exists.
 * @returns remaining units in list order, or the standing army.
 */
export function remainingFightUnits(
  todos: readonly { content: string; status: string }[] | null | undefined,
): FightUnit[] {
  const remaining: FightUnit[] = []
  if (Array.isArray(todos)) {
    const seen = new Map<string, number>()
    for (const item of todos) {
      if (item.status === 'completed') continue
      const n = seen.get(item.content) ?? 0
      seen.set(item.content, n + 1)
      remaining.push({
        id: `${item.content}#${String(n)}`,
        kind: fightKindAt(remaining.length),
      })
      if (remaining.length === MAX_FIGHT_UNITS) break
    }
  }
  if (remaining.length > 0) return remaining
  for (let i = 0; i < STANDING_ARMY; i++) {
    remaining.push({
      id: `standing#${String(i)}`,
      kind: fightKindAt(i),
    })
  }
  return remaining
}

/**
 * Format a non-negative duration as `m:ss`.
 * @param ms - elapsed milliseconds; negative values clamp to zero.
 * @returns clock text for the strip.
 */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
