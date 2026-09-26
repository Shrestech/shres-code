// Web e2e scenario: Settings › Model routing's workspace overview. Keyless
// and with zero model calls: the overlay composes the dispatcher, one honest
// engine, and the router, the seed is the keyless headless model-routing
// recording, and the shipped web bundle's workspace registry accounts it. The
// card rolls that session's statistics up, states its refresh cadence, and
// hands the session to its Routing view; the range toggle re-reads.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'
// Type-only: pulls the workspace registry's ServiceMap augmentation, so the
// host-side setup reads `ctx.get('workspaceRegistry')` by its declared type.
import type {} from '@shres-code/shres-code-workspace'

const OVERLAY = fileURLToPath(new URL('./routing-overview.overlay.yml', import.meta.url))
const SEED = fileURLToPath(new URL('../../../examples/headless-agent/tests/snapshots/model-router-step/session.jsonl', import.meta.url))
const SEED_ID = 'routing-overview-web-e2e'
const PROMPT = 'Inspect the supplied evidence with the bash tool, then answer briefly.'
const SECTION = 'section[aria-label="Model routing"]'

/** Open the seeded session from the sidebar search. */
async function openSeed(page: Page): Promise<void> {
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  await page.getByRole('textbox', { name: 'Search sessions...', exact: true }).fill(PROMPT)
  const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => results.count(), { timeout: 60_000 }).toBe(1)
  await results.click()
  await page.getByRole('button', { name: 'Activity', exact: true }).waitFor({ timeout: 30_000 })
}

/** Open Settings and land on the Model routing page. */
async function openRoutingSettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('region', { name: 'Settings' })
  await dialog.waitFor({ timeout: 10_000 })
  await dialog.getByRole('button', { name: 'Model routing', exact: true }).click()
  return page.locator(SECTION)
}

describe('web e2e: Settings › Model routing workspace overview', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    const seeded = await seedSession(scaffold, await readFile(SEED, 'utf8'), SEED_ID)
    // The workspace sits at the seeded session's cwd and accounts it, so the
    // Settings page reads it without the browser connecting anything.
    const registry = scaffold.ctx.get('workspaceRegistry')
    if (registry === undefined) throw new Error('the web scaffold composes no workspace registry')
    const workspace = await registry.create(scaffold.workspaceCwd)
    await workspace.attachSession(seeded)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('rolls the seeded session into the overview and hands a row to its Routing view', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-routing-overview'))
    // Loading the session once gives the rollup its live value (and warms the
    // persisted projection cache behind it).
    await openSeed(page)

    const section = await openRoutingSettings(page)
    const overview = section.locator('section:has(h3:text("Workspace overview"))')
    await overview.waitFor({ timeout: 15_000 })
    // The recorded session's decisions carry their original epoch times, so
    // the default 24h range excludes them; All is the honest view of a seed.
    await overview.getByRole('radio', { name: 'All' }).click()
    // The seeded session's own numbers, not an empty rollup: its two consults
    // answered, its row listed, and the range footer counts it in.
    await expect.poll(async () => overview.getByText('2 answered by the judge').count(), { timeout: 15_000 }).toBe(1)
    expect(await overview.getByText('Sessions with routing').count()).toBe(1)
    // "Decisions" names the KPI and the table column alike.
    const decisions = overview.getByText('Decisions', { exact: true })
    expect(await decisions.count()).toBe(2)
    // The session table names the one routed session and offers its view.
    const table = overview.getByRole('table', { name: 'Sessions, most recent decision first' })
    await table.waitFor({ timeout: 10_000 })
    expect(await table.getByRole('row').count()).toBe(2)
    await expect.poll(async () => overview.locator('p', { hasText: '1 of 1 sessions in range' }).count()).toBe(1)
    // The footer states the cadence this scenario never waits out.
    expect(await overview.locator('p', { hasText: 'refreshes every 60 s while visible.' }).count()).toBe(1)
    expect(await overview.getByText(/most recently routed sessions are included/).count()).toBe(0)

    // A row hands the session to its Routing view: the reveal lands on the
    // already-mounted session and Settings closes.
    await table.getByRole('button', { name: /Open the Routing view of/ }).click()
    await page.getByRole('heading', { name: 'Routing', level: 2 }).waitFor({ timeout: 30_000 })
    await expect.poll(async () => page.locator('[data-kpi="decisions"]').textContent()).toContain('Decisions2')
    expect(await page.locator(SECTION).count()).toBe(0)

    // Reopening Settings re-watches the workspace; the range toggle re-reads.
    const reopened = await openRoutingSettings(page)
    const reopenedOverview = reopened.locator('section:has(h3:text("Workspace overview"))')
    await reopenedOverview.getByRole('radio', { name: 'All' }).click()
    await expect.poll(async () => reopenedOverview.locator('p', { hasText: '1 of 1 sessions in range' }).count(), { timeout: 15_000 }).toBe(1)
    await reopenedOverview.getByRole('radio', { name: '7d' }).click()
    await expect.poll(async () => reopenedOverview.getByRole('radio', { name: '7d' }).getAttribute('aria-checked'), { timeout: 10_000 }).toBe('true')
    expect(tripwire.pageErrors).toEqual([])
  }, 180_000)
})
