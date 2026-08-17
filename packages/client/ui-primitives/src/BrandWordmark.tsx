import type { IconProps } from './icons/props.ts'
import { RooMarkGlyph, ROO_MARK_VIEWBOX, shieldLockupAttr } from './RooMark.tsx'

/** Props for {@link BrandWordmark}. */
export interface BrandWordmarkProps extends IconProps {
  /** Force the lockup on this mark. Omit to follow the Settings switch. */
  shieldActive?: boolean | undefined
}

const WORDMARK_WIDTH = 168
const WORDMARK_HEIGHT = 48

const WORDMARK_FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"

/**
 * Render the product lockup: fearless-girl mark + "SHRES" + CODE plate.
 * Lettering is live SVG text so the lockup cannot be misread as another brand.
 * @param props.size - height in px (default 48; width keeps the 168:48 ratio).
 * @param props.className - extra class for layout placement.
 * @param props.shieldActive - force on/off; omit to follow the Settings switch.
 * @returns the wordmark svg (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 48, className, shieldActive }: BrandWordmarkProps) {
  return (
    <svg
      width={(size * WORDMARK_WIDTH) / WORDMARK_HEIGHT}
      height={size}
      className={className}
      viewBox={`0 0 ${WORDMARK_WIDTH} ${WORDMARK_HEIGHT}`}
      fill="none"
      aria-hidden="true"
      data-shres-shield={shieldLockupAttr(shieldActive)}
    >
      <svg x="0" y="0" width="38" height="48" viewBox={ROO_MARK_VIEWBOX} overflow="hidden">
        <RooMarkGlyph />
      </svg>
      <text
        x="44"
        y="33"
        fill="currentColor"
        fontFamily={WORDMARK_FONT}
        fontSize="20"
        fontWeight="750"
        letterSpacing="0.4"
      >
        SHRES
      </text>
      <rect x="118" y="16" width="44" height="16" rx="2" fill="currentColor" />
      <text
        x="140"
        y="27.6"
        textAnchor="middle"
        fill="var(--dsw-alias-label-primary-inverted)"
        fontFamily={WORDMARK_FONT}
        fontSize="10"
        fontWeight="700"
        letterSpacing="1.2"
      >
        CODE
      </text>
    </svg>
  )
}
