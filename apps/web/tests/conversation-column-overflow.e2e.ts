// Web e2e scenario: the conversation workspace keeps its composer and its
// controls inside the available column as the viewport narrows. The shell and
// composer use separate responsive tracks, so this sweep checks the rendered
// geometry at the same widths that previously exposed the removed hero art.
//
// The test uses a connected, empty workspace rather than a mock shell. That
// keeps the assertion tied to the real composer row: the text area, command
// launcher, access control, mode, voice, model, and send controls must remain
// usable while the page and conversation scroller keep horizontal overflow
// closed.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/conversation-column-overflow', import.meta.url))
/** Golden of the responsive workspace geometry, without platform-specific pixels. */
const GEOMETRY_EXPECTED = join(SNAPSHOT_DIR, 'geometry.expected.md')
const MODE = webSnapshotMode()
/** Narrow sweep stop used to exercise the compact composer controls. */
const CONTROL_VIEWPORT = 600
/** Existing viewport matrix spanning the desktop shell and compact composer. */
const WIDTHS = [1680, 1200, 1000, 800, CONTROL_VIEWPORT]

/** Measurements that describe one responsive workspace stop. */
interface ColumnMetrics {
  /** Viewport width at which the measurement was taken. */
  width: number
  /** Conversation column width used to wait for resize layout to settle. */
  columnWidth: number
  /** Horizontal overflow reported by the document. */
  pageOverflow: number
  /** Horizontal overflow reported by the conversation scroller. */
  conversationOverflow: number
  /** Resolved horizontal overflow mode for the conversation scroller. */
  overflowX: string
  /** True when the composer card stays inside the conversation column. */
  composerWithinColumn: boolean
  /** True when every visible composer control stays inside its owning surface. */
  controlsWithinComposer: boolean
  /** True when visible workspace-row controls stay inside the conversation column. */
  workspaceControlsWithinColumn: boolean
  /** Number of visible controls used to guard against a vacuous geometry pass. */
  visibleControlCount: number
}

/**
 * Measure the rendered workspace at the page's current viewport.
 * @param page - the connected workspace page under test.
 * @param width - the viewport width already applied, recorded with the reading.
 * @returns the stop's responsive geometry and control containment.
 */
function measureColumn(page: Page, width: number): Promise<ColumnMetrics> {
  return page.evaluate((viewportWidth) => {
    const scroller = document.querySelector<HTMLElement>('[data-conversation-scroll]')
    const composer = document.querySelector<HTMLElement>('[data-composer-card]')
    if (scroller === null) throw new Error('conversation scroll container not in the DOM')
    if (composer === null) throw new Error('composer card not in the DOM — the workspace is not connected')

    const scrollerBox = scroller.getBoundingClientRect()
    const composerBox = composer.getBoundingClientRect()
    const controls = [
      ...(composer.matches('button,select,textarea') ? [composer] : []),
      ...Array.from(composer.querySelectorAll<HTMLElement>('button,select,textarea')),
    ]
    const workspaceControls = Array.from(
      scroller.querySelectorAll<HTMLElement>('[class*="heroWorkspaceRow"] button, [class*="heroWorkspaceRow"] select'),
    )
    const visibleControls = controls.filter((element) => {
      const box = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    })
    const within = (inner: DOMRect, outer: DOMRect): boolean => (
      inner.left >= outer.left - 1
      && inner.right <= outer.right + 1
      && inner.top >= outer.top - 1
      && inner.bottom <= outer.bottom + 1
    )

    return {
      width: viewportWidth,
      columnWidth: scroller.getBoundingClientRect().width,
      pageOverflow: Math.max(
        0,
        Math.round(Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth),
      ),
      conversationOverflow: Math.max(0, Math.round(scroller.scrollWidth - scroller.clientWidth)),
      overflowX: getComputedStyle(scroller).overflowX,
      composerWithinColumn: within(composerBox, scrollerBox),
      controlsWithinComposer: visibleControls.every(control => within(control.getBoundingClientRect(), composerBox)),
      workspaceControlsWithinColumn: workspaceControls.every(control => within(control.getBoundingClientRect(), scrollerBox)),
      visibleControlCount: visibleControls.length,
    }
  }, width)
}

/**
 * Render the golden body from one shared sweep.
 * @param stops - measured viewport stops in {@link WIDTHS} order.
 * @returns the golden body without a trailing newline.
 */
function renderGeometry(stops: ColumnMetrics[]): string {
  return [
    '# Workspace conversation responsive geometry',
    '',
    '| viewport | page overflow | conversation overflow | overflow-x | composer within column | controls within composer | workspace controls within column | visible controls |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...stops.map(stop => `| ${String(stop.width)}px | ${String(stop.pageOverflow)}px | ${String(stop.conversationOverflow)}px `
      + `| ${stop.overflowX} | ${String(stop.composerWithinColumn)} | ${String(stop.controlsWithinComposer)} `
      + `| ${String(stop.workspaceControlsWithinColumn)} | ${String(stop.visibleControlCount)} |`),
  ].join('\n')
}

describe('web e2e: the conversation workspace fits its responsive column', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await newEnglishPage(browser, 900)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[data-conversation-scroll]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await page.waitForSelector('[data-conversation-scroll] [data-composer-card]', { timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /**
   * Resize to a viewport and read the workspace after its column width stops moving.
   * @param width - viewport width to settle at.
   * @returns the workspace readings at that width.
   */
  const settleAt = async (width: number): Promise<ColumnMetrics> => {
    await page.setViewportSize({ width, height: 900 })
    let previous = -1
    await expect.poll(async () => {
      const current = (await measureColumn(page, width)).columnWidth
      const settled = current === previous
      previous = current
      return settled
    }, { timeout: 10_000, interval: 50 }).toBe(true)
    await page.waitForTimeout(100)
    return measureColumn(page, width)
  }

  /** Memoized sweep shared by assertions and the golden. */
  let swept: Promise<ColumnMetrics[]> | undefined
  const sweep = (): Promise<ColumnMetrics[]> => {
    swept ??= (async () => {
      const stops: ColumnMetrics[] = []
      for (const width of WIDTHS) stops.push(await settleAt(width))
      return stops
    })()
    return swept
  }

  it('keeps the page, conversation column, and composer controls inside their widths', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-conversation-column-overflow'))
    const stops = await sweep()
    for (const stop of stops) {
      expect(stop.pageOverflow, `viewport ${String(stop.width)}`).toBe(0)
      expect(stop.conversationOverflow, `viewport ${String(stop.width)}`).toBe(0)
      expect(stop.overflowX, `viewport ${String(stop.width)}`).toBe('hidden')
      expect(stop.composerWithinColumn, `viewport ${String(stop.width)}`).toBe(true)
      expect(stop.controlsWithinComposer, `viewport ${String(stop.width)}`).toBe(true)
      expect(stop.workspaceControlsWithinColumn, `viewport ${String(stop.width)}`).toBe(true)
      expect(stop.visibleControlCount, `viewport ${String(stop.width)}`).toBeGreaterThan(0)
    }
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it('matches the committed workspace geometry golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-conversation-column-overflow-golden'))
    await compareOrRefreshGolden(GEOMETRY_EXPECTED, renderGeometry(await sweep()), MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it('commits exactly the fixtures it reads', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['geometry.expected.md'])
  })

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', () => {
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })
})
