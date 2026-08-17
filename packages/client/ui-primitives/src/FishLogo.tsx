import type { IconProps } from './icons/props.ts'
import { RooMarkGlyph, ROO_MARK_VIEWBOX, rooMarkWidthForHeight, shieldLockupAttr } from './RooMark.tsx'

/** Props for {@link FishLogo}. */
export interface FishLogoProps extends IconProps {
  /** Force the lockup on this mark. Omit to follow the Settings switch. */
  shieldActive?: boolean | undefined
}

/**
 * Render the compact fearless-girl mark used in the collapsed rail and empty hero.
 * @param props.size - drawn height in px (default 24); width follows the mark's native aspect.
 * @param props.className - extra class for layout placement.
 * @param props.shieldActive - force on/off; omit to follow the Settings switch.
 * @returns the mark svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function FishLogo({ size = 24, className, shieldActive }: FishLogoProps) {
  const height = size
  const width = rooMarkWidthForHeight(height)
  return (
    <svg
      width={width}
      height={height}
      className={className}
      viewBox={ROO_MARK_VIEWBOX}
      fill="none"
      aria-hidden="true"
      data-shres-shield={shieldLockupAttr(shieldActive)}
    >
      <RooMarkGlyph />
    </svg>
  )
}
