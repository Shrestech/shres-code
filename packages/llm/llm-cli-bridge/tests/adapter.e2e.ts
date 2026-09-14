/**
 * Real-CLI e2e for one hand-declared route. Self-skips unless
 * SHRES_CLI_BRIDGE_E2E_BINARY names an executable that completes a prompt and
 * prints a JSON answer object (for example {"result":"..."}); the optional
 * SHRES_CLI_BRIDGE_E2E_MODEL, SHRES_CLI_BRIDGE_E2E_MODEL_ARG, and
 * SHRES_CLI_BRIDGE_E2E_PROMPT_ARG variables align the remaining flags.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { createUserMessage } from '@shres-code/shres-code-llm'
import { SessionId } from '@shres-code/shres-code-session'
import LocalSubprocessRuntime from '@shres-code/shres-code-subprocess-local'
import * as plugin from '../src/index.ts'

describe('llm-cli-bridge real CLI', () => {
  it('completes one prompt through a declared binary when one is provided', async () => {
    const binary = process.env.SHRES_CLI_BRIDGE_E2E_BINARY
    if (binary === undefined || binary.length === 0) return
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    ctx.provide('sessions' as never, {
      get: () => ({ header: { cwd: process.cwd() } }),
    })
    await ctx.plugin(plugin, {
      routes: {
        'e2e-cli': {
          displayName: 'E2E CLI (delegated)',
          binary,
          modelArg: process.env.SHRES_CLI_BRIDGE_E2E_MODEL_ARG ?? '--model',
          promptArg: process.env.SHRES_CLI_BRIDGE_E2E_PROMPT_ARG ?? '-p',
        },
      },
    })
    const chunks: string[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'e2e-cli',
      model: process.env.SHRES_CLI_BRIDGE_E2E_MODEL ?? 'default',
      sessionId: SessionId('cli-bridge-e2e'),
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Reply with the single word ok and nothing else.' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })) {
      if (chunk.type === 'text-delta') chunks.push(chunk.text)
      if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
        throw new Error(chunk.reason.failure.message)
      }
    }
    expect(chunks.join('').trim().length).toBeGreaterThan(0)
    await ctx.fiber.dispose()
  }, 120_000)
})
