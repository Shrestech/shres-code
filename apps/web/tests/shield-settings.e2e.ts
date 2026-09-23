// Web e2e: Settings → Shield Plugin updates card in its idle state.
// Zero model calls. The card does not show installed/latest until Check,
// so the golden is independent of a sibling checkout or npm.
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

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/shield-settings', import.meta.url))
const IDLE_EXPECTED = join(SNAPSHOT_DIR, 'idle.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: Shield settings plugin-update card', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
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

  it('shows Check for updates on the idle Plugin updates card', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-shield-settings-idle'))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('region', { name: 'Settings' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Shield', exact: true }).click()
    const check = dialog.getByRole('button', { name: 'Check for updates' })
    await check.waitFor({ timeout: 10_000 })
    await expect.poll(async () => check.isEnabled(), { timeout: 5_000 }).toBe(true)
    const snapshot = await captureStableAria(page, '[aria-label="Plugin updates"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(IDLE_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('keeps the idle fixture inventory exact', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['idle.expected.md'])
  })
})
