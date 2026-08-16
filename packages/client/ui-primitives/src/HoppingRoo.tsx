import type { IconProps } from './icons/props.ts'
import { RooMarkGlyph, ROO_MARK_VIEWBOX } from './RooMark.tsx'
import css from './HoppingRoo.module.css'

/** Named product seats that color a hopping kangaroo. */
export const SEAT_IDS = ['boomer', 'joey', 'flyer'] as const

/** One named seat id. */
export type SeatId = (typeof SEAT_IDS)[number]

/** Distinct fill colors for each seat (ochre / green / blue). */
export const SEAT_COLORS: Record<SeatId, string> = {
  boomer: '#c9842a',
  joey: '#2f9e62',
  flyer: '#3b7dd8',
}

/**
 * Infer a seat from a tool name or catalog label (`Boomer: design the API`).
 * Role words such as `worker` are ignored so ad-hoc labels stay uncolored.
 * @param text - tool name, label, or title.
 * @returns the matching seat, or undefined.
 */
export function seatIdOf(text: string | undefined): SeatId | undefined {
  if (text === undefined || text.length === 0) return undefined
  const head = text.trim().split(/[\s:]+/, 1)[0]?.toLowerCase()
  return head === 'boomer' || head === 'joey' || head === 'flyer' ? head : undefined
}

/** Props for {@link HoppingRoo}. */
export interface HoppingRooProps extends IconProps {
  /** When true, play the hop cycle (default true). */
  hopping?: boolean | undefined
  /** Explicit fill; seat color wins when `seat` is set. */
  color?: string | undefined
  /** Product seat whose color to use. */
  seat?: SeatId | undefined
}

/**
 * Tiny kangaroo mark, optionally hopping, used while a child agent is working.
 * @param props.size - square edge in px (default 14).
 * @param props.hopping - whether to play the hop cycle.
 * @param props.seat - colors the mark for that product seat.
 * @param props.color - explicit fill when no seat is set.
 * @returns an aria-hidden svg (pair with visible running copy).
 */
export function HoppingRoo({
  size = 14, className, hopping = true, color, seat,
}: HoppingRooProps) {
  const fill = seat !== undefined ? SEAT_COLORS[seat] : color
  return (
    <svg
      width={size}
      height={size}
      className={[css.roo, hopping ? css.hop : '', className ?? ''].filter(value => value !== '').join(' ')}
      style={fill === undefined ? undefined : { color: fill }}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      data-hopping-roo={seat ?? 'generic'}
      {...hopping ? { 'data-state': 'ongoing' } : {}}
    >
      <svg x="1.2" y="1.2" width="21.6" height="21.6" viewBox={ROO_MARK_VIEWBOX} overflow="visible">
        <RooMarkGlyph />
      </svg>
    </svg>
  )
}
