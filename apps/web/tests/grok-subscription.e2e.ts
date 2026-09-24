/** Real settings-to-registry coverage for subscription X sharing; no model requests or credential readback. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@shres-code/shres-code-tools'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/grok-subscription', import.meta.url))
const X_TOOLS = ['x_keyword_search', 'x_semantic_search', 'x_user_search', 'x_thread_fetch']

describe('web e2e: Grok subscription X sharing', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let consoleWatch: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    consoleWatch = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  async function openCard() {
    const settings = page.getByRole('region', { name: 'Settings', exact: true })
    if (await settings.count() === 0) await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await settings.getByRole('button', { name: 'Models & providers', exact: true }).click()
    const card = settings.getByRole('region', { name: 'Grok subscription tools', exact: true })
    if (await card.count() === 0) {
      await settings.getByRole('button', { name: 'Edit Grok (subscription) (grok-session)', exact: true }).click()
    }
    await card.waitFor()
    return { settings, card }
  }

  function registeredXTools(): string[] {
    return X_TOOLS.filter(name => scaffold.ctx.tools.get(name) !== undefined)
  }

  it('lists the four tools and account requirements with sharing off by default', async () => {
    onTestFailed(() => saveFailureShot(page, 'grok-subscription-default'))
    const { settings, card } = await openCard()
    for (const name of X_TOOLS) expect(await card.getByText(name, { exact: true }).count()).toBe(1)
    expect(await card.getByRole('switch', { name: 'Share X search with Shres agents', exact: true }).getAttribute('aria-checked')).toBe('false')
    expect(await settings.getByRole('textbox', { name: 'API key', exact: true }).count()).toBe(0)
    expect(registeredXTools()).toEqual([])
    const snapshot = await captureStableAria(page, '[aria-label="Grok subscription tools"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'tools.expected.md'), snapshot, webSnapshotMode())
    await settings.getByRole('button', { name: 'Cancel', exact: true }).click()
  }, 60_000)

  it('adds and removes tools through the real card without restarting the host', async () => {
    onTestFailed(() => saveFailureShot(page, 'grok-subscription-sharing'))
    let { settings, card } = await openCard()
    await card.getByRole('switch', { name: 'Share X search with Shres agents', exact: true }).click()
    expect(registeredXTools()).toEqual([])
    await settings.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect.poll(registeredXTools, { timeout: 10_000 }).toEqual(X_TOOLS)

    ;({ settings, card } = await openCard())
    await card.getByRole('switch', { name: 'Hosted X search', exact: true }).click()
    const sharing = card.getByRole('switch', { name: 'Share X search with Shres agents', exact: true })
    expect(await sharing.isDisabled()).toBe(true)
    expect(await sharing.getAttribute('aria-checked')).toBe('false')
    await settings.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect.poll(registeredXTools, { timeout: 10_000 }).toEqual([])

    ;({ settings, card } = await openCard())
    await card.getByRole('switch', { name: 'Hosted X search', exact: true }).click()
    await settings.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect.poll(registeredXTools, { timeout: 10_000 }).toEqual(X_TOOLS)
    await settings.getByRole('switch', { name: 'Disable Grok (subscription) (grok-session)', exact: true }).click()
    await expect.poll(registeredXTools, { timeout: 10_000 }).toEqual([])
    await settings.getByRole('switch', { name: 'Enable Grok (subscription) (grok-session)', exact: true }).click()
    await expect.poll(registeredXTools, { timeout: 10_000 }).toEqual(X_TOOLS)

    ;({ settings, card } = await openCard())
    await card.getByRole('switch', { name: 'Share X search with Shres agents', exact: true }).click()
    await settings.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect.poll(registeredXTools, { timeout: 10_000 }).toEqual([])
    await page.reload({ waitUntil: 'load' })
    ;({ card } = await openCard())
    expect(await card.getByRole('switch', { name: 'Share X search with Shres agents', exact: true }).getAttribute('aria-checked')).toBe('false')
    expect(consoleWatch.pageErrors).toEqual([])
  }, 120_000)
})
