// Web e2e: Settings › Model routing over a keyless judgment composition.
// Zero model calls. The page lists both engines with their honest states,
// switching the engine writes judgment.engine through the settings seam, and
// the egress badge follows the selected engine.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./model-routing-settings.overlay.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/model-routing-settings', import.meta.url))
const REMOTE_EXPECTED = join(SNAPSHOT_DIR, 'remote.expected.md')
const LOCAL_EXPECTED = join(SNAPSHOT_DIR, 'local.expected.md')
const MODE = webSnapshotMode()
const SECTION = 'section[aria-label="Model routing"]'

describe('web e2e: Settings › Model routing', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('lists the engines with their states and warns that the remote engine sends excerpts off this machine', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-model-routing-remote'))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('region', { name: 'Settings' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Model routing', exact: true }).click()
    const section = page.locator(SECTION)
    const engine = section.getByRole('combobox', { name: 'Engine' })
    await engine.waitFor({ timeout: 10_000 })
    await expect.poll(async () => section.getByText('Not configured', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(async () => section.getByText('Remote · egress', { exact: true }).count()).toBe(1)
    const snapshot = await captureStableAria(page, SECTION, scaffold.workspaceCwd)
    await compareOrRefreshGolden(REMOTE_EXPECTED, snapshot, MODE)
  })

  it('switches the engine through settings and shows the local egress badge', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-model-routing-local'))
    const section = page.locator(SECTION)
    await section.getByRole('combobox', { name: 'Engine' }).selectOption('shield')
    await expect.poll(async () => section.getByText('Local', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(async () => section.getByText('Remote · egress', { exact: true }).count()).toBe(0)
    await expect.poll(async () => section.getByText('Unavailable', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    const snapshot = await captureStableAria(page, SECTION, scaffold.workspaceCwd)
    await compareOrRefreshGolden(LOCAL_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('keeps the fixture inventory exact', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['local.expected.md', 'remote.expected.md'])
  })
})
