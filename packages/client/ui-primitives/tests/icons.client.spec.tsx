// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import * as primitives from '@shres-code/shres-code-client-ui-primitives'
import {
  IconApiOutline14, IconArchiveOutline20, IconFolderClose16, IconGoalOutline16, IconSendOutline16,
} from '@shres-code/shres-code-client-ui-primitives'

afterEach(cleanup)

// Icon components all share the IconProps signature; the barrel also exports
// non-icon atoms (different props shapes), so filter by prefix BEFORE typing.
const icons = Object.fromEntries(
  Object.entries(primitives).filter(([name]) => name.startsWith('Icon')),
) as Record<string, (p: primitives.IconProps) => React.JSX.Element>
const iconNames = Object.keys(icons)

describe('ic_ds_ icon set', () => {
  it('exports the full icon set (46 deepsuite + 20 figma extracts + six product glyphs outside those sets)', () => {
    expect(iconNames.length).toBe(72)
  })

  it.each(iconNames)('%s renders an svg with currentColor fills and no hardcoded palette', (name) => {
    const Icon = icons[name]!
    const { container } = render(<Icon />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    const markup = container.innerHTML
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}"/)
    expect(markup).toContain('currentColor')
  })

  it('size and className props land on the root svg', () => {
    const { container } = render(<IconSendOutline16 size={20} className="x" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('20')
    expect(svg.getAttribute('height')).toBe('20')
    expect(svg.classList.contains('x')).toBe(true)
  })

  it('each glyph defaults to its own drawn size, not one set-wide default', () => {
    const api = render(<IconApiOutline14 />)
    expect(api.container.querySelector('svg')!.getAttribute('width')).toBe('14')
    const folder = render(<IconFolderClose16 />)
    expect(folder.container.querySelector('svg')!.getAttribute('width')).toBe('16')
    const archive = render(<IconArchiveOutline20 />)
    expect(archive.container.querySelector('svg')!.getAttribute('width')).toBe('20')
  })

  it('renders reusable goal glyphs without document-global ids', () => {
    const { container } = render(<><IconGoalOutline16 /><IconGoalOutline16 /></>)
    expect(container.querySelector('[id]')).toBeNull()
    expect(container.querySelector('[clip-path]')).toBeNull()
  })
})

describe('FishLogo', () => {
  it('renders the product mark at the native aspect and inherits the document lockup', () => {
    const { container } = render(<primitives.FishLogo />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('19')
    expect(svg.getAttribute('height')).toBe('24')
    expect(svg.getAttribute('viewBox')).toBe('0 0 623 802')
    expect(svg.getAttribute('data-shres-shield')).toBeNull()
    expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(2)
    expect(container.textContent).toContain('S')
  })

  it('forces the lockup off when the seat is inactive', () => {
    const { container } = render(<primitives.FishLogo shieldActive={false} />)
    expect(container.querySelector('svg')!.getAttribute('data-shres-shield')).toBe('off')
    expect(container.innerHTML).toContain('currentColor')
  })
})

describe('HoppingRoo', () => {
  it('colors each seat and infers ids from prefixed labels', () => {
    expect(primitives.seatIdOf('Aegis: design the API')).toBe('aegis')
    expect(primitives.seatIdOf('stride')).toBe('stride')
    expect(primitives.seatIdOf('worker')).toBeUndefined()
    const { container } = render(<primitives.HoppingRoo seat="ward" hopping />)
    const svg = container.querySelector('[data-hopping-roo="ward"]')!
    expect(svg.getAttribute('data-state')).toBe('ongoing')
    expect((svg as SVGElement).style.color.replace(/\s/g, '')).toMatch(/#3b7dd8|rgb\(59,125,216\)/)
    const idle = render(<primitives.HoppingRoo hopping={false} />)
    const idleSvg = idle.container.querySelector('[data-hopping-roo="generic"]')!
    expect(idleSvg.getAttribute('data-state')).toBeNull()
    expect(idleSvg.getAttribute('class') ?? '').not.toMatch(/undefined/)
  })
})

describe('BrandWordmark', () => {
  it('renders live shres / CODE lettering and no leftover DeepSeek lockup', () => {
    const { container } = render(<primitives.BrandWordmark />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).toBe('0 0 168 48')
    expect(container.textContent).toContain('SHRES')
    expect(container.textContent).toContain('CODE')
    expect(container.textContent).not.toMatch(/deepseek/i)
    expect(container.textContent).not.toMatch(/harness/i)
    expect(container.querySelector('svg')!.getAttribute('data-shres-shield')).toBeNull()
  })
})
