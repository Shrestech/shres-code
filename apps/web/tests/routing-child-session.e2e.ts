// Keyless browser coverage for the child-session Routing notice and the
// parent's Trajectory CHILD-ROUTE row. A real spawn child is started through
// resolveChildRoute then startContinuable so the catalog hydrates a listable
// child (not a loading stub) and the parent log records child-decision.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionId } from '@shres-code/shres-code-session'
import type {} from '@shres-code/shres-code-agent'
import type {} from '@shres-code/shres-code-subagent'
import {
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import {
  connectFreshWorkspace, newEnglishPage, openSessionActivity, saveFailureShot, selectSessionView,
} from './support.ts'

const BASE_FIXTURE = fileURLToPath(new URL('./snapshots/live-interactions/session.jsonl', import.meta.url))
const ROUTER = fileURLToPath(new URL('../../../packages/llm/model-router/lib/index.js', import.meta.url))
const MODE = webSnapshotMode()
const LABEL = 'routing child explorer'
const PARENT_PROMPT = 'Ask a research subagent to explain event sourcing.'
const CHILD_PROMPT = 'Reply with exactly: CHILD_ROUTE_OK'

const OVERLAY = `- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
- insert:
    - id: model-router
      name: '${ROUTER}'
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
        childPolicies:
          - match:
              kind: subagent
            candidate: flash
        downgradeThreshold: 0.7
        downgradeMargin: 0.5
        routeInstructions: Pick the cheapest route that can finish this turn.
        difficultyInstructions: Rate how much reasoning this turn needs.
`

function childFixture(source: string, fixtureId: string): string {
  const [header, ...eventLines] = source.trimEnd().split('\n')
  if (header === undefined) throw new Error('base replay fixture has no header')
  const childHeader = header
    .replace('"id":"{{sessionId}}"', `"id":"${fixtureId}"`)
    .replace(/"createdAt":\d+/, '"createdAt":1784998084442')
  return [childHeader, ...eventLines, ''].join('\n')
}

async function waitForAgentToSettle(scaffold: WebScaffold, id: SessionId): Promise<void> {
  const deadline = Date.now() + 30_000
  while (scaffold.ctx.agents.get(id) !== undefined) {
    if (Date.now() >= deadline) throw new Error(`subagent ${id} did not settle`)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

describe('web e2e: child-session Routing notice and parent CHILD-ROUTE row', () => {
  let overlayDir: string
  let sidecarRoot: string
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let childId: SessionId
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('child-session routing is a keyless assembled snapshot')
    overlayDir = await mkdtemp(join(tmpdir(), 'shres-routing-child-'))
    sidecarRoot = await mkdtemp(join(tmpdir(), 'shres-routing-child-replay-'))
    const overlay = join(overlayDir, 'routing.overlay.yml')
    await writeFile(overlay, OVERLAY)
    const childFixturePath = join(sidecarRoot, 'child.jsonl')
    await writeFile(childFixturePath, childFixture(await readFile(BASE_FIXTURE, 'utf8'), 'recorded-routing-child'))
    scaffold = await launchWebScaffold({
      extraOverlayPath: overlay,
      replayFixture: BASE_FIXTURE,
      replayChildFixtures: [childFixturePath],
      paceMs: 25,
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)

    const parent = scaffold.ctx.agents.roots()[0]
    if (parent === undefined) throw new Error('fresh workspace did not publish its parent Agent')
    const parentSettled = scaffold.whenTurnSettled()
    const parentInput = page.locator('textarea:enabled').first()
    await parentInput.fill(PARENT_PROMPT)
    await parentInput.press('Enter')
    const deadline = Date.now() + 10_000
    while (!parent.session.events.some(event => event.type === 'turn/start')) {
      if (Date.now() >= deadline) throw new Error('parent turn/start never arrived')
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    const signal = new AbortController().signal
    const routed = await scaffold.ctx.subagents.resolveChildRoute('spawn', {
      parent,
      kind: 'subagent',
      prompt: CHILD_PROMPT,
      signal,
    })
    const started = await scaffold.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: LABEL,
      signal,
      request: {
        prompt: [{ type: 'text', text: CHILD_PROMPT }],
        parent,
        ...routed === undefined ? {} : { agentOptions: routed },
      },
    })
    childId = started.childId
    expect(await parentSettled).toBe(parent.id)
    await waitForAgentToSettle(scaffold, childId)
    const listed = await scaffold.ctx.subagents.listChildren(parent.id)
    expect(listed.some(entry => entry.kind === 'child' && entry.id === childId)).toBe(true)
    const childDecisions = parent.session.events.filter(event => event.type === 'model-routing/child-decision')
    expect(childDecisions.map(event => event.type === 'model-routing/child-decision' ? event.data.outcome : undefined)).toContain('routed')
    await scaffold.ctx.sessions.flush(parent.session)
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (overlayDir !== undefined) await rm(overlayDir, { recursive: true, force: true })
    if (sidecarRoot !== undefined) await rm(sidecarRoot, { recursive: true, force: true })
  })

  it('shows a CHILD-ROUTE row on the parent Trajectory and the child Routing notice', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-routing-child-session'))
    await selectSessionView(page, 'Trajectory')
    const timeline = page.getByLabel('Trajectory timeline')
    await timeline.waitFor({ timeout: 30_000 })
    await expect.poll(() => page.getByText(/Subagent routed to /).count(), { timeout: 30_000 }).toBeGreaterThan(0)
    expect(await page.getByText(/Subagent routed to /).first().innerText()).toMatch(/deepseek/)
    expect(await page.getByText(/Subagent routed to /).first().innerText()).not.toMatch(/escalated|kept-strong/)
    const activity = await openSessionActivity(page)
    const catalogButton = activity.getByRole('button', { name: /subagent/i })
    await catalogButton.click()
    const tree = page.getByRole('tree', { name: 'Subagent sessions' })
    await tree.waitFor({ timeout: 15_000 })
    const childRow = tree.getByRole('treeitem', { name: new RegExp(LABEL) })
    await expect.poll(() => childRow.getAttribute('aria-disabled'), { timeout: 15_000 }).not.toBe('true')
    await childRow.click()
    await expect.poll(() => page.getByText(CHILD_PROMPT, { exact: true }).count(), { timeout: 15_000 }).toBeGreaterThan(0)

    await selectSessionView(page, 'Routing')
    await expect.poll(
      () => page.getByText("This subagent's model was chosen when it started.").count(),
      { timeout: 30_000 },
    ).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 180_000)
})
