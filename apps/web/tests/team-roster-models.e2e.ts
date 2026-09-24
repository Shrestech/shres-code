// Keyless browser coverage for Team roster model display through the shipped
// Web composition. A scripted adapter answers every request and records the
// model each session requested. The Lead runs one model and starts a teammate
// on a different one; after the teammate unloads, the Team panel must show the
// teammate's own recorded model beside the Lead's, never the Lead's model for
// both rows.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@shres-code/shres-code-llm'
import { SessionId } from '@shres-code/shres-code-session'
import type { AgentHandle } from '@shres-code/shres-code-agent'
import type {} from '@shres-code/shres-code-agent-team'
import type {} from '@shres-code/shres-code-subagent'
import type {} from '@shres-code/shres-code-workspace'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSessionActivity, saveFailureShot } from './support.ts'

const PROVIDER = 'web-test-team-roster'
const LEAD_MODEL = 'lead-model'
const CHILD_MODEL = 'child-model'
const LEAD_SESSION = SessionId('team-roster-models')
const LEAD_PROMPT = 'Lead the scout teammate on its own model.'

function textStream(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 16, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Model stub that answers every request and records each session's requested model. */
class RecordingAdapter extends LlmAdapter {
  readonly models = new Map<string, string[]>()

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const key = String(options.sessionId)
    this.models.set(key, [...this.models.get(key) ?? [], options.model])
    yield* textStream(`answered on ${options.model}`)
  }
}

describe('web e2e: Team roster model display', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let adapter: RecordingAdapter
  let tripwire: ReturnType<typeof watchConsole>
  let leadHandle: AgentHandle
  let childId: SessionId

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    adapter = new RecordingAdapter()
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter),
      'team-roster-models scripted adapter',
    )
    const cwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(cwd)
    leadHandle = await scaffold.ctx.agents.create({
      sessionId: LEAD_SESSION,
      meta: { cwd },
      agentOptions: { provider: PROVIDER, model: LEAD_MODEL },
    })
    const lead = leadHandle.agent
    lead.followup(createUserMessage({ content: [{ type: 'text', text: LEAD_PROMPT }], source: { kind: 'user' } }))
    await lead.whenIdle()
    const spawned = await scaffold.ctx.agentTeams.spawnTeammate(lead, {
      name: 'scout',
      description: 'Scout',
      prompt: [{ type: 'text', text: 'Survey the workspace.' }],
      context: 'fresh',
      provider: 'spawn',
      signal: new AbortController().signal,
      agentOptions: { provider: PROVIDER, model: CHILD_MODEL },
    })
    childId = spawned.member.id
    // The teammate settles and unloads; the Lead answers the settlement notice.
    await vi.waitFor(() => { expect(scaffold.ctx.agents.get(childId)).toBeUndefined() }, { timeout: 15_000 })
    await lead.whenIdle()

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('connected Web workspace was not registered')
    await workspace.attachSession(lead.session.id)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await leadHandle?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'team roster models teardown failed')
  })

  it('shows the inactive teammate on its own model beside the Lead', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-team-roster-models'))
    expect(adapter.models.get(String(LEAD_SESSION))?.every(model => model === LEAD_MODEL)).toBe(true)
    expect(adapter.models.get(String(childId))).toEqual([CHILD_MODEL])

    const sessions = page.getByRole('tree', { name: 'Sessions' })
    await sessions.getByRole('treeitem', { name: new RegExp(LEAD_PROMPT.slice(0, 24)) }).click()
    const activity = await openSessionActivity(page)
    await activity.getByRole('button', { name: 'Team', exact: true }).click()
    const roster = page.getByRole('dialog', { name: 'Team roster' })
    await roster.waitFor({ timeout: 15_000 })
    const rows = roster.getByRole('listitem')
    await expect.poll(() => rows.count(), { timeout: 15_000 }).toBe(2)
    expect(await rows.nth(0).textContent()).toBe(`leadidle${PROVIDER} · ${LEAD_MODEL}`)
    expect(await rows.nth(1).textContent()).toBe(`scoutinactive${PROVIDER} · ${CHILD_MODEL}Open conversation`)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
