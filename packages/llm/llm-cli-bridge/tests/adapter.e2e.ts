/**
 * Real-CLI e2e. Self-skips when none of the shipped binaries are on PATH.
 */
import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Context } from '@roos-code/cordis'
import LlmRuntime, { createUserMessage } from '@roos-code/roos-code-llm'
import LocalSubprocessRuntime from '@roos-code/roos-code-subprocess-local'
import * as plugin from '../src/index.ts'
import { SHIPPED_ROUTES, type ShippedRouteId } from '../src/config.ts'

const execFileAsync = promisify(execFile)

const CANDIDATES: readonly ShippedRouteId[] = ['grok-cli', 'kimi-cli', 'claude-cli', 'codex-cli']

async function presentBinary(): Promise<ShippedRouteId | undefined> {
  for (const id of CANDIDATES) {
    const binary = SHIPPED_ROUTES[id].binary
    try {
      await execFileAsync(binary, ['--version'], { timeout: 4_000 })
      return id
    } catch {
      // Missing or non-zero version probe: try the next shipped CLI.
    }
  }
  return undefined
}

describe('llm-cli-bridge real CLI', () => {
  it('completes one prompt when a shipped binary is installed', async () => {
    const route = await presentBinary()
    if (route === undefined) return
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(plugin, {})
    const model = SHIPPED_ROUTES[route].models[0]?.id ?? 'default'
    const chunks: string[] = []
    for await (const chunk of ctx.llm.stream({
      provider: route,
      model,
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
