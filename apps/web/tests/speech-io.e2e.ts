// Keyless assembled-browser coverage for the speech I/O surface shipped in
// #24/#26/#27: General settings rows persist, the composer mic appears after
// a workspace connects, and the host speech seat is mounted. Zero model calls;
// this does not download Kokoro/Whisper weights or drive a real microphone.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

describe('web e2e: speech I/O settings and composer mic', () => {
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

  it('mounts the speech seat, persists auto-submit, and shows the composer mic', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-speech-io'))
    const status = await scaffold.ctx.speech.status()
    expect(status.tts.kind === 'ready' || status.tts.kind === 'unavailable').toBe(true)
    expect(status.stt.kind === 'ready' || status.stt.kind === 'unavailable').toBe(true)

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.waitFor({ timeout: 10_000 })
    expect(await dialog.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('true')
    await dialog.getByText('Read-aloud voice', { exact: true }).waitFor({ timeout: 10_000 })
    await dialog.getByText('Send after dictation', { exact: true }).waitFor({ timeout: 10_000 })
    await dialog.getByText('Spoken language', { exact: true }).waitFor({ timeout: 10_000 })
    await dialog.getByText('Kokoro voice used for read-aloud', { exact: false }).waitFor({ timeout: 5_000 })

    const autoSubmit = dialog.getByText('Send after dictation', { exact: true })
      .locator('xpath=../..')
      .getByRole('button')
    await autoSubmit.waitFor({ timeout: 10_000 })
    await expect.poll(() => autoSubmit.textContent(), { timeout: 5_000 }).toBe('Off')
    expect(await autoSubmit.getAttribute('aria-pressed')).toBe('false')
    await autoSubmit.click()
    await expect.poll(() => autoSubmit.textContent(), { timeout: 5_000 }).toBe('On')
    expect(await autoSubmit.getAttribute('aria-pressed')).toBe('true')
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/speech:[\s\S]*autoSubmitVoice:\s*true/)

    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect.poll(() => page.getByRole('dialog', { name: 'Settings' }).count(), { timeout: 5_000 }).toBe(0)

    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const mic = page.getByRole('button', { name: 'Dictate', exact: true })
    await mic.waitFor({ timeout: 10_000 })
    expect(await mic.isDisabled()).toBe(false)
    expect(await page.getByRole('switch', { name: 'Turn Talk mode on' }).count()).toBe(0)
    await page.getByRole('switch', { name: 'Turn Game mode on' }).waitFor({ timeout: 10_000 })

    await mic.click()
    const offer = page.getByRole('dialog', { name: 'Hands-free Talk' })
    await offer.waitFor({ timeout: 10_000 })
    await expect.poll(() => offer.getByText('Speak an instruction').count(), { timeout: 5_000 }).toBe(1)
    await offer.getByRole('button', { name: 'Enable Talk mode' }).click()
    await expect.poll(() => page.getByRole('dialog', { name: 'Hands-free Talk' }).count(), { timeout: 5_000 }).toBe(0)
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 8_000 })
      .toMatch(/talkMode:\s*true/)
    await page.locator('[data-talk-deck]').waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Type instead' }).click()
    await page.getByRole('button', { name: 'Dictate', exact: true }).waitFor({ timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})
