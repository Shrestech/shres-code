/** Global destinations preserve the resident draft at desktop and narrow widths. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

it('preserves a draft through Settings, Teams, and Customize and fits a narrow viewport', async () => {
  const scaffold = await launchWebScaffold({})
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1487, height: 1058 }, locale: 'en-US' })
  const tripwire = watchConsole(page)
  const captureDir = process.env.SHRES_UI_CAPTURE_DIR
  if (captureDir !== undefined) await mkdir(captureDir, { recursive: true })
  const capture = async (name: string) => {
    if (captureDir !== undefined) await page.screenshot({ path: join(captureDir, name + '.png') })
  }
  try {
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'shres-code')
    const composer = page.locator('textarea:enabled[placeholder="Describe what you want to build"]')
    await composer.fill('Keep this draft while I organize my workspace.')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('region', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Light', exact: true }).click()
    await expect.poll(() => settings.getByRole('button', { name: 'Light', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await composer.evaluate(element => element.closest('[inert]') !== null)).toBe(true)
    await settings.getByRole('button', { name: 'Standard mode', exact: true }).waitFor()
    await settings.getByRole('button', { name: 'Workspace Write', exact: true }).waitFor()
    await capture('implementation-settings')

    await settings.getByRole('button', { name: 'English', exact: true }).click()
    await page.getByRole('menu').waitFor()
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('menu').count()).toBe(0)
    expect(await settings.isVisible()).toBe(true)

    await page.getByRole('button', { name: 'Teams', exact: true }).click()
    const teams = page.getByRole('region', { name: 'Teams', exact: true })
    await teams.getByRole('heading', { name: 'Team members', exact: true }).waitFor()
    await teams.getByLabel('Aegis Provider').waitFor()
    await capture('implementation-teams')
    await page.getByRole('button', { name: 'Customize', exact: true }).click()
    await page.getByRole('region', { name: 'Customize', exact: true }).waitFor()
    await capture('implementation-customize')
    await page.getByRole('button', { name: 'Workspace', exact: true }).click()
    expect(await composer.inputValue()).toBe('Keep this draft while I organize my workspace.')
    expect(await composer.evaluate(element => element.closest('[inert]') !== null)).toBe(false)
    await capture('implementation-workspace')

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await settings.getByRole('button', { name: 'Dark', exact: true }).click()
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).not.toBeNull()
    await capture('implementation-dark')
    await settings.getByRole('button', { name: 'Light', exact: true }).click()
    await page.setViewportSize({ width: 1024, height: 800 })
    await capture('implementation-tablet')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.setViewportSize({ width: 390, height: 844 })
    await settings.getByRole('button', { name: 'Appearance', exact: true }).click()
    await settings.getByRole('button', { name: 'System', exact: true }).scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    for (const name of ['Workspace', 'Teams', 'Customize', 'Settings']) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(390)
    }
    await capture('implementation-mobile')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 90_000)
