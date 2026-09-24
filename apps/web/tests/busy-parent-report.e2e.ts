// Keyless browser coverage for busy-parent report delivery through the
// shipped Web composition. A scripted adapter classifies each call by its
// session id: the parent spawns one continuable child, holds its second model
// call open until the child's settlement notice lands, and the child reports
// twice before it settles. The parent must claim both reports and the notice
// from next-step inside one turn, and the Chat and Queue dock must show no
// queued items.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  CallId, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk,
} from '@shres-code/shres-code-llm'
import { SessionId, type SessionEvent, type SessionId as SessionIdValue } from '@shres-code/shres-code-session'
import type { AgentHandle } from '@shres-code/shres-code-agent'
import type {} from '@shres-code/shres-code-subagent'
import type {} from '@shres-code/shres-code-workspace'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot, selectSessionView } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/busy-parent-report', import.meta.url))
const PARENT_SEQUENCE_EXPECTED = join(SNAPSHOT_DIR, 'parent-sequence.expected.md')
const CHAT_EXPECTED = join(SNAPSHOT_DIR, 'chat.expected.md')
const MODE = webSnapshotMode()

const PROVIDER = 'web-test-busy-parent'
const MODEL = 'busy-parent'
const PARENT_SESSION = SessionId('busy-parent-report')
const PARENT_PROMPT = 'Delegate two progress reports to a background subagent, then answer.'
const CHILD_PROMPT = 'Report two progress findings, then finish.'
const REPORT_ONE = 'PROGRESS_ONE'
const REPORT_TWO = 'PROGRESS_TWO'
const CHILD_DONE = 'CHILD_DONE'
const PARENT_ANSWER = 'PARENT_CLAIMED_TWO_REPORTS_AND_SETTLEMENT'

/** Await `promise`, rejecting promptly when the turn signal aborts. */
async function holdUntil(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    await promise
    return
  }
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('busy-parent adapter aborted'))
    }
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(
      () => { signal.removeEventListener('abort', abort); resolve() },
      reject,
    )
  })
}

function textStream(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 16, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallChunks(index: number, id: ReturnType<typeof CallId>, name: string, args: string): StreamChunk[] {
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id, name, argumentsDelta: args },
    { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } },
  ]
}

/**
 * Model stub that keys every call by its session id: the parent runs three
 * calls, the child two. The parent's second call is held until the child's
 * settlement notice is inserted; the child's first call waits for that second
 * call so the reports cannot overtake the parent's step-2 claim.
 */
class BusyParentAdapter extends LlmAdapter {
  parentSessionId: SessionIdValue = PARENT_SESSION
  private parentCalls = 0
  private readonly childCalls = new Map<string, number>()
  private readonly parentCallTwo = Promise.withResolvers<undefined>()
  private readonly settlementInserted = Promise.withResolvers<undefined>()

  /** Release the held parent call once the settlement notice entered the inbox. */
  markSettlementInserted(): void {
    this.settlementInserted.resolve(undefined)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId === this.parentSessionId) {
      this.parentCalls += 1
      if (this.parentCalls === 1) {
        const args = JSON.stringify({ description: 'Report progress twice', prompt: CHILD_PROMPT })
        yield* toolCallChunks(0, CallId('spawn-child'), 'subagent', args)
        yield { type: 'usage', usage: { inputTokens: 16, outputTokens: 8 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (this.parentCalls === 2) {
        this.parentCallTwo.resolve(undefined)
        yield* textStream('Waiting for the delegated child.')
        await holdUntil(this.settlementInserted.promise, options.signal)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield* textStream(PARENT_ANSWER)
      return
    }
    const key = String(options.sessionId)
    const count = (this.childCalls.get(key) ?? 0) + 1
    this.childCalls.set(key, count)
    if (count === 1) {
      await holdUntil(this.parentCallTwo.promise, options.signal)
      yield* toolCallChunks(0, CallId('report-one'), 'report', JSON.stringify({ output: REPORT_ONE }))
      yield* toolCallChunks(1, CallId('report-two'), 'report', JSON.stringify({ output: REPORT_TWO }))
      yield { type: 'usage', usage: { inputTokens: 16, outputTokens: 8 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield* textStream(CHILD_DONE)
  }
}

/** Normalize one text block: run-local child ids only. */
function normalizeText(text: string): string {
  return text.split(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i).join('{{childId}}')
}

/**
 * Normalized excerpt of the parent's durable delivery sequence: turn and step
 * boundaries, inbox splice targets and inserted source kinds, and the user,
 * report, and settlement message texts.
 */
function normalizeSequence(events: readonly SessionEvent[]): string {
  const lines: string[] = []
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        lines.push('turn/start')
        break
      case 'step/start':
        lines.push(`step/start turn=${String(event.data.turn)} step=${String(event.data.step)}`)
        break
      case 'agent/inbox/spliced': {
        const kinds = event.data.inserted.map(message => message.source.kind)
        lines.push(
          `spliced target=${event.data.target} inserted=[${kinds.join(', ')}] removed=${String(event.data.removedCount ?? 0)}`,
        )
        break
      }
      case 'user/message': {
        const kind = event.data.source.kind
        if (kind !== 'user' && kind !== 'subagent-report' && kind !== 'subagent-settled') break
        const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('')
        lines.push(`user/message source=${kind} text=${normalizeText(text)}`)
        break
      }
      default:
        break
    }
  }
  return lines.join('\n')
}

describe('web e2e: busy-parent subagent report delivery', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let adapter: BusyParentAdapter
  let tripwire: ReturnType<typeof watchConsole>
  let parentHandle: AgentHandle
  let parentEvents: SessionEvent[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    adapter = new BusyParentAdapter()
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter),
      'busy-parent-report scripted adapter',
    )
    const cwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(cwd)
    parentHandle = await scaffold.ctx.agents.create({
      sessionId: PARENT_SESSION,
      meta: { cwd },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    adapter.parentSessionId = parentHandle.agent.session.id
    // Registered before the prompt so the settlement insertion cannot be missed.
    scaffold.ctx.effect(() => scaffold.ctx.root.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent.session.id !== PARENT_SESSION || message.source.kind !== 'subagent-settled') return
      adapter.markSettlementInserted()
    }), 'busy-parent-report settlement listener')
    parentHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: PARENT_PROMPT }],
      source: { kind: 'user' },
    }))
    await parentHandle.agent.whenIdle()
    parentEvents = [...parentHandle.agent.session.events]

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('connected Web workspace was not registered')
    await workspace.attachSession(parentHandle.agent.session.id)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await parentHandle?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'busy-parent report teardown failed')
  })

  it('claims two reports and the settlement notice in one parent turn', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-busy-parent-report'))
    const turnStarts = parentEvents.filter(event => event.type === 'turn/start')
    const steps = parentEvents.filter(event => event.type === 'step/start')
    const reports = parentEvents.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'subagent-report')
    const settlements = parentEvents.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'subagent-settled')
    expect(turnStarts).toHaveLength(1)
    expect(steps.map(event => event.data.step)).toEqual([1, 2, 3])
    expect(reports).toHaveLength(2)
    expect(settlements).toHaveLength(1)
    const splicedNextTurn = parentEvents.filter(event => event.type === 'agent/inbox/spliced'
      && event.data.target === 'next-turn'
      && event.data.inserted.some(message => message.source.kind === 'subagent-report'
        || message.source.kind === 'subagent-settled'))
    expect(splicedNextTurn).toHaveLength(0)

    await compareOrRefreshGolden(
      PARENT_SEQUENCE_EXPECTED,
      normalizeSequence(parentEvents),
      MODE,
    )

    const sessions = page.getByRole('tree', { name: 'Sessions' })
    await sessions.getByRole('treeitem', { name: new RegExp(PARENT_PROMPT.slice(0, 24)) }).click()
    await page.getByText(PARENT_ANSWER, { exact: false }).first().waitFor({ timeout: 15_000 })
    await selectSessionView(page, 'Chat')
    // Expand the report and settlement context injections so the golden pins
    // their delivered text, not just the collapsed row labels.
    const reportRows = page.getByRole('button', { name: 'Context injection subagent-report' })
    await expect.poll(() => reportRows.count(), { timeout: 15_000 }).toBe(2)
    for (let index = 0; index < 2; index += 1) await reportRows.nth(index).click()
    await page.getByRole('button', { name: /Context injection subagent-settled/ }).click()
    await page.getByText(REPORT_ONE, { exact: false }).first().waitFor({ timeout: 15_000 })
    await page.getByText(REPORT_TWO, { exact: false }).first().waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(
      CHAT_EXPECTED,
      await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd),
      MODE,
    )
    expect(await page.locator('[data-queue-dock]').count()).toBe(0)
    expect(await page.getByRole('button', { name: /queued messages/ }).count()).toBe(0)
    await assertFixtureInventory(SNAPSHOT_DIR, ['parent-sequence.expected.md', 'chat.expected.md'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
