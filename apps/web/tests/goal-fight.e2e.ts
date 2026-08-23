// Keyless assembled-browser coverage for Game mode (#19/#20): the composer
// switch writes the `game` settings namespace, the fight arena appears on
// an active goal, and an empty todo list still draws the standing army.
// Zero model calls.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

describe('web e2e: Game mode fight bar', () => {
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

  it('toggles Game mode, opens a goal, and draws the standing army', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-goal-fight'))
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const gameWrap = page.locator('[data-game-mode]')
    await gameWrap.waitFor({ timeout: 10_000 })
    expect(await gameWrap.getAttribute('data-game-mode')).toBe('off')
    const turnOn = page.getByRole('switch', { name: 'Turn Game mode on' })
    await expect.poll(() => turnOn.isEnabled(), { timeout: 10_000 }).toBe(true)
    const input = page.getByPlaceholder('Describe what you want to build')
    await input.waitFor({ timeout: 10_000 })
    await input.fill('/goal hold the pass against an empty army')
    await input.press('Enter')
    const bar = page.locator('[data-goal-bar]')
    await bar.waitFor({ timeout: 10_000 })
    await expect.poll(() => bar.getByText('hold the pass against an empty army').count(), { timeout: 5_000 }).toBe(1)
    expect(await page.locator('[data-goal-fight]').count()).toBe(0)

    await turnOn.click()
    await page.getByRole('switch', { name: 'Turn Game mode off' }).waitFor({ timeout: 10_000 })
    expect(await gameWrap.getAttribute('data-game-mode')).toBe('on')
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/game:[\s\S]*enabled:\s*true/)

    const arena = page.locator('[data-goal-fight]')
    await arena.waitFor({ state: 'attached', timeout: 10_000 })
    await expect.poll(() => page.locator('[data-goal-fight] [data-unit^="standing#"]').count(), { timeout: 5_000 }).toBe(4)
    expect(await page.locator('[data-goal-fight] [data-unit="standing#0"]').count()).toBe(1)
    expect(await page.locator('[data-goal-fight] img[data-pose]').count()).toBe(1)

    await page.getByRole('switch', { name: 'Turn Game mode off' }).click()
    await turnOn.waitFor({ timeout: 10_000 })
    await expect.poll(() => page.locator('[data-goal-fight]').count(), { timeout: 5_000 }).toBe(0)
    expect(await page.locator('[data-goal-bar]').count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})
