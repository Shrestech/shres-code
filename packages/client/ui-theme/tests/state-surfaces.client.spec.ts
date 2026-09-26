/**
 * State-surface token contract, asserted against design-platform.css on disk.
 * The static scale is theme-inverted: each step is redefined under the dark
 * attribute so step 100 is the low-emphasis end in both themes. A state's
 * tertiary alias therefore names the same static step in light and dark; naming
 * a different step in dark inverts it a second time and paints a light surface
 * under the family's light dark-theme text.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** Custom-property definitions of one theme, name to raw value. */
type Definitions = ReadonlyMap<string, string>

const css = readFileSync(fileURLToPath(new URL('../src/styles/design-platform.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')

/** Selector of the light palette and of the dark palette ui-layout's ThemePresenter selects. */
const LIGHT = 'body'
const DARK = 'body[data-ds-dark-theme]'
/** WCAG 2.x AA minimum for normal-size text. */
const AA_TEXT = 4.5

/**
 * Collect every custom property declared by rules whose whole selector equals
 * `selector`, in source order, later declarations winning.
 * @param selector - exact rule selector.
 * @returns the property definitions.
 */
function definitionsOf(selector: string): Map<string, string> {
  const definitions = new Map<string, string>()
  for (const [, prelude = '', body = ''] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (prelude.trim() !== selector) continue
    for (const [, name = '', value = ''] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) definitions.set(name, value.trim())
  }
  return definitions
}

const light = definitionsOf(LIGHT)
/** The dark attribute overrides the body rule, so a token it leaves alone keeps its light definition. */
const dark: Definitions = new Map([...light, ...definitionsOf(DARK)])

/**
 * The static step an alias names directly.
 * @param theme - the theme's definitions.
 * @param alias - alias custom property.
 * @returns the `--dsw-static-*` name the alias reads.
 */
function staticStep(theme: Definitions, alias: string): string {
  const value = theme.get(alias)
  const step = value === undefined ? undefined : /^var\((--dsw-static-[\w-]+)\)$/.exec(value)?.[1]
  if (step === undefined) throw new Error(`${alias} does not name one static step: ${value}`)
  return step
}

/**
 * Resolve a token to its hex colour by following var() references.
 * @param theme - the theme's definitions.
 * @param token - custom property to resolve.
 * @returns the #rrggbb value the token paints.
 */
function resolve(theme: Definitions, token: string): string {
  const value = theme.get(token)
  if (value === undefined) throw new Error(`${token} is not defined`)
  const reference = /^var\((--[\w-]+)\)$/.exec(value)?.[1]
  if (reference !== undefined) return resolve(theme, reference)
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${token} resolves to ${value}, not #rrggbb`)
  return value
}

/** WCAG relative luminance of an #rrggbb colour. */
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio of two #rrggbb colours. */
function contrast(first: string, second: string): number {
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [number, number]
  return (high + 0.05) / (low + 0.05)
}

/** Every state family that declares a tertiary surface, scanned from the sheet. */
const families = [...light.keys()]
  .flatMap(name => /^--dsw-alias-state-([a-z]+)-tertiary$/.exec(name)?.slice(1) ?? [])

/** The family's text token: its label alias when it has one, otherwise its primary. */
const textOf = (family: string): string => light.has(`--dsw-alias-state-${family}-label`)
  ? `--dsw-alias-state-${family}-label`
  : `--dsw-alias-state-${family}-primary`

describe('state tertiary surfaces', () => {
  it('scans the families that declare a tertiary surface', () => {
    expect(families).toEqual(expect.arrayContaining(['warn']))
  })

  it.each(families)('%s-tertiary names the same static step in light and dark', (family) => {
    const alias = `--dsw-alias-state-${family}-tertiary`
    expect(staticStep(dark, alias)).toBe(staticStep(light, alias))
  })

  it.each(families)('%s-tertiary is darker than its text in dark', (family) => {
    const surface = resolve(dark, `--dsw-alias-state-${family}-tertiary`)
    expect(luminance(surface)).toBeLessThan(luminance(resolve(dark, textOf(family))))
  })

  it.each(families.filter(family => light.has(`--dsw-alias-state-${family}-label`)))(
    '%s label text on its tertiary surface meets WCAG AA in dark',
    (family) => {
      const ratio = contrast(
        resolve(dark, `--dsw-alias-state-${family}-label`),
        resolve(dark, `--dsw-alias-state-${family}-tertiary`),
      )
      expect(ratio).toBeGreaterThanOrEqual(AA_TEXT)
    },
  )
})
