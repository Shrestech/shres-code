/** Real subscription X search and follow-up replay; skips when no CLI login document exists. */
import { existsSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage } from '@shres-code/shres-code-llm'
import * as GrokSession from '../src/index.ts'
import { defaultAuthPath } from '../src/config.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

it.runIf(existsSync(defaultAuthPath()))('replays a real hosted X turn without local tool dispatch', { timeout: 390_000, retry: 0 }, async () => {
  ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(GrokSession, { hostedWebSearch: true, hostedXSearch: true })
  const user = createUserMessage({
    content: [{ type: 'text', text: 'Read-only capability check: use hosted X search to find one public post from @NASA about Artemis. Return one post URL and a short factual summary. Do not publish or modify anything.' }],
    source: { kind: 'user' },
  })
  const first = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({
    provider: 'grok-session', model: 'grok-4.6', messages: [user],
    tools: [], hostedTools: ['x_search'], maxTokens: 1600, signal: AbortSignal.timeout(180_000),
  })) first.push(chunk)
  expect(['stop', 'tool-calls']).toContain(first.finish?.kind)
  const assistant = first.message({
    kind: 'model', provider: 'grok-session', model: 'grok-4.6', replayState: first.replayState,
  })
  const hosted = assistant.content.filter(block => block.type === 'server-tool-call')
  expect(hosted.length).toBeGreaterThan(0)
  expect(hosted.every(block => block.kind === 'x_search')).toBe(true)
  expect(assistant.content.some(block => block.type === 'tool-call')).toBe(false)
  expect(assistant.content.some(block => block.type === 'text' && block.text.trim().length > 0)).toBe(true)
  expect(first.replayState).toBeDefined()

  const second = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({
    provider: 'grok-session', model: 'grok-4.6',
    messages: [user, assistant, createUserMessage({
      content: [{ type: 'text', text: 'Without another search, summarize the post you just found in one sentence and retain its URL.' }],
      source: { kind: 'user' },
    })],
    tools: [], hostedTools: [], maxTokens: 500, signal: AbortSignal.timeout(180_000),
  })) second.push(chunk)
  expect(second.finish?.kind).toBe('stop')
  const followup = second.message({ kind: 'model', provider: 'grok-session', model: 'grok-4.6' })
  expect(followup.content.some(block => block.type === 'tool-call' || block.type === 'server-tool-call')).toBe(false)
  expect(followup.content.some(block => block.type === 'text' && block.text.trim().length > 0)).toBe(true)
  console.log(JSON.stringify({
    hostedOperations: hosted.map(block => block.name),
    firstFinish: first.finish?.kind,
    followupFinish: second.finish?.kind,
  }))
})
