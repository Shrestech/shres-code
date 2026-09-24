/**
 * Real Grok subscription proxy check for the X search tools, run only by an
 * explicit opt-in. Each tool executes through the tool registry with a real
 * agent as the calling context, so the request record and the Grok request
 * are the production path. The credential file is only checked for presence;
 * the route's normal credential manager reads it. Every call is made once:
 * a sign-in, plan, or runtime refusal fails the check, and a failure reports
 * only the tool name and the failure code, never the error text.
 *
 * Run: SHRES_GROK_X_E2E=1 pnpm exec vitest run --config vitest.e2e.config.ts packages/llm/tool-grok-x-search/tests/proxy.e2e.ts
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import type { Agent } from '@shres-code/shres-code-agent'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import { mountAgentLoopTestDependencies } from '@shres-code/shres-code-agent-loop-testkit'
import { CallId } from '@shres-code/shres-code-llm'
import * as LlmGrokSession from '@shres-code/shres-code-llm-grok-session'
import { defaultAuthPath } from '@shres-code/shres-code-llm-grok-session'
import { SessionId } from '@shres-code/shres-code-session'
import { SettingsProvider } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import type { ToolExecutionResult } from '@shres-code/shres-code-tools'
import * as ToolGrokXSearch from '../src/index.ts'

const enabled = process.env['SHRES_GROK_X_E2E'] === '1' && existsSync(defaultAuthPath())

/** A public X post URL as the tool result cites it. */
const POST_URL = /https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{1,25}/u

/** A settings provider over an in-memory document. */
class MemorySettings extends SettingsProvider {
  private readonly doc: Record<string, unknown> = {}
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.doc)) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

/** Boot the real route with the gate open and one agent as the calling context. */
async function boot(): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmGrokSession, { agentXTools: true })
  await ctx.plugin(ToolGrokXSearch)
  // The caller's own route is never used; the tools ask grok-session themselves.
  const agent = ctx.agentLoop.create(SessionId('grok-x-e2e-caller'), { provider: 'grok-session', model: 'grok-4.6' })
  return { ctx, agent }
}

/**
 * Run one tool once and require success; a failure names only its code.
 * @returns the result's text content.
 */
async function call(ctx: Context, agent: Agent, name: string, args: Record<string, string>): Promise<string> {
  const result: ToolExecutionResult = await ctx.tools.execute({
    callId: CallId(`e2e-${name}`),
    name,
    arguments: args,
    agent,
    signal: AbortSignal.timeout(200_000),
  })
  const code = result.isError ? result.error.info?.code ?? 'no code' : 'none'
  expect(result.isError, `${name} failed (code: ${code})`).toBe(false)
  const request = agent.session.events.filter(event => event.type === 'grok-x-search/request').at(-1)
  expect(request?.data).toMatchObject({ tool: name, hostedTools: ['x_search'], route: { provider: 'grok-session' } })
  const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
  expect(text.startsWith('X operations Grok ran: ')).toBe(true)
  return text
}

describe.skipIf(!enabled)('Grok X search tools against the real proxy', () => {
  it('finds a post by keyword, then fetches that post\'s thread', async () => {
    const { ctx, agent } = await boot()
    try {
      const found = await call(ctx, agent, 'x_keyword_search', { query: 'from:xai grok' })
      const post = POST_URL.exec(found)?.[0]
      expect(post, 'x_keyword_search cited no x.com post URL').toBeDefined()
      await call(ctx, agent, 'x_thread_fetch', { post: post! })
    } finally {
      await ctx.fiber.dispose()
    }
  }, 480_000)

  it.each([
    ['x_semantic_search', { query: 'posts announcing new Grok models' }],
    ['x_user_search', { query: 'xAI' }],
  ])('%s succeeds', async (name, args) => {
    const { ctx, agent } = await boot()
    try {
      await call(ctx, agent, name, args)
    } finally {
      await ctx.fiber.dispose()
    }
  }, 240_000)
})
