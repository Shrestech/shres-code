// Keyless assembled-browser coverage for the agent-seats settings seam. The
// first launch uses a malformed persisted extras object and must fail before
// the web surface can claim that Teams are unavailable. The same scratch
// document is then corrected and a fresh real web composition must expose the
// four product rows and its custom member through the settings API.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const INVALID_SETTINGS = [
  'agent-seats:',
  '  extras:',
  '    - name: cartographer',
  '      role: Researcher',
  '',
].join('\n')

const CORRECTED_SETTINGS = [
  'agent-seats:',
  '  seats:',
  '    aegis:',
  '      provider: deepseek-official',
  '      model: deepseek-v4-flash',
  '    stride:',
  '      provider: deepseek-official',
  '      model: deepseek-v4-flash',
  '    ward:',
  '      provider: deepseek-official',
  '      model: deepseek-v4-flash',
  '    subagent:',
  '      provider: deepseek-official',
  '      model: deepseek-v4-flash',
  '  extras:',
  '    - name: cartographer',
  '      persona: Maps the repository.',
  '      provider: deepseek-official',
  '      model: deepseek-v4-flash',
  '      role: Researcher',
  '',
].join('\n')

interface SettingsFixture {
  root: string
  settingsPath: string
  overlayPath: string
}

async function makeSettingsFixture(document: string): Promise<SettingsFixture> {
  const root = await mkdtemp(join(tmpdir(), 'shres-web-e2e-agent-seats-'))
  const settingsPath = join(root, 'settings.yaml')
  const overlayPath = join(root, 'overlay.yml')
  await writeFile(settingsPath, document)
  // The scaffold's hermetic settings patch is applied after extraOverlayPath.
  // Disable the shipped row, then insert a replacement provider whose path is
  // this test's scratch document; the real settings service and agent-seats
  // plugin still compose through the normal Loader graph.
  await writeFile(overlayPath, [
    '- id: settings',
    '  disabled: true',
    '- insert:',
    '  - id: agent-seats-settings-regression',
    "    name: '@shres-code/shres-code-settings-file'",
    '    config:',
    `      path: ${JSON.stringify(settingsPath)}`,
    `      shresHome: ${JSON.stringify(root)}`,
    '      watch: false',
    '',
  ].join('\n'))
  return { root, settingsPath, overlayPath }
}

it('fails malformed agent-seats settings, then exposes the corrected roster through the real web API', async () => {
  const fixture = await makeSettingsFixture(INVALID_SETTINGS)
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  try {
    await expect(launchWebScaffold({ extraOverlayPath: fixture.overlayPath })).rejects.toThrow(
      'agent-seats: invalid settings; correct the agent-seats section in the settings document.',
    )

    await writeFile(fixture.settingsPath, CORRECTED_SETTINGS)
    scaffold = await launchWebScaffold({ extraOverlayPath: fixture.overlayPath })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-agent-seats-settings'))
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    await page.getByRole('button', { name: 'Teams', exact: true }).click()
    const teams = page.getByRole('region', { name: 'Teams', exact: true })
    await teams.getByRole('heading', { name: 'Team members', exact: true }).waitFor({ timeout: 10_000 })
    await expect.poll(() => teams.locator('[class*="seatRow"]').count(), { timeout: 10_000 }).toBe(4)
    await expect.poll(() => teams.locator('[class*="memberRow"]').count(), { timeout: 10_000 }).toBe(1)
    expect(await teams.locator('[class*="seatName"], [class*="memberName"]').allTextContents())
      .toMatchInlineSnapshot(`
      [
        "Aegis",
        "Stride",
        "Ward",
        "Subagent",
        "cartographer",
      ]
    `)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } finally {
    await browser?.close()
    await scaffold?.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
}, 120_000)
