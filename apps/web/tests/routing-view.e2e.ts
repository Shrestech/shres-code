// Web e2e scenario: the per-session Routing view over a recorded routed
// session. The seed is the keyless headless model-routing recording (one turn,
// a downgraded decision and an escalation back), seeded cold through the real
// persistence API with the model router composed on the host, so the view
// renders purely from the log with ZERO model calls. The scenario opens the
// session, selects Routing in the Activity popover, opens a decision's
// drill-down through the modelRouting.decision read, hands off with Show in
// Trajectory, lands on that decision's ROUTING row, hands back with Explain,
// and keeps the Routing selection across a reload. A host composing no
// router lists no Routing view in the same popover. A host with a local and a
// remote judge switches between them through a real settings write: the
// status line follows each switch without a reload, and the Auto chip asks
// before turning routing on only while the remote judge is selected, and its
// Settings link opens Settings › Model routing.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { JUDGMENT_SETTINGS_NAMESPACE } from '@shres-code/shres-code-judgment'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, openSessionActivity, saveFailureShot, selectSessionView } from './support.ts'

const SEED = fileURLToPath(new URL('../../../examples/headless-agent/tests/snapshots/model-router-step/session.jsonl', import.meta.url))
const ROUTER = fileURLToPath(new URL('../../../packages/llm/model-router/lib/index.js', import.meta.url))
const DISPATCH = fileURLToPath(new URL('../../../packages/llm/judgment-dispatch/lib/index.js', import.meta.url))
const LLM_JUDGE = fileURLToPath(new URL('../../../packages/llm/judgment-llm/lib/index.js', import.meta.url))
/** Registry ids judgment-llm gives its two rows: `llm:<provider>/<model>`. */
const LOCAL_JUDGE = 'llm:deepseek-official/deepseek-v4-flash'
const REMOTE_JUDGE = 'llm:deepseek-official/deepseek-v4-pro'
const SEED_ID = 'routing-view-web-e2e'
const PROMPT = 'Inspect the supplied evidence with the bash tool, then answer briefly.'

/**
 * The host composition row the shipped Web surface lacks: the model router,
 * named by its built entry because the product install anchor does not list
 * it. Its configuration mirrors the recording's.
 */
const OVERLAY = (router: string) => `- insert:
    - id: model-router
      name: '${router}'
      config:
        initialMode: on
        candidates:
          - id: flash
            provider: deepseek-official
            model: deepseek-v4-flash
            description: a small, well-scoped change in familiar code
        routeFrom:
          - provider: deepseek-official
            model: deepseek-v4-pro
            objective: dollars
        downgradeThreshold: 0.7
        downgradeMargin: 0.5
        hold:
          minSteps: 3
        routeInstructions: Pick the cheapest route that can finish this turn.
        difficultyInstructions: Rate how much reasoning this turn needs.
`

/**
 * The dispatcher and two LLM judges on one route family: one declared local,
 * one declared remote. No ask runs; the scenario reads their facts only.
 */
const JUDGES = `    - id: judgment-dispatch
      name: '${DISPATCH}'
      config:
        defaultEngine: ${LOCAL_JUDGE}
    - id: judge-local
      name: '${LLM_JUDGE}'
      config:
        provider: deepseek-official
        model: deepseek-v4-flash
        egress: local
        maxStateTokens: 4096
    - id: judge-remote
      name: '${LLM_JUDGE}'
      config:
        provider: deepseek-official
        model: deepseek-v4-pro
        egress: remote
        maxStateTokens: 4096
`

/** Open the seeded session from the sidebar search. */
async function openSeed(page: Page): Promise<void> {
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  await page.getByRole('textbox', { name: 'Search sessions...', exact: true }).fill(PROMPT)
  const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => results.count(), { timeout: 60_000 }).toBe(1)
  await results.click()
  await page.getByRole('button', { name: 'Activity', exact: true }).waitFor({ timeout: 30_000 })
}

describe('web e2e: per-session Routing view', () => {
  let overlayDir: string
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    overlayDir = await mkdtemp(join(tmpdir(), 'shres-routing-view-'))
    const overlay = join(overlayDir, 'routing.overlay.yml')
    await writeFile(overlay, OVERLAY(ROUTER))
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    await seedSession(scaffold, await readFile(SEED, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser, 1000)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (overlayDir !== undefined) await rm(overlayDir, { recursive: true, force: true })
  })

  it('opens Routing, drills into a decision, lands on its ROUTING row in Trajectory, and explains it back', async () => {
    onTestFailed(() => saveFailureShot(page, 'routing-view'))
    await openSeed(page)

    await selectSessionView(page, 'Routing')
    await page.getByRole('heading', { name: 'Routing', level: 2 }).waitFor({ timeout: 30_000 })
    const decisions = page.locator('[data-kpi="decisions"]')
    await expect.poll(() => decisions.textContent()).toContain('Decisions2')
    await page.getByRole('img', { name: /^Model timeline / }).waitFor()

    await page.getByRole('button', { name: 'Open the reasoning of turn 1.2' }).click()
    const drawer = page.getByRole('dialog')
    await drawer.getByRole('heading', { name: 'Turn 1.2 · escalated' }).waitFor({ timeout: 30_000 })
    expect(await drawer.getByText('First failing check: Difficulty is below the entry score.').count()).toBe(1)

    await drawer.getByRole('button', { name: 'Show in Trajectory →' }).click()
    await page.getByLabel('Trajectory timeline').waitFor({ timeout: 30_000 })
    // Trajectory marks the record a reveal landed on; the sidebar's selected
    // session carries aria-selected too, so the row marker is the one to read.
    const landed = page.locator('[data-selected="true"]')
    await expect.poll(() => landed.count(), { timeout: 30_000 }).toBeGreaterThan(0)
    expect(await landed.first().textContent()).toContain('escalated')

    await page.getByRole('button', { name: 'Explain this routing decision in the Routing view' }).first().click()
    await page.getByRole('dialog').getByRole('heading', { name: /^Turn 1\.\d · / }).waitFor({ timeout: 30_000 })

    // The persisted Routing selection survives a reload: the row is listed
    // while the host's answer is still loading, so the view is never dropped.
    await page.reload({ waitUntil: 'load' })
    await openSeed(page)
    await page.getByRole('heading', { name: 'Routing', level: 2 }).waitFor({ timeout: 30_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, 180_000)
})

describe('web e2e: no Routing view on a host without the router', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, await readFile(SEED, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser, 1000)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('lists Chat and Trajectory but not Routing in the Activity popover', async () => {
    onTestFailed(() => saveFailureShot(page, 'routing-view-absent'))
    await openSeed(page)
    const panel = await openSessionActivity(page)
    await panel.getByRole('button', { name: 'Trajectory', exact: true }).waitFor()
    await expect.poll(() => panel.getByRole('button', { name: 'Routing', exact: true }).count(), { timeout: 10_000 }).toBe(0)
  }, 180_000)
})

describe('web e2e: the Routing view follows a judge switch', () => {
  let overlayDir: string
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    overlayDir = await mkdtemp(join(tmpdir(), 'shres-routing-judges-'))
    const overlay = join(overlayDir, 'routing-judges.overlay.yml')
    await writeFile(overlay, OVERLAY(ROUTER) + JUDGES)
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    await seedSession(scaffold, await readFile(SEED, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser, 1000)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (overlayDir !== undefined) await rm(overlayDir, { recursive: true, force: true })
  })

  it('names the selected judge and confirms turn-on only for the remote one', async () => {
    onTestFailed(() => saveFailureShot(page, 'routing-view-judges'))
    await openSeed(page)
    await selectSessionView(page, 'Routing')
    const status = page.locator('p', { hasText: 'Judge (all sessions):' })
    await expect.poll(() => status.textContent(), { timeout: 30_000 }).toContain('deepseek-official/deepseek-v4-flash')
    expect(await status.textContent()).toContain('Local')

    // The recorded session runs with routing on; turning it off never asks.
    await page.getByRole('button', { name: 'Automatic model routing on, press to turn off' }).click()
    const offChip = page.getByRole('button', { name: 'Automatic model routing off, press to turn on' })
    await offChip.waitFor({ timeout: 30_000 })

    // A real host settings write selects the remote judge; no reload.
    await scaffold.ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: REMOTE_JUDGE })
    await expect.poll(() => status.textContent(), { timeout: 30_000 }).toContain('deepseek-official/deepseek-v4-pro')
    expect(await status.textContent()).toContain('Remote · egress')
    await offChip.click()
    const confirm = page.getByRole('dialog', { name: 'Turn on Auto routing for this session?' })
    await confirm.waitFor()
    expect(await confirm.textContent()).toContain('This judge runs off this machine')
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await confirm.count()).toBe(0)
    expect(await offChip.count()).toBe(1)

    // Switching back to the local judge turns routing on directly.
    await scaffold.ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: LOCAL_JUDGE })
    await expect.poll(() => status.textContent(), { timeout: 30_000 }).toContain('deepseek-official/deepseek-v4-flash')
    await offChip.click()
    await page.getByRole('button', { name: 'Automatic model routing on, press to turn off' }).waitFor({ timeout: 30_000 })
    expect(await confirm.count()).toBe(0)

    // The status line's link opens the Settings section that configures the judge.
    await status.getByRole('button', { name: 'Settings › Model routing', exact: true }).click()
    await page.locator('section[aria-label="Model routing"]').getByRole('combobox', { name: 'Engine' }).waitFor({ timeout: 30_000 })
  }, 180_000)
})
