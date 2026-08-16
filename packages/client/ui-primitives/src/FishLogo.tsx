import type { IconProps } from './icons/props.ts'
import { RooMarkGlyph, ROO_MARK_VIEWBOX } from './RooMark.tsx'

/**
 * Render the compact kangaroo mark used in the collapsed rail and empty hero.
 * @param props.size - square edge in px (default 24).
 * @param props.className - extra class for layout placement.
 * @returns the mark svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <svg x="1.2" y="1.2" width="21.6" height="21.6" viewBox={ROO_MARK_VIEWBOX} overflow="visible">
        <RooMarkGlyph />
      </svg>
    </svg>
  )
}
