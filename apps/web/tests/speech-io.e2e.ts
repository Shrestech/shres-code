// Keyless assembled-browser coverage for the speech I/O surface shipped in
// #24/#26/#27: General settings rows persist, the composer mic appears after
// a workspace connects, and the host speech seat is mounted. Zero model calls;
// this does not download Kokoro/Whisper weights or drive a real microphone.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SPEECH_SETTINGS_NAMESPACE } from '@shres-code/shres-code-speech'
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
    await dialog.getByText('Kokoro voice used for read-aloud', { exact: false }).waitFor({ timeout: 5_000 })

    const autoSubmit = dialog.getByText('Send after dictation', { exact: true })
      .locator('xpath=../..')
      .getByRole('button')
    await autoSubmit.waitFor({ timeout: 10_000 })
    await expect.poll(() => autoSubmit.textContent(), { timeout: 5_000 }).toBe('Off')
    expect(await autoSubmit.getAttribute('aria-pressed')).toBe('false')
    await scaffold.ctx.settings.mutate(SPEECH_SETTINGS_NAMESPACE, [
      { op: 'set', path: ['autoSubmitVoice'], value: true },
    ])
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/speech:[\s\S]*autoSubmitVoice:\s*true/)

    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect.poll(() => page.getByRole('dialog', { name: 'Settings' }).count(), { timeout: 5_000 }).toBe(0)

    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const mic = page.getByRole('button', { name: 'Dictate', exact: true })
    await mic.waitFor({ timeout: 10_000 })
    if (status.stt.kind !== 'ready') {
      expect(await mic.isDisabled()).toBe(true)
    }
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})
