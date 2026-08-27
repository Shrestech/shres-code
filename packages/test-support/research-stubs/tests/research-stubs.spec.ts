import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import { CallId } from '@shres-code/shres-code-llm'
import * as Stubs from '../src/index.ts'

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Stubs)
  return ctx
}

describe('research-stubs', () => {
  it('registers aegis and ward and echoes their fixed digests', async () => {
    const ctx = await harness()
    const aegis = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('a1'),
      name: 'aegis',
      arguments: {},
    })
    expect(aegis.isError).toBe(false)
    expect((aegis.content[0] as { text?: string }).text).toContain('STUB AEGIS')
    const ward = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('w1'),
      name: 'ward',
      arguments: {},
    })
    expect(ward.isError).toBe(false)
    expect((ward.content[0] as { text?: string }).text).toContain('STUB WARD')
  })

  it('presents calls as a pure generic card', () => {
    const view = Stubs.presentStubCall({})
    expect(view).toEqual({ card: 'generic', title: 'research-stubs seat', kind: 'other', rawInput: {} })
    expect(Stubs.presentStubCall({})).toEqual(view)
  })
})
