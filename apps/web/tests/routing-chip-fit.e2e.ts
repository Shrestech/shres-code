// Web e2e scenario: the Auto routing chip's idle warnings fit the composer row.
// The seeds are the keyless headless idle recordings, candidate-equals-base and
// base-unlisted, each logged after a downgraded streak so the Restore control
// renders beside the warning. They are seeded cold with the model router
// composed on the host, so the chip renders purely from the log with ZERO model
// calls. At the default and a narrow composer width, no chip control or text
// overlaps the access-mode control or the model seat, the warning stays inside
// the composer row, and the warning keeps its full sentence in the tooltip and
// the accessible description whether or not it is truncated.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const snapshot = (name: string): string => fileURLToPath(
  new URL(`../../../examples/headless-agent/tests/snapshots/${name}/session.jsonl`, import.meta.url),
)
const ROUTER = fileURLToPath(new URL('../../../packages/llm/model-router/lib/index.js', import.meta.url))

/** The router composition of the candidate-equals-base recording; the chip reads only the logged decisions. */
const OVERLAY = `- insert:
    - id: model-router
      name: '${ROUTER}'
      config:
        initialMode: on
        candidates:
          - id: flash
            provider: deepseek-official
            model: deepseek-v4-flash
            description: a small, well-scoped change in familiar code
        routeFrom:
          - provider: deepseek-official
            model: deepseek-v4-pro
            objective: dollars
          - provider: deepseek-official
            model: deepseek-v4-flash
            objective: dollars
        downgradeThreshold: 0.7
        downgradeMargin: 0.5
        hold:
          minSteps: 3
        routeInstructions: Pick the cheapest route that can finish this turn.
        difficultyInstructions: Rate how much reasoning this turn needs.
`

/** One idle state: its seed, the prompt that finds it, and the chip copy it shows. */
interface Variant {
  readonly name: string
  readonly seed: string
  readonly prompt: string
  readonly warning: string
  readonly full: string
}

const VARIANTS: readonly Variant[] = [
  {
    name: 'candidate-equals-base',
    seed: 'model-router-idle',
    prompt: 'Reply once more on the routing target itself.',
    warning: 'Idle — already on target',
    full: 'Auto routing is idle — this session already runs the routing target',
  },
  {
    name: 'base-unlisted',
    seed: 'model-router-idle-unlisted',
    prompt: 'Reply once more on a model routing does not list.',
    warning: 'Idle — model not enabled',
    full: 'Auto routing is idle — not enabled for this model',
  },
]

/** Default desktop viewport, and a narrow one whose composer row cannot hold the whole warning. */
const WIDTHS = [
  { name: 'default', width: 1680, truncated: false },
  { name: 'narrow', width: 760, truncated: true },
] as const

/** Horizontal extent of one element in page coordinates. */
interface Extent {
  readonly label: string
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

/** Open the session whose prompts include `prompt`, from the sidebar search. */
async function openSession(page: Page, prompt: string): Promise<void> {
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  await page.getByRole('textbox', { name: 'Search sessions...', exact: true }).fill(prompt)
  const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  // Also runs in beforeAll, where expect.poll is unavailable.
  const deadline = Date.now() + 60_000
  while (await results.count() !== 1) {
    if (Date.now() > deadline) throw new Error(`search for "${prompt}" did not settle on one session`)
    await page.waitForTimeout(100)
  }
  await results.click()
}

/**
 * Measure the composer row's controls: the access-mode control, every routing
 * chip part, and the model seat, plus the row they share.
 * @param page - the page showing the idle session.
 * @param warning - the visible warning copy.
 * @returns the extents and the warning's clip state.
 */
async function measure(page: Page, warning: string): Promise<{
  row: Extent
  access: Extent
  model: Extent
  chip: Extent[]
  clip: { client: number; scroll: number }
}> {
  return await page.evaluate((warningText) => {
    const extent = (label: string, element: Element | null) => {
      if (element === null) throw new Error(`composer row has no ${label}`)
      const rect = element.getBoundingClientRect()
      return { label, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    }
    const access = document.querySelector('[aria-label^="Access mode, current"]')
    const model = document.querySelector('[aria-label^="Select model, current"]')
    const idle = [...document.querySelectorAll('span')].find(span => span.textContent === warningText) ?? null
    let row: Element | null = access
    while (row !== null && (model === null || !row.contains(model))) row = row.parentElement
    return {
      row: extent('composer row', row),
      access: extent('access-mode control', access),
      model: extent('model seat', model),
      chip: [
        extent('Auto chip', document.querySelector('[aria-label="Automatic model routing on, press to turn off"]')),
        extent('routing details', document.querySelector('[aria-label="Routing details…"]')),
        extent('idle warning', idle),
        extent('Restore', document.querySelector('[aria-label^="Restore strong model"]')),
      ],
      clip: { client: idle?.clientWidth ?? 0, scroll: idle?.scrollWidth ?? 0 },
    }
  }, warning)
}

/** Whether two extents share any area. */
const overlaps = (a: Extent, b: Extent): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

describe('web e2e: routing chip idle warnings fit the composer row', () => {
  let overlayDir: string
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    overlayDir = await mkdtemp(join(tmpdir(), 'shres-routing-chip-fit-'))
    const overlay = join(overlayDir, 'routing.overlay.yml')
    await writeFile(overlay, OVERLAY)
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    for (const variant of VARIANTS) {
      await seedSession(scaffold, await readFile(snapshot(variant.seed), 'utf8'), `chip-fit-${variant.name}`)
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    // Opening each cold seed once resumes it on the host; the chip is then read
    // from a fresh page load, where every session's routing projection is durable.
    for (const variant of VARIANTS) await openSession(page, variant.prompt)
    await page.reload({ waitUntil: 'load' })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (overlayDir !== undefined) await rm(overlayDir, { recursive: true, force: true })
  })

  for (const variant of VARIANTS) {
    it(`keeps the ${variant.name} warning clear of the access-mode control and the model seat`, async () => {
      onTestFailed(() => saveFailureShot(page, `routing-chip-fit-${variant.name}`))
      await page.setViewportSize({ width: WIDTHS[0].width, height: 1000 })
      await openSession(page, variant.prompt)
      const warning = page.getByText(variant.warning, { exact: true })
      await warning.waitFor({ timeout: 30_000 })
      expect(await warning.getAttribute('title')).toBe(variant.full)
      expect(await warning.evaluate((element) => {
        const id = element.getAttribute('aria-describedby')
        return id === null ? null : document.getElementById(id)?.textContent
      })).toBe(variant.full)

      for (const width of WIDTHS) {
        await page.setViewportSize({ width: width.width, height: 1000 })
        // The row re-lays out on resize; read it once the warning's width settles.
        let previous = -1
        await expect.poll(async () => {
          const current = (await measure(page, variant.warning)).clip.client
          const settled = current === previous
          previous = current
          return settled
        }, { timeout: 10_000, interval: 100 }).toBe(true)
        const layout = await measure(page, variant.warning)
        for (const part of layout.chip) {
          expect(overlaps(part, layout.access), `${width.name}: ${part.label} overlaps the access-mode control`).toBe(false)
          expect(overlaps(part, layout.model), `${width.name}: ${part.label} overlaps the model seat`).toBe(false)
          expect(part.right, `${width.name}: ${part.label} leaves the composer row`).toBeLessThanOrEqual(layout.row.right)
        }
        const [, , idle] = layout.chip
        expect(idle!.left, `${width.name}: the warning starts before the access-mode control ends`).toBeGreaterThanOrEqual(layout.access.right)
        if (width.truncated) {
          // Truncated with an ellipsis, and still wide enough to show and hover.
          expect(layout.clip.scroll, `${width.name}: the warning is not truncated`).toBeGreaterThan(layout.clip.client)
          expect(layout.clip.client, `${width.name}: the truncated warning vanished`).toBeGreaterThan(0)
        } else {
          expect(layout.clip.scroll, `${width.name}: the warning is truncated`).toBeLessThanOrEqual(layout.clip.client)
        }
      }
      expect(tripwire.pageErrors).toEqual([])
    }, 180_000)
  }
})
