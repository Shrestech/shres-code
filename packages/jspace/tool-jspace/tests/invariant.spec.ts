import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { CallId } from '@shres-code/shres-code-llm'
import * as ToolJspaceInvariant from '@shres-code/shres-code-tool-jspace/invariant'
import InvariantRegistry, { InvariantError } from '@shres-code/shres-code-invariants'
import { CharterEntryId } from '@shres-code/shres-code-jspace'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ToolJspaceInvariant)
  return ctx
}

describe('tool-jspace charter-run invariant', () => {
  it('rejects a charter-run whose parentCallId is not a jspace tool/call', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('ws-charter-run'))
    expect(() => {
      session.append('jspace/charter-run', {
        entryId: CharterEntryId('e1'),
        callId: CallId('call_open:charter:e1'),
        parentCallId: CallId('call_open'),
        phase: 'probe',
        command: 'grep AUDIT-TAG src/m01-sku.js',
        passed: false,
        outputPreview: '',
      }, { ignorable: true })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@shres-code/shres-code-tool-jspace',
    }))
  })

  it('accepts a charter-run whose parent is a jspace_open tool/call', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('ws-charter-run-ok'))
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('call_open'),
      name: 'jspace_open',
      arguments: '{}',
    })
    expect(() => {
      session.append('jspace/charter-run', {
        entryId: CharterEntryId('e1'),
        callId: CallId('call_open:charter:e1'),
        parentCallId: CallId('call_open'),
        phase: 'probe',
        command: 'grep AUDIT-TAG src/m01-sku.js',
        passed: false,
        outputPreview: '',
      }, { ignorable: true })
    }).not.toThrow()
  })
})
