// Web e2e scenario: the configurable tab in Plugins settings — the cards a
// deployment's exposed host-plane namespaces produce, one field edited through the real
// wire down to `$SHRES_HOME/settings.yaml`, and the override badge and reset
// that layering produces. Zero model calls: everything is client state plus
// the settings document on a blank frame, so there is no fixture and a stray
// stream would fail loud on the open llm seam.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { join } from 'node:path'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/plugin-config', import.meta.url))
const SECTION_EXPECTED = join(SNAPSHOT_DIR, 'section.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: plugin configuration section', () => {
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

  /** Open the global Customize destination on the Plugins section. */
  async function openPlugins() {
    if (await page.getByRole('region', { name: 'Customize' }).count() > 0) {
      await page.keyboard.press('Escape')
      await expect.poll(() => page.getByRole('region', { name: 'Customize' }).count(), { timeout: 5_000 }).toBe(0)
    }
    await page.getByRole('button', { name: 'Customize', exact: true }).click()
    const dialog = page.getByRole('region', { name: 'Customize' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Plugins', exact: true }).click()
    await expect
      .poll(() => dialog.getByRole('button', { name: 'Plugins', exact: true }).getAttribute('aria-current'), { timeout: 5_000 })
      .toBe('page')
    await expect
      .poll(() => dialog.getByRole('tab', { name: 'Plugin configuration', exact: true }).getAttribute('aria-selected'), { timeout: 5_000 })
      .toBe('true')
    return dialog
  }

  /** The settings document as the Host has written it so far. */
  async function settingsDocument(): Promise<string> {
    return readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8').catch(() => '')
  }

  it('shows one card per exposed host-plane namespace', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-cards'))
    const dialog = await openPlugins()

    // Every card the shipped web composition exposes: the shell executor, the
    // agent loop, and the DeepSeek search provider.
    await dialog.getByText('Shell', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await dialog.getByText('Agent loop', { exact: true }).count()).toBe(1)
    expect(await dialog.getByText('Web search', { exact: true }).count()).toBe(1)
    // Collapsed: a card's fields appear only once it is expanded.
    expect(await dialog.getByLabel('Command timeout (ms)').count()).toBe(0)

    const snapshot = await captureStableAria(page, '[role="region"][aria-label="Customize"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(SECTION_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('exposes the Perplexity and Z.AI search methods on the web-search card', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-perplexity'))
    const dialog = await openPlugins()
    await dialog.getByText('Web search', { exact: true }).click()

    // The shipped bundle mounts web-search-perplexity and the attached-CLI zai
    // backend, so the card serves both namespaces with no key configured: the
    // switches render, and Perplexity's key control is a password field whose
    // endpoint is labeled distinctly from DeepSeek's.
    const perplexitySwitch = dialog.getByRole('switch', { name: 'Perplexity', exact: true })
    await perplexitySwitch.waitFor({ timeout: 10_000 })
    expect(await dialog.getByRole('switch', { name: 'Z.AI', exact: true }).count()).toBe(1)
    expect(await perplexitySwitch.getAttribute('aria-checked')).toBe('true')
    expect(await dialog.getByLabel('Perplexity API key', { exact: true }).getAttribute('type')).toBe('password')
    expect(await dialog.getByLabel('Perplexity endpoint', { exact: true }).count()).toBe(1)
    expect(await dialog.getByLabel('DeepSeek API key', { exact: true }).count()).toBe(1)
    expect(await dialog.getByLabel('DeepSeek endpoint', { exact: true }).count()).toBe(1)
    const perplexityBox = await perplexitySwitch.boundingBox()
    const perplexityKeyBox = await dialog.getByLabel('Perplexity API key', { exact: true }).boundingBox()
    const deepseekBox = await dialog.getByRole('switch', { name: 'DeepSeek', exact: true }).boundingBox()
    expect(perplexityBox).not.toBeNull()
    expect(perplexityKeyBox).not.toBeNull()
    expect(deepseekBox).not.toBeNull()
    expect(perplexityBox!.y).toBeLessThan(perplexityKeyBox!.y)
    expect(perplexityKeyBox!.y).toBeLessThan(deepseekBox!.y)
    const snapshot = await captureStableAria(page, '[role="region"][aria-label="Customize"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'web-search.expected.md'), snapshot, MODE)
    // No edit was staged: expanding the card changes nothing on disk.
    expect(await settingsDocument()).not.toContain('web-search-perplexity')
    expect(tripwire.pageErrors).toEqual([])

    // Leave the card collapsed for the scenarios that share this page.
    await dialog.getByText('Web search', { exact: true }).click()
  }, 60_000)

  it('stages an edit and writes it only when saved', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-write'))
    const dialog = await openPlugins()
    await dialog.getByText('Shell', { exact: true }).click()

    const timeout = dialog.getByLabel('Command timeout (ms)')
    await timeout.waitFor({ timeout: 10_000 })
    // The composed default this deployment ships, before any user layer.
    expect(await timeout.inputValue()).toBe('60000')
    await timeout.fill('12000')
    await timeout.blur()

    // Nothing crosses the wire until the user saves: leaving the control is
    // not a decision to store the value.
    expect(await settingsDocument()).not.toContain('timeoutMs')
    const save = dialog.getByRole('button', { name: 'Save', exact: true })
    await expect.poll(() => save.isEnabled(), { timeout: 5_000 }).toBe(true)
    await save.click()

    await expect.poll(async () => (await settingsDocument()).includes('timeoutMs: 12000'), { timeout: 10_000 })
      .toBe(true)
    // Presence in the user layer is what the badge reports, and the reset is
    // offered only for a field that has one.
    await expect.poll(() => dialog.getByText('Overridden').count(), { timeout: 5_000 }).toBe(1)
    expect(await dialog.getByRole('button', { name: 'Reset to default' }).count()).toBe(1)
    // A settled form offers no save to repeat.
    await expect.poll(() => save.isDisabled(), { timeout: 5_000 }).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('drops a staged edit on discard without touching the document', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-discard'))
    const dialog = await openPlugins()
    await dialog.getByText('Shell', { exact: true }).click()
    const timeout = dialog.getByLabel('Command timeout (ms)')
    await timeout.waitFor({ timeout: 10_000 })

    await timeout.fill('7000')
    await dialog.getByRole('button', { name: 'Discard' }).click()

    await expect.poll(() => timeout.inputValue(), { timeout: 5_000 }).toBe('12000')
    expect(await settingsDocument()).toContain('timeoutMs: 12000')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('refuses to save a draft that is not a number', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-invalid'))
    const dialog = await openPlugins()
    await dialog.getByText('Shell', { exact: true }).click()
    const timeout = dialog.getByLabel('Command timeout (ms)')
    await timeout.waitFor({ timeout: 10_000 })

    await timeout.fill('soon')

    const save = dialog.getByRole('button', { name: 'Save', exact: true })
    await expect.poll(() => save.isDisabled(), { timeout: 5_000 }).toBe(true)
    expect(await dialog.getByText('Enter a number, or leave blank to use the default.').count()).toBe(1)
    await dialog.getByRole('button', { name: 'Discard' }).click()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('clears the field back to the composed default on reset', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-reset'))
    const dialog = await openPlugins()
    await dialog.getByText('Shell', { exact: true }).click()
    const timeout = dialog.getByLabel('Command timeout (ms)')
    await timeout.waitFor({ timeout: 10_000 })
    expect(await timeout.inputValue()).toBe('12000')

    // The reset stages the composed default; the document still carries the
    // override until the save lands.
    await dialog.getByRole('button', { name: 'Reset to default' }).click()
    await expect.poll(() => timeout.inputValue(), { timeout: 5_000 }).toBe('60000')
    expect(await settingsDocument()).toContain('timeoutMs: 12000')

    await dialog.getByRole('button', { name: 'Save', exact: true }).click()

    await expect.poll(async () => (await settingsDocument()).includes('timeoutMs'), { timeout: 10_000 })
      .toBe(false)
    expect(await timeout.inputValue()).toBe('60000')
    expect(await dialog.getByText('Overridden').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['section.expected.md', 'web-search.expected.md'])
  })
})
