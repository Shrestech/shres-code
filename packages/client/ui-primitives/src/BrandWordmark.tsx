import type { IconProps } from './icons/props.ts'
import { RooMarkGlyph, ROO_MARK_VIEWBOX } from './RooMark.tsx'

const WORDMARK_WIDTH = 142
const WORDMARK_HEIGHT = 32

const WORDMARK_FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"

/**
 * Render the product lockup: kangaroo mark + "ROOS" + CODE plate.
 * Lettering is live SVG text so the lockup cannot be misread as another brand.
 * @param props.size - height in px (default 32; width keeps the 142:32 ratio).
 * @param props.className - extra class for layout placement.
 * @returns the wordmark svg (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 32, className }: IconProps) {
  return (
    <svg
      width={(size * WORDMARK_WIDTH) / WORDMARK_HEIGHT}
      height={size}
      className={className}
      viewBox={`0 0 ${WORDMARK_WIDTH} ${WORDMARK_HEIGHT}`}
      fill="none"
      aria-hidden="true"
    >
      <svg x="0" y="1" width="30" height="30" viewBox={ROO_MARK_VIEWBOX} overflow="visible">
        <RooMarkGlyph />
      </svg>
      <text
        x="34"
        y="24"
        fill="currentColor"
        fontFamily={WORDMARK_FONT}
        fontSize="20"
        fontWeight="750"
        letterSpacing="0.4"
      >
        ROOS
      </text>
      <rect x="98" y="8" width="42" height="16" rx="2" fill="currentColor" />
      <text
        x="119"
        y="19.6"
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
