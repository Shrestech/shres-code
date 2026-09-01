// Keyless assembled-browser coverage for Settings → J-Space: the allow
// switch remounts the seat, Advisor on reveals provider/model pickers,
// the composer chip appears only while enabled, and chip-on opens the
// stock card into the dock. Zero model calls.
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@shres-code/shres-code-jspace'
// Type-only: the Context.workspaceRegistry augmentation the scaffold exposes.
import type {} from '@shres-code/shres-code-workspace'
import { settingsNamespace } from '@shres-code/shres-code-settings'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const CHIP_OFF = 'J-Space off, press to turn on'
const CHIP_ON = 'J-Space on, press to turn off'
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/jspace-settings', import.meta.url))
const ADVISOR_OFF_EXPECTED = join(SNAPSHOT_DIR, 'advisor-off.expected.md')
const ADVISOR_ON_EXPECTED = join(SNAPSHOT_DIR, 'advisor-on.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: J-Space settings remount', () => {
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

  async function openJspaceSection(): Promise<ReturnType<Page['getByRole']>> {
    if (await page.getByRole('dialog', { name: 'Settings' }).count() > 0) {
      await page.keyboard.press('Escape')
      await expect.poll(() => page.getByRole('dialog', { name: 'Settings' }).count(), { timeout: 5_000 }).toBe(0)
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'J-Space', exact: true }).click()
    await expect.poll(
      () => dialog.getByRole('button', { name: 'J-Space', exact: true }).getAttribute('aria-current'),
      { timeout: 5_000 },
    ).toBe('true')
    await dialog.getByText('J-Space is an allow switch', { exact: false }).waitFor({ timeout: 10_000 })
    return dialog
  }

  it('defaults off, remounts on, and shows the composer chip and stock dock', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-jspace-settings'))
    expect(scaffold.ctx.jspace.status.active).toBe(false)
    expect(await page.getByRole('button', { name: CHIP_OFF }).count()).toBe(0)

    const dialog = await openJspaceSection()
    const activate = dialog.getByRole('switch', { name: 'Activate' })
    await activate.waitFor({ timeout: 10_000 })
    expect(await activate.getAttribute('aria-checked')).toBe('false')
    const enableAdvisor = dialog.getByRole('switch', { name: 'Enable Advisor' })
    await enableAdvisor.waitFor({ timeout: 10_000 })
    expect(await enableAdvisor.getAttribute('aria-checked')).toBe('false')
    const offSnapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(ADVISOR_OFF_EXPECTED, offSnapshot, MODE)
    expect(offSnapshot).toContain('Enable Advisor')
    expect(offSnapshot).not.toContain('Advisor Provider')

    await activate.click()
    const disable = dialog.getByRole('switch', { name: 'Disable', exact: true })
    await disable.waitFor({ timeout: 10_000 })
    expect(await disable.getAttribute('aria-checked')).toBe('true')
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/jspace:[\s\S]*enabled: true/)
    await expect.poll(() => scaffold.ctx.jspace.status.active, { timeout: 5_000 }).toBe(true)

    await enableAdvisor.click()
    await dialog.getByRole('switch', { name: 'Disable Advisor' }).waitFor({ timeout: 10_000 })
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/jspace-advisor:[\s\S]*enabled: true/)
    await dialog.getByLabel('Advisor Provider').waitFor({ timeout: 10_000 })
    await dialog.getByLabel('Advisor Model').waitFor({ timeout: 10_000 })
    const onSnapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(ADVISOR_ON_EXPECTED, onSnapshot, MODE)
    expect(onSnapshot).toContain('Disable Advisor')
    expect(onSnapshot).toContain('Advisor Provider')
    expect(onSnapshot).toContain('Advisor Model')

    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect.poll(() => page.getByRole('dialog', { name: 'Settings' }).count(), { timeout: 5_000 }).toBe(0)

    const workspaceDir = join(scaffold.workspaceCwd, 'jspace-ws')
    await mkdir(workspaceDir, { recursive: true })
    await page.getByRole('button', { name: 'Add workspace' }).click()
    const picker = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await picker.waitFor({ timeout: 10_000 })
    await picker.getByRole('button', { name: 'Edit path' }).click()
    await picker.getByLabel('Edit path').fill(workspaceDir)
    await picker.getByLabel('Edit path').press('Enter')
    await picker.getByRole('button', { name: 'Open', exact: true }).click()
    await picker.waitFor({ state: 'hidden', timeout: 10_000 })
    await expect.poll(
      () => scaffold.ctx.workspaceRegistry.resolveByPath(workspaceDir),
      { timeout: 10_000 },
    ).not.toBeUndefined()

    const composer = page.getByPlaceholder('Describe what you want to build')
    await composer.waitFor({ timeout: 10_000 })
    const chipOff = page.getByRole('button', { name: CHIP_OFF })
    await chipOff.waitFor({ timeout: 10_000 })
    await chipOff.click()
    await page.getByRole('button', { name: CHIP_ON }).waitFor({ timeout: 10_000 })
    const dock = page.locator('[data-jspace-dock]')
    await dock.waitFor({ timeout: 10_000 })
    await expect.poll(() => dock.getByText('J-Space is on', { exact: true }).count(), { timeout: 5_000 }).toBe(1)
    await expect.poll(() => dock.getByText('State the first action', { exact: true }).count(), { timeout: 5_000 }).toBe(1)

    const afterSession = await openJspaceSection()
    await afterSession.getByRole('switch', { name: 'Disable', exact: true }).waitFor({ timeout: 10_000 })
    await afterSession.getByRole('button', { name: 'Close' }).click()
    await expect.poll(() => page.getByRole('dialog', { name: 'Settings' }).count(), { timeout: 5_000 }).toBe(0)

    await scaffold.ctx.settings.mutate(settingsNamespace('jspace'), [
      { op: 'set', path: ['enabled'], value: false },
    ])
    await expect.poll(() => page.getByRole('button', { name: CHIP_OFF }).count(), { timeout: 5_000 }).toBe(0)
    await expect.poll(() => page.locator('[data-jspace-dock]').count(), { timeout: 5_000 }).toBe(0)
    await expect.poll(() => scaffold.ctx.jspace.status.active, { timeout: 5_000 }).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('keeps the Advisor settings fixture inventory exact', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['advisor-off.expected.md', 'advisor-on.expected.md'])
  })
})
