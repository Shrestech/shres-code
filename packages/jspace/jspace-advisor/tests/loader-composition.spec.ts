/**
 * Real-composition guard: a test-only cordis.yml boots the advisor through the
 * Loader. A hand-mounted `ctx.plugin` cannot catch a broken export shape.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import type { Agent } from '@shres-code/shres-code-agent'
import { CallId } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import SubagentRuntime from '@shres-code/shres-code-subagent'
import JspaceService from '@shres-code/shres-code-jspace'
import * as ToolJspace from '@shres-code/shres-code-tool-jspace'
import * as Advisor from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A stub provider that returns a scripted one-shot run and supports continuable. */
function spawnStub(advice: string) {
  return {
    name: 'spawn-stub',
    inject: ['subagents'],
    apply(ctx: Context): void {
      ctx.subagents.registerProvider({
        name: 'spawn',
        capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
        inheritsParentContext: false,
        start: async () => ({
          id: SessionId('child-1'),
          localAgent: undefined,
          result: Promise.resolve({
            stopReason: 'completed' as const,
            output: [{ type: 'text', text: advice }],
            structured: { advice },
          }),
          dispose: async () => { /* no-op */ },
        }),
        prepareContinuable: async () => ({}),
      })
    },
  }
}

async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'shres-jspace-advisor-composition-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@shres-code/shres-code-session'",
    "- name: '@shres-code/shres-code-system-prompt'",
    "- name: '@shres-code/shres-code-tools'",
    "- name: '@shres-code/shres-code-subagent'",
    "- name: 'test-spawn-stub'",
    "- name: '@shres-code/shres-code-jspace'",
    '  config:',
    '    enabled: true',
    "- name: '@shres-code/shres-code-tool-jspace'",
    "- name: '@shres-code/shres-code-jspace-advisor'",
    '  config:',
    '    enabled: true',
    '    provider: spawn',
    '    model: reviewer',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@shres-code/shres-code-session', SessionStore],
    ['@shres-code/shres-code-system-prompt', SystemPrompt],
    ['@shres-code/shres-code-tools', ToolRuntime],
    ['@shres-code/shres-code-subagent', SubagentRuntime],
    ['test-spawn-stub', spawnStub('you drifted')],
    ['@shres-code/shres-code-jspace', JspaceService],
    ['@shres-code/shres-code-tool-jspace', ToolJspace],
    ['@shres-code/shres-code-jspace-advisor', Advisor],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return ctx
}

describe('jspace-advisor real composition', () => {
  it('registers jspace_consult and returns the reviewer advice', async () => {
    const ctx = await loadComposition()
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('jspace_consult')

    const session = ctx.sessions.create(SessionId('ws-advisor-loader'))
    const agent = { id: session.id, session } as unknown as Agent
    await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('open'),
      name: 'jspace_open',
      arguments: { goal: 'Ship W3', next: 'Write tests' },
      agent,
    })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('consult'),
      name: 'jspace_consult',
      arguments: { question: 'am I drifting?' },
      agent,
    })
    expect(result.isError).toBe(false)
    const text = result.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(text).toContain('you drifted')
  }, 30_000)
})
