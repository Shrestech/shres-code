/**
 * End-to-end harness for the REAL `@shres-shield/plugin` payload mounted through
 * the host seat. Unlike `fake-shield-plugin.ts`, this points
 * `SHRES_SHIELD_MODULE` at the sibling checkout's built plugin dist and drives
 * the live detection engine through the host's own seams:
 *
 * - `agent/pre-step` (user_message channel) via the agent event dispatcher,
 * - `tools/pre-execute` + `tools/execute` (tool_args channel) and
 *   `tools/post-execute` + `tools/result` (tool_result channel) via the real
 *   `ctx.tools.execute` pipeline.
 *
 * The seat forwards `{ posture, license }` to the engine. Approval tunables
 * (cap / budget / grant TTL / ask timeout) stay engine-owned: the engine uses
 * its 120s default ask timeout. The timeout scenario therefore drives that
 * real default under a stubbed clock (see the spec).
 */

import { Context } from '@shres-code/cordis'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@shres-code/shres-code-tools'
import type { ToolExecutionResult } from '@shres-code/shres-code-tools'
import { CallId } from '@shres-code/shres-code-llm'
import { agentEvents } from '@shres-code/shres-code-agent'
import type { Agent, PreStepDecision } from '@shres-code/shres-code-agent'
import * as ShieldSeat from '@shres-code/shres-code-shield'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The published `@shrestech/shres-shield-plugin` payload's ESM entry, resolved
 * from the installed devDependency so the e2e suite exercises the real engine
 * without depending on a local `../shres-shield` checkout.
 */
export const REAL_PLUGIN_MODULE = fileURLToPath(import.meta.resolve('@shrestech/shres-shield-plugin'))

/** Model-visible quarantine prefix the post-execute seam writes on a block. */
export const REVIEW_VOICE = '[shres-shield:REVIEW]'
/** Model-visible warning the post-execute seam attaches on observe. */
export const NOTICE_VOICE = '[shres-shield:NOTICE]'

/** How the scripted approval answerer resolves one ask. */
export type ApprovalMode =
  | 'grant' // host returns 'allowed-once' → shield treats as granted
  | 'refuse' // host returns 'rejected' → not granted
  | 'delay' // host never answers → the engine's ask timeout must fire
  | 'headless' // no `approval.request` at all → engine fails closed

/** One recorded approval question the shield routed to the host. */
export interface RecordedAsk {
  toolName: string
  reason?: string
  callId?: string
}

export interface Harness {
  ctx: Context
  /** Every approval question the shield asked the host, in order. */
  asks: RecordedAsk[]
  /** A minimal live-agent stand-in for scope routing and approval payloads. */
  agent: Agent
  /** Dispose the seat fiber and drop the payload. */
  dispose(): Promise<void>
}

const savedEnv = {
  SHRES_SHIELD: process.env.SHRES_SHIELD,
  SHRES_SHIELD_LICENSE: process.env.SHRES_SHIELD_LICENSE,
  SHRES_SHIELD_MODULE: process.env.SHRES_SHIELD_MODULE,
  SHRES_SHIELD_POSTURE: process.env.SHRES_SHIELD_POSTURE,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
}

/**
 * Redirect telemetry / stats / breaker writes into a throwaway dir and point
 * the resolver at the real sibling plugin. Call once per suite in `beforeAll`.
 * @returns the temp home so a caller may inspect written artifacts if needed.
 */
export function installE2eEnv(): string {
  const home = mkdtempSync(join(tmpdir(), 'shres-shield-e2e-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.SHRES_SHIELD_MODULE = REAL_PLUGIN_MODULE
  delete process.env.SHRES_SHIELD
  delete process.env.SHRES_SHIELD_LICENSE
  delete process.env.SHRES_SHIELD_POSTURE
  return home
}

/** Restore every environment variable this harness mutated. Call in `afterAll`. */
export function restoreE2eEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
}

/** Wait until the async resolve/apply effect publishes a terminal reason. */
async function waitForReason(ctx: Context, reason: ShieldSeat.ShieldReason): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (ctx.shield.status.reason === reason) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
  }
  throw new Error(`shield status stayed ${JSON.stringify(ctx.shield.status)}, wanted ${reason}`)
}

/**
 * Build a plain object that satisfies the surface the shield adapter and the
 * tool runtime read from an agent: identity, a session with an open turn, and
 * a cwd header. It is a scope key, not a real live agent.
 * @param cwd - workspace path reported through `session.header.cwd`.
 */
export function fakeAgent(cwd = '/tmp/shres-shield-e2e-workspace'): Agent {
  return {
    id: 'shield-e2e-agent',
    session: {
      header: { cwd },
      events: [{ type: 'turn/start' }],
      append: () => ({}),
    },
  } as unknown as Agent
}

/**
 * Mount SystemPrompt + ToolRuntime + a scripted approval service + a jobs
 * service (matching the product Loader topology the seat injects), then the
 * REAL shield seat, and wait until the engine is active.
 * @param posture - forwarded to the paid engine.
 * @param approvalMode - how the scripted answerer resolves asks.
 */
export async function mountShield(
  posture: 'observe' | 'ask' | 'enforce',
  approvalMode: ApprovalMode,
  seatConfig: ShieldSeat.Config = {},
): Promise<Harness> {
  const ctx = new Context()
  const asks: RecordedAsk[] = []

  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)

  // Approval and jobs mount as sibling plugins (root provide would let an
  // uninjected seat read succeed and mask an inject regression).
  await ctx.plugin({
    name: 'approval-e2e',
    apply: (c: Context) => {
      if (approvalMode === 'headless') {
        // Present but without `.request`: adapter.hasApproval → false → the
        // engine's ApprovalManager runs headless and fails closed.
        c.provide('approval', {})
        return
      }
      c.provide('approval', {
        request: (payload: { toolName: string; reason?: string; callId?: string }) => {
          asks.push({
            toolName: payload.toolName,
            ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
            ...(payload.callId !== undefined ? { callId: payload.callId } : {}),
          })
          if (approvalMode === 'grant') return Promise.resolve('allowed-once')
          if (approvalMode === 'refuse') return Promise.resolve('rejected')
          // 'delay': never answer; the engine's ask timeout must resolve it.
          return new Promise<string>(() => {})
        },
      })
    },
  })
  await ctx.plugin({
    name: 'jobs-e2e',
    apply: (c: Context) => {
      // Run enqueued jobs inline so the async result seam re-screens
      // deterministically within the test.
      c.provide('jobs', { enqueue: (_name: string, fn: () => unknown) => { void fn() } })
    },
  })

  await ctx.plugin(ShieldSeat, Object.assign({ posture }, seatConfig))
  await waitForReason(ctx, 'active')

  return {
    ctx,
    asks,
    agent: fakeAgent(),
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

let callSeq = 0
function nextCallId(): CallId {
  callSeq += 1
  return CallId(`shield-e2e-${callSeq}`)
}

/**
 * Drive the user_message channel through the real `agent/pre-step` waterfall.
 * @param h - the mounted harness.
 * @param text - the claimed user message content to screen.
 * @returns the shield's pre-step decision (enter allows the turn, reject blocks it).
 */
export function driveUserMessage(h: Harness, text: string): Promise<PreStepDecision> {
  const messages = [{ content: [{ type: 'text', text }], source: { kind: 'user' } }]
  return agentEvents(h.ctx, h.agent).waterfall(
    'agent/pre-step',
    { messages: messages as never, turn: 1, step: 1, signal: new AbortController().signal },
    (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: messages as never }),
  )
}

/**
 * Drive the tool_args channel: register a benign tool whose serialized
 * arguments carry `cmd`, then execute it. The pre-execute seam screens the
 * argument text.
 * @param h - the mounted harness.
 * @param cmd - the argument value to screen as tool_args.
 * @param toolName - registered tool name; use an fs-writing name (e.g. `write`)
 *   to exercise the deterministic self-defense path-scope check.
 */
export async function driveToolArgs(
  h: Harness,
  cmd: string,
  toolName = `args-tool-${callSeq + 1}`,
): Promise<ToolExecutionResult> {
  const name = toolName
  h.ctx.tools.register(defineContentToolFixture({
    name,
    description: 'benign tool whose args are screened',
    parameters: { cmd: { type: 'string', required: true } },
    async execute() {
      return [{ type: 'text' as const, text: 'ran' }]
    },
  }))
  return h.ctx.tools.execute({
    signal: new AbortController().signal,
    callId: nextCallId(),
    name,
    arguments: { cmd },
    agent: h.agent,
  })
}

/**
 * Drive the tool_result channel: register a tool that RETURNS `payload` from
 * benign arguments (so the payload is screened only as tool_result, never as
 * tool_args), then execute it. The post-execute seam screens the result text.
 * @param h - the mounted harness.
 * @param payload - the tool output content the engine screens as tool_result.
 */
export async function driveToolResult(h: Harness, payload: string): Promise<ToolExecutionResult> {
  const name = `result-tool-${callSeq + 1}`
  h.ctx.tools.register(defineContentToolFixture({
    name,
    description: 'returns fetched content to be screened as a tool result',
    parameters: { ref: { type: 'string', required: true } },
    async execute() {
      return [{ type: 'text' as const, text: payload }]
    },
  }))
  return h.ctx.tools.execute({
    signal: new AbortController().signal,
    callId: nextCallId(),
    name,
    arguments: { ref: 'doc-123' },
    agent: h.agent,
  })
}

/** Flatten a tool result's content blocks to plain text. */
export function resultText(result: ToolExecutionResult): string {
  return result.content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('\n')
}

/** Flatten a tool result's additionalContexts to plain text. */
export function additionalContextText(result: ToolExecutionResult): string {
  const extras = result.additionalContexts ?? []
  return extras
    .flatMap(message => message.content)
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('\n')
}
