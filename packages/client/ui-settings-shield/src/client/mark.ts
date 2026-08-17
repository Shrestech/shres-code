/** Publish the product-mark lockup from the Shield switch. */

/**
 * Set `html[data-shres-shield]` so every inherited mark updates without a remount.
 * @param enabled - true paints the blue girl / green shield; false is monochrome.
 */
export function publishShieldMark(enabled: boolean): void {
  document.documentElement.dataset.shresShield = enabled ? 'on' : 'off'
}
