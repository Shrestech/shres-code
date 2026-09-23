// Playwright brand-acceptance: every user-visible product identity string on
// the shipped web composition must say Shres, never Roos.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  launchWebScaffold, watchConsole, webSnapshotMode, WELCOME_NOTICE_COPY,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()

const RETIRED = /\bRoos\b|@roos-code|\bROOS_[A-Z]|~\/\.roos\b|__ROOS_BOOT__/
const SHRES_TITLE = 'Shres Code'

interface BootGlobal {
  __SHRES_BOOT__?: { rev: string }
  __ROOS_BOOT__?: unknown
}

describe.skipIf(MODE === 'record')('web e2e: Shres Code rebrand chrome', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ welcomeNoticePending: true })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('#root', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('boots Shres identity: title, boot global, favicon, and PWA manifest', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-brand-boot'))
    await expect.poll(() => page.title(), { timeout: 15_000 }).toBe(SHRES_TITLE)

    const boot = await page.evaluate(() => {
      const win = window as unknown as BootGlobal
      return {
        title: document.title,
        hasShresBoot: win.__SHRES_BOOT__ !== undefined && typeof win.__SHRES_BOOT__.rev === 'string',
        hasRoosBoot: win.__ROOS_BOOT__ !== undefined,
        favicon: document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href ?? '',
        manifest: document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href ?? '',
      }
    })
    expect(boot.title).toBe(SHRES_TITLE)
    expect(boot.hasShresBoot).toBe(true)
    expect(boot.hasRoosBoot).toBe(false)
    expect(boot.favicon).toContain('/favicon.svg')
    expect(boot.favicon).toContain('v=shres4')
    expect(boot.manifest).toContain('/manifest.webmanifest')

    const manifestResponse = await page.request.get(new URL('/manifest.webmanifest', scaffold.baseUrl).href)
    expect(manifestResponse.ok()).toBe(true)
    expect(await manifestResponse.json()).toMatchObject({
      name: 'Shres Code',
      short_name: 'Shres',
      icons: [{ src: '/favicon.svg?v=shres4' }],
    })

    const faviconResponse = await page.request.get(new URL('/favicon.svg?v=shres4', scaffold.baseUrl).href)
    expect(faviconResponse.ok()).toBe(true)
    const favicon = await faviconResponse.text()
    expect(favicon).toContain('class="shield"')
    expect(favicon).toContain('>S</text>')
    expect(favicon).toMatch(/prefers-color-scheme:\s*dark/)
    expect(favicon).not.toMatch(RETIRED)
  })

  it('shows the Shres welcome notice and no retired Roos copy', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-brand-welcome'))
    const welcome = page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.title })
    await welcome.waitFor({ timeout: 15_000 })
    const copy = await welcome.innerText()
    expect(copy).toContain('Shres Code')
    expect(copy).toContain('Shres plugin ecosystem')
    expect(copy).not.toMatch(RETIRED)
    expect(WELCOME_NOTICE_COPY.body).toContain('Shres Code')
    expect(WELCOME_NOTICE_COPY.body).not.toMatch(RETIRED)

    await welcome.getByRole('button', { name: WELCOME_NOTICE_COPY.continueLabel }).click()
    await welcome.waitFor({ state: 'detached', timeout: 15_000 })
  })

  it('renders workspace chrome and settings without Roos identity', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-brand-chrome'))
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)

    const frameText = await page.locator('#root').innerText()
    expect(frameText).not.toMatch(RETIRED)
    expect(await page.getByRole('button', { name: 'Settings', exact: true }).count()).toBeGreaterThan(0)
    expect(await page.getByRole('textbox', { name: 'Describe what you want to build' }).count()).toBe(1)

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('region', { name: 'Settings' })
    await settings.waitFor({ timeout: 10_000 })
    const settingsText = await settings.innerText()
    expect(settingsText).not.toMatch(RETIRED)
    await settings.getByRole('button', { name: 'Close' }).click()
    await settings.waitFor({ state: 'detached', timeout: 10_000 })

    const html = await page.content()
    expect(html).not.toMatch(RETIRED)
    expect(tripwire.pageErrors).toEqual([])
  })
})
