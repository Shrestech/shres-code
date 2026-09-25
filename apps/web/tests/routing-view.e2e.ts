// Web e2e scenario: the per-session Routing view over a recorded routed
// session. The seed is the keyless headless model-routing recording (one turn,
// a downgraded decision and an escalation back), seeded cold through the real
// persistence API with the model router composed on the host, so the view
// renders purely from the log with ZERO model calls. The scenario opens the
// session, selects Routing in the Activity popover, opens a decision's
// drill-down through the modelRouting.decision read, hands off with Show in
// Trajectory, lands on that decision's ROUTING row, and hands back with Explain.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot, selectSessionView } from './support.ts'

const SEED = fileURLToPath(new URL('../../../examples/headless-agent/tests/snapshots/model-router-step/session.jsonl', import.meta.url))
const ROUTER = fileURLToPath(new URL('../../../packages/llm/model-router/lib/index.js', import.meta.url))
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
    const searchButton = page.getByRole('button', { name: 'Search sessions' })
    if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
    await page.getByRole('textbox', { name: 'Search sessions...', exact: true }).fill(PROMPT)
    const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
    await expect.poll(() => results.count(), { timeout: 60_000 }).toBe(1)
    await results.click()
    await page.getByRole('button', { name: 'Activity', exact: true }).waitFor({ timeout: 30_000 })

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
    expect(tripwire.pageErrors).toEqual([])
  }, 180_000)
})
